/**
 * Captura e ranking de pautas para o site (Primeiras Notícias).
 *
 * - Fontes: notícias de João Pessoa, Cabedelo, Bayeux e Campina Grande
 *   (prioridade) + nacionais em alta; ou uma busca livre (como no Google).
 * - Cada matéria é lida por completo, NA ORDEM: parágrafo, imagem, parágrafo,
 *   vídeo... (para a matéria do site manter as imagens nos lugares certos).
 * - Na captura já confere se cada imagem pode ser baixada — imagem baixável
 *   vale pontos no ranking; quanto mais conteúdo, mais relevante.
 * - Ranking com critérios explícitos (motivos aparecem para o jornalista),
 *   no máximo 20 pautas.
 * Roda no back-end (servidor do PC ou camada nativa do app).
 */
import { decodeEntities, normTitle, searchRecent, type Article, type Http } from './search';
import { parseGoogleNewsSection } from './trends';

export const CITIES = ['João Pessoa', 'Bayeux', 'Campina Grande', 'Guarabira', 'Monteiro', 'Pilõezinhos'] as const;

/** cidades que NUNCA entram (pedido da redação): notícia que cita qualquer uma fica de fora */
export const BLOCKED_CITIES = ['Cabedelo', 'Santa Rita'] as const;
const foldCity = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
export const mentionsBlockedCity = (text: string) => {
  const t = foldCity(text);
  return BLOCKED_CITIES.some((c) => t.includes(foldCity(c)));
};

export interface Block {
  type: 'p' | 'img' | 'video';
  text?: string;
  src?: string;
  caption?: string;
  /** imagem: conferido se dá para baixar */
  ok?: boolean;
  /** vídeo: de onde é (YouTube, Instagram, arquivo) */
  kind?: 'youtube' | 'instagram' | 'arquivo' | 'outro';
}

export interface Pauta {
  id: string;
  title: string;
  url: string;
  source: string;
  date: string | null;
  snippet: string;
  /** cidade prioritária citada (ou null) */
  city: string | null;
  blocks: Block[];
  paragraphs: number;
  images: number;
  imagesOk: number;
  videos: number;
  /** quantos veículos cobrem a mesma história */
  coverage: number;
  /** termos em alta que aparecem na matéria */
  trendHits: string[];
  score: number;
  reasons: string[];
  /** conseguiu ler a matéria inteira */
  readable: boolean;
  /** outros veículos que deram a mesma notícia */
  others?: string[];
}

/** Transporte com conferência de imagem (HEAD/GET leve). */
export interface PautaHttp extends Http {
  probe(url: string, referer: string): Promise<{ status: number; contentType: string; length: number }>;
  /** POST de formulário (para descobrir o link real das notícias do Google) */
  postForm(url: string, body: string): Promise<{ status: number; text: string }>;
}

/**
 * Link do Google Notícias → endereço real da matéria no veículo (o Google não
 * entrega o link direto; sem isso não dá para ler o texto nem as imagens).
 */
export async function resolveGoogleLink(url: string, http: PautaHttp): Promise<string | null> {
  const id = /news\.google\.com\/(?:rss\/)?articles\/([^?/]+)/.exec(url)?.[1];
  if (!id) return null;
  try {
    const page = (await http.getText(`https://news.google.com/articles/${id}`)).text;
    const sig = /data-n-a-sg="([^"]+)"/.exec(page)?.[1];
    const ts = /data-n-a-ts="([^"]+)"/.exec(page)?.[1];
    if (!sig || !ts) return null;
    const inner = `["garturlreq",[["X","X",["X","X"],null,null,1,1,"US:en",null,1,null,null,null,null,null,0,1],"X","X",1,[1,1,1],1,1,null,0,0,null,0],"${id}",${ts},"${sig}"]`;
    const r = await http.postForm('https://news.google.com/_/DotsSplashUi/data/batchexecute', 'f.req=' + encodeURIComponent(JSON.stringify([[['Fbv4je', inner]]])));
    const at = r.text.indexOf('garturlres');
    const m = at >= 0 ? /https?:\/\/[^"\\]+/.exec(r.text.slice(at)) : null;
    return m ? m[0] : null;
  } catch {
    return null;
  }
}

const STOP = new Set('para pela pelo pelos pelas sobre apos entre como mais menos ainda depois antes durante contra dizem diz disse esta este essa esse isso aquele aquela tambem sera foram sao ter tem teve vai vao pode'.split(' '));
const tokens = (s: string) => new Set(fold(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !STOP.has(w)));

