/**
 * Trends do momento a partir de fontes PÚBLICAS e gratuitas (sem login):
 * - Google Trends Brasil: termos mais buscados agora + volume aproximado;
 * - Google Notícias Brasil por seção: manchetes e quantos veículos cobrem;
 * - Reels virais: links de Reels mais votados no Reddit (Brasil e mundo);
 * - ranking de hashtags montado a partir disso tudo.
 * O Instagram não libera dados públicos de tendências; cada número mostra de
 * onde veio. Roda no back-end (servidor do PC ou camada nativa do app).
 */
import { decodeEntities, normTitle, type Http } from './search';

export interface TrendTerm {
  term: string;
  /** buscas aproximadas (Google Trends) */
  traffic: number;
  news: { title: string; url: string; source: string }[];
  picture: string | null;
}

export interface HotHeadline {
  title: string;
  url: string;
  source: string;
  date: string | null;
  /** quantos veículos cobrem a mesma história */
  coverage: number;
  section: string;
}

export interface ViralReel {
  title: string;
  url: string;
  /** posição no ranking do dia/semana (1 = mais votado) */
  rank: number;
  region: 'Brasil' | 'Mundo';
  community: string;
  date: string | null;
}

export interface HashtagRank {
  tag: string;
  score: number;
  mentions: number;
}

export interface TrendsResult {
  capturedAt: string;
  searches: TrendTerm[];
  headlines: HotHeadline[];
  reels: ViralReel[];
  hashtags: HashtagRank[];
  /** fontes que falharam nesta captura (o resto continua valendo) */
  failed: string[];
}

const items = (xml: string) => xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? [];
const entries = (xml: string) => xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) ?? [];
function tag(s: string, name: string): string {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(s);
  return m ? decodeEntities(m[1]!).trim() : '';
}
const iso = (s: string) => {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

export function parseGoogleTrends(xml: string): TrendTerm[] {
  return items(xml)
    .map((it) => {
      const traffic = Number(tag(it, 'ht:approx_traffic').replace(/[^\d]/g, '')) || 0;
      const news = (it.match(/<ht:news_item>[\s\S]*?<\/ht:news_item>/gi) ?? []).map((n) => ({ title: tag(n, 'ht:news_item_title'), url: tag(n, 'ht:news_item_url'), source: tag(n, 'ht:news_item_source') }));
      return { term: tag(it, 'title'), traffic, news, picture: tag(it, 'ht:picture') || null };
    })
    .filter((t) => t.term.length > 1);
}

export function parseGoogleNewsSection(xml: string, section: string): HotHeadline[] {
  return items(xml).map((it) => {
    const source = tag(it, 'source');
    let title = tag(it, 'title');
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));
    // a descrição das "principais" lista a cobertura relacionada (um <li> por veículo)
    const desc = tag(it, 'description');
    const coverage = Math.max(1, (desc.match(/<li>/gi) ?? []).length);
    return { title, url: tag(it, 'link'), source: source || 'Google Notícias', date: iso(tag(it, 'pubDate')), coverage, section };
  });
}

export function parseRedditReels(xml: string, region: 'Brasil' | 'Mundo'): ViralReel[] {
  const out: ViralReel[] = [];
  for (const e of entries(xml)) {
    const content = tag(e, 'content');
    const m = /https?:\/\/(?:www\.)?instagram\.com\/(?:reel|reels|p)\/[A-Za-z0-9_-]+/i.exec(content);
    if (!m) continue;
    const cat = /<category[^>]*term="([^"]+)"/i.exec(e)?.[1] ?? '';
    if (/nsfw|porn|onlyfans|gonewild/i.test(cat + tag(e, 'title'))) continue;
    out.push({ title: tag(e, 'title'), url: m[0].replace(/^http:/, 'https:'), rank: 0, region, community: cat ? `r/${cat}` : 'Reddit', date: iso(tag(e, 'updated') || tag(e, 'published')) });
  }
  return out;
}

const STOP = new Set(
  'a o os as de da do das dos e em no na nos nas um uma uns umas com por para pra que se ao à às pelo pela pelos pelas sobre após apos entre sem até ate como mais menos já ja não nao foi são sao ser ter tem é diz dizem após contra vs x the of and to in on for is after with'.split(' '),
);