/** Mesma história? (títulos com boa parte das palavras importantes em comum) */
export function sameStory(a: string, b: string): boolean {
  const A = tokens(a);
  const B = tokens(b);
  let common = 0;
  for (const w of A) if (B.has(w)) common++;
  return common >= 3 && common / Math.max(1, Math.min(A.size, B.size)) >= 0.5;
}

const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');

const strip = (s: string) =>
  decodeEntities(s.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();

const JUNK_P = /cookie|newsletter|assine|assinante|inscreva|leia (tamb[eé]m|mais)|siga o|clique aqui|todos os direitos|©|whatsapp|publicidade|baixe o app|receba as not[ií]cias|compartilhe/i;
const JUNK_IMG = /logo|icon|avatar|sprite|placeholder|blank|pixel|tracking|badge|banner|ads?[/_-]|emoji|gravatar|1x1|spacer|\.svg(\?|$)|data:image/i;

function absUrl(src: string, base: string): string | null {
  try {
    return new URL(decodeEntities(src.trim()), base).toString();
  } catch {
    return null;
  }
}

/** Maior imagem do srcset/data-src/src. */
function imgSrc(tag: string, base: string): string | null {
  const attr = (n: string) => new RegExp(`\\s${n}=["']([^"']+)["']`, 'i').exec(tag)?.[1];
  const srcset = attr('srcset') ?? attr('data-srcset');
  if (srcset) {
    const best = srcset
      .split(',')
      .map((s) => s.trim().split(/\s+/))
      .map(([u, w]) => ({ u: u!, w: Number(String(w ?? '').replace(/[^\d]/g, '')) || 0 }))
      .sort((a, b) => b.w - a.w)[0];
    if (best?.u) return absUrl(best.u, base);
  }
  const src = attr('data-src') ?? attr('data-lazy-src') ?? attr('data-original') ?? attr('src');
  return src ? absUrl(src, base) : null;
}

/**
 * Lê a matéria e devolve os blocos NA ORDEM (parágrafos, imagens, vídeos).
 * Exportado para testes.
 */
/** imagem com cara de logo/marca/imagem padrão do site (não é foto da notícia) */
export const LOGO_LIKE = /logo|marca[-_]|brand|default|padrao|placeholder|sem[-_]?imagem|no[-_]?image|avatar|favicon|icon[-_.]|share[-_]?image|og[-_]?image|thumb[-_]?padrao|watermark/i;

export function extractBlocks(html: string, base: string): { blocks: Block[]; ogImage: string | null; title: string; date: string | null } {
  const meta = (p: string) => new RegExp(`<meta[^>]+(?:property|name)=["']${p}["'][^>]*content=["']([^"']*)["']`, 'i').exec(html)?.[1] ?? new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${p}["']`, 'i').exec(html)?.[1] ?? '';
  const scope = /<article[\s\S]*?<\/article>/i.exec(html)?.[0] ?? /<main[\s\S]*?<\/main>/i.exec(html)?.[0] ?? html;
  const blocks: Block[] = [];
  const seenImg = new Set<string>();
  // percorre parágrafos, imagens (com legenda), iframes e vídeos na ordem em que aparecem
  const re = /<p[\s>][\s\S]*?<\/p>|<figure[\s\S]*?<\/figure>|<img\b[^>]*>|<iframe\b[^>]*>|<video\b[\s\S]*?<\/video>|<blockquote[^>]+instagram-media[\s\S]*?<\/blockquote>/gi;
  for (const m of scope.matchAll(re)) {
    const tag = m[0];
    const low = tag.slice(0, 12).toLowerCase();
    if (low.startsWith('<p')) {
      const t = strip(tag);
      if (t.length >= 40 && !JUNK_P.test(t)) blocks.push({ type: 'p', text: t });
      // imagem dentro do parágrafo
      const im = /<img\b[^>]*>/i.exec(tag);
      if (im) {
        const s = imgSrc(im[0], base);
        if (s && !JUNK_IMG.test(s) && !seenImg.has(s)) {
          seenImg.add(s);
          blocks.push({ type: 'img', src: s });
        }
      }
    } else if (low.startsWith('<figure')) {
      const im = /<img\b[^>]*>/i.exec(tag);
      const s = im ? imgSrc(im[0], base) : null;
      if (s && !JUNK_IMG.test(s) && !seenImg.has(s)) {
        seenImg.add(s);
        const cap = /<figcaption[\s\S]*?<\/figcaption>/i.exec(tag);
        blocks.push({ type: 'img', src: s, caption: cap ? strip(cap[0]) : undefined });
      }
      const ifr = /<iframe\b[^>]*src=["']([^"']+)["']/i.exec(tag);
      if (ifr) blocks.push(videoBlock(ifr[1]!, base));
    } else if (low.startsWith('<img')) {
      const s = imgSrc(tag, base);
      const w = Number(/\swidth=["']?(\d+)/i.exec(tag)?.[1] ?? 0);
      if (s && !JUNK_IMG.test(s) && !seenImg.has(s) && (w === 0 || w >= 200)) {
        seenImg.add(s);
        const alt = /\salt=["']([^"']*)["']/i.exec(tag)?.[1];
        blocks.push({ type: 'img', src: s, caption: alt ? decodeEntities(alt) : undefined });
      }
    } else if (low.startsWith('<iframe')) {
      const src = /src=["']([^"']+)["']/i.exec(tag)?.[1];
      if (src && /youtube|youtu\.be|instagram|facebook\.com\/plugins\/video|vimeo|dailymotion/i.test(src)) blocks.push(videoBlock(src, base));
    } else if (low.startsWith('<video')) {
      const src = /\ssrc=["']([^"']+)["']/i.exec(tag)?.[1];
      if (src) blocks.push({ type: 'video', src: absUrl(src, base) ?? src, kind: 'arquivo' });
    } else {
      const link = /href=["'](https:\/\/www\.instagram\.com\/[^"']+)["']/i.exec(tag)?.[1];
      if (link) blocks.push({ type: 'video', src: link, kind: 'instagram' });
    }
  }
  const og = meta('og:image');
  const ogImage = og ? absUrl(og, base) : null;
  return { blocks, ogImage, title: decodeEntities(meta('og:title')), date: meta('article:published_time') || null };
}

function videoBlock(src: string, base: string): Block {
  const u = absUrl(src, base) ?? src;
  const kind = /youtube|youtu\.be/i.test(u) ? 'youtube' : /instagram/i.test(u) ? 'instagram' : 'outro';
  return { type: 'video', src: u, kind };
}

/** Pontuação com motivos (exportado para testes). */
export function scorePauta(p: Omit<Pauta, 'score' | 'reasons'>, now = Date.now()): { score: number; reasons: string[] } {
  let s = 0;
  const why: string[] = [];
  const add = (n: number, r: string) => {
    if (!n) return;
    s += n;
    why.push(`${n > 0 ? '+' : ''}${n} ${r}`);
  };
  const h = p.date ? (now - new Date(p.date).getTime()) / 36e5 : null;
  if (h != null) add(h < 6 ? 30 : h < 24 ? 20 : h < 72 ? 10 : 0, h < 6 ? 'publicada há menos de 6 h' : h < 24 ? 'de hoje' : 'dos últimos 3 dias');
  if (p.city) add(25, `cidade prioritária (${p.city})`);
  add(Math.min(20, p.paragraphs * 2), `${p.paragraphs} parágrafos de conteúdo`);
  if (p.imagesOk) add(Math.min(30, 12 + (p.imagesOk - 1) * 6), `${p.imagesOk} imagem(ns) que dá para baixar`);
  const blocked = p.images - p.imagesOk;
  if (blocked > 0) add(Math.min(4, blocked * 2), `${blocked} imagem(ns) que o site não deixou baixar`);
  if (p.videos) add(Math.min(12, p.videos * 6), `${p.videos} vídeo(s)`);
  if (p.coverage > 1) add(Math.min(15, (p.coverage - 1) * 5), `${p.coverage} veículos cobrindo`);
  if (p.trendHits.length) add(Math.min(24, p.trendHits.length * 8), `em alta agora: ${p.trendHits.slice(0, 3).join(', ')}`);
  if (!p.readable || p.paragraphs < 2) add(-30, 'não deu para ler o texto completo');
  return { score: s, reasons: why };
}

/** Executa tarefas com no máximo `n` ao mesmo tempo. */
async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]!);
      }
    }),
  );
  return out;
}

export interface CaptureOptions {
  /** busca livre (como no Google); vazio = cidades prioritárias + nacionais em alta */
  query?: string;
  queries?: string[];
  window?: '1d' | '3d' | '7d' | '30d' | 'any';
  cities?: string[];
  /** termos/hashtags em alta (para pontuar) */
  trending?: string[];
  max?: number;
  /** idade máxima da notícia em horas (padrão 12): mais velha que isso não entra */
  maxAgeHours?: number;
}

/** regra do Postador: só notícia de até 12 h */
export const MAX_AGE_HOURS = 12;

/** texto em português? (corta homônimos de fora, ex.: "Bayeux" da França em inglês) */
export function isPortuguese(text: string): boolean {
  const s = ` ${text.toLowerCase()} `;
  const pt = (s.match(/ (de|do|da|dos|das|em|no|na|nos|nas|é|e|com|para|por|que|um|uma|após|sobre|são) /g) ?? []).length + (/[ãõçê]|ção|ções/.test(s) ? 2 : 0);
  const en = (s.match(/ (the|of|and|for|with|to|in|on|is|are|from|after|by) /g) ?? []).length;
  return pt >= 1 && pt >= en;
}

/**
 * Matéria antiga republicada? (o texto só cita anos passados e nunca o ano
 * atual, ex.: reportagem de 2020 que voltou ao feed com data nova)
 */