/** "corinthians x caracas (w)" → #CorinthiansXCaracas */
export function toHashtag(phrase: string): string {
  const words = phrase
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w && (w.length > 1 || /\d/.test(w)));
  if (!words.length) return '';
  return '#' + words.map((w) => w[0]!.toLocaleUpperCase('pt-BR') + w.slice(1)).join('').slice(0, 40);
}

/** Ranking de hashtags: termos do Google Trends (peso = buscas) + nomes próprios das manchetes (peso = cobertura). */
export function rankHashtags(searches: TrendTerm[], headlines: HotHeadline[], max = 25): HashtagRank[] {
  const acc = new Map<string, HashtagRank>();
  const add = (phrase: string, score: number) => {
    const t = toHashtag(phrase);
    if (t.length < 3) return;
    const k = t.toLowerCase();
    const cur = acc.get(k) ?? { tag: t, score: 0, mentions: 0 };
    cur.score += score;
    cur.mentions++;
    acc.set(k, cur);
  };
  const maxTraffic = Math.max(1, ...searches.map((s) => s.traffic));
  for (const s of searches) add(s.term, 40 + 60 * (s.traffic / maxTraffic));
  for (const h of headlines) {
    // sequências de palavras com inicial maiúscula (nomes de pessoas, lugares, times...)
    const words = h.title.split(/\s+/);
    for (let i = 0; i < words.length; i++) {
      const w = words[i]!.replace(/[^\p{L}\p{N}-]/gu, '');
      if (!/^\p{Lu}/u.test(w) || STOP.has(w.toLowerCase()) || (i === 0 && words.length > 1 && !/^\p{Lu}/u.test(words[1]!))) continue;
      let phrase = w;
      while (i + 1 < words.length) {
        const nx = words[i + 1]!.replace(/[^\p{L}\p{N}-]/gu, '');
        if (/^\p{Lu}/u.test(nx) && !STOP.has(nx.toLowerCase())) {
          phrase += ' ' + nx;
          i++;
        } else break;
      }
      if (phrase.length >= 4) add(phrase, 8 * h.coverage);
    }
  }
  return [...acc.values()].sort((a, b) => b.score - a.score).slice(0, max);
}

const NEWS = (q: string) => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=pt-BR&gl=BR&ceid=BR:pt-419`;
const TOPIC = (t: string) => `https://news.google.com/rss/headlines/section/topic/${t}?hl=pt-BR&gl=BR&ceid=BR:pt-419`;
const REDDIT = 'https://www.reddit.com';
/** última lista boa de Reels (o Reddit recusa pedidos repetidos sem login) */
let reelsCache: { at: number; reels: ViralReel[] } | null = null;