export function looksStale(text: string, now = new Date()): boolean {
  const year = now.getFullYear();
  const years = [...text.matchAll(/\b(19[5-9]\d|20\d\d)\b/g)].map((m) => Number(m[1])).filter((y) => y <= year);
  return years.length > 0 && !years.includes(year) && Math.max(...years) < year;
}

const ageHours = (iso: string | null | undefined, now: number) => (iso ? (now - new Date(iso).getTime()) / 3600_000 : NaN);

/** Captura, lê e ranqueia as pautas (no máximo `max`, padrão 20). */
export async function capturePautas(http: PautaHttp, opts: CaptureOptions = {}): Promise<Pauta[]> {
  const max = Math.min(20, opts.max ?? 20);
  const cities = opts.cities?.length ? opts.cities : [...CITIES];
  let found: (Article & { coverage?: number; fromCity?: string })[] = [];
  if (opts.query || opts.queries?.length) {
    const r = await searchRecent(opts.queries?.length ? opts.queries : [opts.query!], opts.window ?? '3d', http, 40);
    found = r.articles;
  } else {
    // cidades prioritárias (1 busca por cidade) + nacionais em alta (cobertura dos veículos)
    const perCity = await Promise.all(
      cities.map(async (c) => {
        const r = await searchRecent([`"${c}"`], opts.window ?? '1d', http, 12, { names: [c] }).catch(() => ({ articles: [] as Article[] }));
        return r.articles.map((a) => ({ ...a, fromCity: c }));
      }),
    );
    let national: (Article & { coverage?: number })[] = [];
    try {
      const xml = (await http.getText('https://news.google.com/rss?hl=pt-BR&gl=BR&ceid=BR:pt-419')).text;
      national = parseGoogleNewsSection(xml, 'Nacional')
        .slice(0, 12)
        .map((h) => ({ title: h.title, url: h.url, source: h.source, date: h.date, snippet: '', via: 'google' as const, readable: false, coverage: h.coverage }));
    } catch {
      /* segue só com as cidades */
    }
    found = [...perCity.flat(), ...national];
  }
  // a mesma história em vários veículos vira UMA pauta (com a contagem de veículos);
  // fica a versão com link direto, se houver
  type Cand = Article & { coverage: number; fromCity?: string; others: string[] };
  const groups: Cand[] = [];
  for (const a of found) {
    const g = groups.find((x) => normTitle(x.title) === normTitle(a.title) || sameStory(x.title, a.title));
    if (!g) {
      groups.push({ ...a, coverage: a.coverage ?? 1, others: [] } as Cand);
      continue;
    }
    g.coverage += a.coverage ?? 1;
    if (!g.others.includes(a.source) && a.source !== g.source) g.others.push(a.source);
    if (!g.readable && a.readable) Object.assign(g, { title: a.title, url: a.url, source: a.source, readable: true, snippet: a.snippet || g.snippet });
    g.fromCity ??= (a as Cand).fromCity;
    if (!g.date || (a.date && a.date > g.date)) g.date = a.date ?? g.date;
  }
  // regra: só notícia de até 12 h (sem data aqui ainda pode ganhar a data lendo a matéria)
  const maxAge = opts.maxAgeHours ?? MAX_AGE_HOURS;
  const now = Date.now();
  const fresh = groups.filter((g) => {
    const h = ageHours(g.date, now);
    return Number.isNaN(h) || h <= maxAge;
  });
  groups.length = 0;
  groups.push(...fresh);
  const candidates = groups.sort((a, b) => b.coverage - a.coverage || (b.date ?? '').localeCompare(a.date ?? '')).slice(0, 30);
  // links do Google → endereço real (para ler texto, imagens e vídeos)
  await pool(
    candidates.filter((c) => !c.readable && /news\.google\.com/.test(c.url)),
    6,
    async (c) => {
      const real = await resolveGoogleLink(c.url, http);
      if (real) Object.assign(c, { url: real, readable: true });
    },
  );
  const trending = (opts.trending ?? []).map((t) => ({ raw: t, k: fold(t.replace(/^#/, '').replace(/([a-zà-ú])([A-ZÀ-Ú])/g, '$1 $2')) })).filter((t) => t.k.length >= 4);

  const pautas = await pool(candidates, 6, async (a, ): Promise<Pauta> => {
    let blocks: Block[] = [];
    let readable = false;
    let date = a.date;
    let title = a.title;
    if (a.readable) {
      try {
        const r = await http.getText(a.url);
        if (r.status < 400) {
          const ex = extractBlocks(r.text.slice(0, 3_000_000), r.url || a.url);
          blocks = ex.blocks;
          date = date ?? (ex.date ? new Date(ex.date).toISOString() : null);
          title = title || ex.title;
          // foto principal (og:image) no começo, se não estiver no texto
          // (menos se tiver cara de logo do veículo: aí não é foto da notícia)
          if (ex.ogImage && !LOGO_LIKE.test(ex.ogImage) && !blocks.some((b) => b.type === 'img' && b.src === ex.ogImage)) blocks.unshift({ type: 'img', src: ex.ogImage, caption: undefined });
          readable = blocks.filter((b) => b.type === 'p').length >= 2;
        }
      } catch {
        /* sem leitura: fica só a manchete */
      }
    }
    // confere se as imagens dá para baixar (até 6 por matéria)
    const imgs = blocks.filter((b) => b.type === 'img').slice(0, 6);
    await Promise.all(
      imgs.map(async (b) => {
        try {
          const pr = await http.probe(b.src!, a.url);
          const type = pr.contentType.toLowerCase();
          // foto de verdade: imagem baixável, não minúscula; PNG/SVG pequeno costuma ser logo
          const logoish = LOGO_LIKE.test(b.src!) || type.includes('svg') || (type.includes('png') && pr.length > 0 && pr.length < 60_000);
          b.ok = pr.status < 400 && /^image\//i.test(type) && (pr.length === 0 || pr.length > 12_000) && !logoish;
        } catch {
          b.ok = false;
        }
      }),
    );
    const text = fold(`${title} ${a.snippet} ${blocks.map((b) => b.text ?? '').join(' ')}`);
    const city = a.fromCity ?? cities.find((c) => text.includes(fold(c))) ?? null;
    const base = {
      id: normTitle(a.url).slice(-40) + '-' + normTitle(title).slice(0, 20),
      title,
      url: a.url,
      source: a.source,
      date,
      snippet: a.snippet,
      city,
      blocks,
      paragraphs: blocks.filter((b) => b.type === 'p').length,
      images: blocks.filter((b) => b.type === 'img').length,
      imagesOk: blocks.filter((b) => b.type === 'img' && b.ok).length,
      videos: blocks.filter((b) => b.type === 'video').length,
      coverage: a.coverage ?? 1,
      trendHits: trending.filter((t) => text.includes(t.k)).map((t) => t.raw),
      readable,
    };
    return { ...base, others: (a as Cand).others ?? [], ...scorePauta(base) };
  });
  // regra: fica de fora (não ranqueia) notícia velha, sem data conferível ou sem
  // nenhuma foto que dê para baixar (a capa do post do Instagram sai dela)
  const kept = pautas.filter((p) => {
    const h = ageHours(p.date, now);
    // texto inteiro (até ~4 mil letras): a data antiga pode estar no meio da matéria
    const words = p.blocks.filter((b) => b.type === 'p').map((b) => b.text).join(' ').slice(0, 4000);
    return !Number.isNaN(h) && h <= maxAge && h >= -1 && p.imagesOk >= 1 && !mentionsBlockedCity(`${p.title} ${p.snippet} ${words}`) && isPortuguese(`${p.title} ${words}`) && !looksStale(`${p.title} ${words}`, new Date(now));
  });
  pautas.length = 0;
  pautas.push(...kept);
  pautas.sort((a, b) => b.score - a.score);
  // busca livre: só o ranking. Sem busca: principalmente as cidades prioritárias,
  // completando com as nacionais mais bem ranqueadas
  if (opts.query || opts.queries?.length) return pautas.slice(0, max);
  const locais = pautas.filter((p) => p.city).slice(0, Math.min(14, max));
  const nacionais = pautas.filter((p) => !p.city).slice(0, max - locais.length);
  return [...locais, ...nacionais];
}