/** Captura tudo (cada fonte com reserva: se uma falhar, as outras continuam). */
export async function getTrends(http: Http, limits = { searches: 20, headlines: 40, reels: 15 }): Promise<TrendsResult> {
  const failed: string[] = [];
  const get = async (label: string, url: string) => {
    try {
      const r = await http.getText(url);
      if (r.status >= 400) throw new Error(String(r.status));
      return r.text;
    } catch {
      failed.push(label);
      return '';
    }
  };
  const sections: [string, string][] = [
    ['Principais', 'https://news.google.com/rss?hl=pt-BR&gl=BR&ceid=BR:pt-419'],
    ['Brasil', TOPIC('NATION')],
    ['Política', NEWS('política OR governo OR Congresso OR STF when:1d')],
    ['Polícia e cotidiano', NEWS('polícia OR crime OR preso OR acidente when:1d')],
    ['Urgente e exclusivo', NEWS('urgente OR exclusivo when:1d')],
    ['Paraíba', NEWS('Paraíba OR "João Pessoa" OR "Campina Grande" when:1d')],
    ['Esporte', TOPIC('SPORTS')],
    ['Entretenimento', TOPIC('ENTERTAINMENT')],
  ];
  const [trendsXml, ...sectionXml] = await Promise.all([
    get('Google Trends', 'https://trends.google.com/trending/rss?geo=BR'),
    ...sections.map(([label, url]) => get(`Notícias · ${label}`, url)),
  ]);
  // Reels (Reddit limita pedidos sem login): poucos pedidos, um depois do outro,
  // guardados por 10 min; se recusar, usa a última captura boa
  let reelsBr = '';
  let reelsWorld = '';
  const fresh = reelsCache && Date.now() - reelsCache.at < 600_000;
  if (!fresh) {
    reelsBr = await get('Reels Brasil', `${REDDIT}/search.rss?q=url%3Ainstagram.com%2Freel%20(brasil%20OR%20lula%20OR%20bolsonaro%20OR%20pol%C3%ADcia%20OR%20futebol%20OR%20paraiba)&sort=top&t=week&limit=40`);
    await new Promise((r) => setTimeout(r, 1200));
    reelsWorld = await get('Reels mundo', `${REDDIT}/search.rss?q=url%3Ainstagram.com%2Freel&sort=top&t=day&limit=40`);
  }
  const searches = parseGoogleTrends(trendsXml)
    .sort((a, b) => b.traffic - a.traffic)
    .slice(0, limits.searches);
  // manchetes: junta as seções, sem repetir a mesma história
  const seen = new Set<string>();
  const headlines: HotHeadline[] = [];
  sectionXml.forEach((xml, i) => {
    for (const h of parseGoogleNewsSection(xml, sections[i]![0]).slice(0, 15)) {
      const k = normTitle(h.title).slice(0, 60);
      if (!h.title || seen.has(k)) continue;
      seen.add(k);
      headlines.push(h);
    }
  });
  headlines.sort((a, b) => b.coverage - a.coverage || (b.date ?? '').localeCompare(a.date ?? ''));
  // Reels: Brasil primeiro, depois mundo; sem repetir link; limite
  const reels: ViralReel[] = [];
  const seenReel = new Set<string>();
  const push = (list: ViralReel[]) => {
    for (const r of list) {
      const k = r.url.toLowerCase().replace(/\/$/, '');
      if (seenReel.has(k)) continue;
      seenReel.add(k);
      reels.push(r);
    }
  };
  push(parseRedditReels(reelsBr, 'Brasil'));
  const br = reels.length;
  push(parseRedditReels(reelsWorld, 'Mundo'));
  let limited = [...reels.slice(0, Math.min(br, limits.reels)), ...reels.slice(br).slice(0, limits.reels)];
  let rb = 0;
  let rw = 0;
  for (const r of limited) r.rank = r.region === 'Brasil' ? ++rb : ++rw;
  if (limited.length) reelsCache = { at: Date.now(), reels: limited };
  else if (reelsCache) {
    limited = reelsCache.reels;
    if (!fresh) failed.push(`Reels (mostrando a captura de ${new Date(reelsCache.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })})`);
  }
  const hl = headlines.slice(0, limits.headlines);
  return { capturedAt: new Date().toISOString(), searches, headlines: hl, reels: limited, hashtags: rankHashtags(searches, hl), failed: [...new Set(failed)] };
}

/** Trends guardadas por alguns minutos (servidor e app usam a mesma). */
let trendsCache: { at: number; data: TrendsResult } | null = null;
export async function cachedTrends(http: Http, maxAgeMs = 180_000, refresh = false): Promise<TrendsResult> {
  if (!refresh && trendsCache && Date.now() - trendsCache.at < maxAgeMs) return trendsCache.data;
  const data = await getTrends(http);
  trendsCache = { at: Date.now(), data };
  return data;
}

export interface HashtagLookup {
  tag: string;
  /** notícias encontradas nas últimas 48 h */
  recent: number;
  /** veículos diferentes falando disso */
  outlets: number;
  related: HashtagRank[];
  headlines: HotHeadline[];
}

/** O que está sendo falado sobre uma hashtag (volume recente + hashtags relacionadas). */
export async function lookupHashtag(input: string, http: Http): Promise<HashtagLookup> {
  const term = input
    .replace(/^#/, '')
    .replace(/([a-zà-ú])([A-ZÀ-Ú])/g, '$1 $2')
    .trim();
  const tagName = toHashtag(term) || `#${term}`;
  let xml = '';
  try {
    xml = (await http.getText(NEWS(`${term} when:2d`))).text;
  } catch {
    xml = '';
  }
  const headlines = parseGoogleNewsSection(xml, 'Busca').slice(0, 30);
  const outlets = new Set(headlines.map((h) => h.source)).size;
  const related = rankHashtags([], headlines, 15).filter((h) => h.tag.toLowerCase() !== tagName.toLowerCase());
  return { tag: tagName, recent: headlines.length, outlets, related, headlines: headlines.slice(0, 12) };
}
