/**
 * Busca de notícias públicas (sem chave): Google Notícias e Bing Notícias por
 * RSS, e GDELT como reserva. Roda no BACK-END: no PC dentro do servidor Node;
 * no app Android pela camada nativa (sem as restrições do navegador).
 * O transporte HTTP é injetado (`Http`), o resto é igual nos dois lugares.
 */

export interface Http {
  getText(url: string): Promise<{ status: number; text: string; url: string }>;
}

export interface Article {
  title: string;
  url: string;
  source: string;
  /** ISO 8601, quando disponível */
  date: string | null;
  snippet: string;
  /** de onde veio a notícia (ou "link": colado à mão pelo jornalista) */
  via: 'google' | 'bing' | 'gdelt' | 'link';
  /** dá para abrir e ler o texto completo (link direto do veículo) */
  readable: boolean;
}

export interface ArticleText {
  url: string;
  title: string;
  source: string;
  date: string | null;
  text: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', laquo: '«', raquo: '»', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’' };

export function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n: string) => ENTITIES[n.toLowerCase()] ?? m);
}

const stripTags = (s: string) => decodeEntities(s.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

function tag(item: string, name: string): string {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(item);
  return m ? decodeEntities(m[1]!).trim() : '';
}

function isoDate(s: string): string | null {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export const normTitle = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function items(xml: string): string[] {
  return xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? [];
}

export function parseGoogleRss(xml: string): Article[] {
  return items(xml).map((it) => {
    const source = tag(it, 'source');
    let title = tag(it, 'title');
    // o Google põe " - Veículo" no fim do título
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));
    return {
      title,
      url: tag(it, 'link'),
      source: source || 'Google Notícias',
      date: isoDate(tag(it, 'pubDate')),
      snippet: '',
      via: 'google' as const,
      readable: false, // links do Google não levam direto ao texto
    };
  });
}

export function parseBingRss(xml: string): Article[] {
  return items(xml).map((it) => {
    const raw = tag(it, 'link');
    // o link do Bing traz o endereço real do veículo no parâmetro url=
    const m = /[?&]url=([^&]+)/i.exec(raw);
    const url = m ? decodeURIComponent(m[1]!) : raw;
    let source = tag(it, 'News:Source') || tag(it, 'news:source');
    if (!source) {
      try {
        source = new URL(url).hostname.replace(/^www\./, '');
      } catch {
        source = 'Bing Notícias';
      }
    }
    return { title: tag(it, 'title'), url, source, date: isoDate(tag(it, 'pubDate')), snippet: stripTags(tag(it, 'description')), via: 'bing' as const, readable: !!m };
  });
}

export function parseGdelt(json: string): Article[] {
  try {
    const j = JSON.parse(json) as { articles?: { url: string; title: string; domain: string; seendate: string }[] };
    return (j.articles ?? []).map((a) => {
      const sd = a.seendate?.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z');
      return { title: a.title, url: a.url, source: a.domain, date: sd ? isoDate(sd) : null, snippet: '', via: 'gdelt' as const, readable: true };
    });
  } catch {
    return [];
  }
}

let lastGdelt = 0;

/** Janela de tempo da busca (padrão: notícia atual). */
export type Window = '1d' | '3d' | '7d' | '30d' | 'any';
const WINDOW_HOURS: Record<Window, number> = { '1d': 24, '3d': 72, '7d': 168, '30d': 720, any: Infinity };
/** Bing: interval 7 = 24 h, 8 = semana, 9 = mês (conferido na prática) */
const BING_INTERVAL: Record<Exclude<Window, 'any'>, string> = { '1d': '7', '3d': '8', '7d': '8', '30d': '9' };
const WIDER: Partial<Record<Window, Window>> = { '1d': '3d', '3d': '7d', '7d': '30d' };

export interface NewsSearch {
  articles: Article[];
  /** janela que acabou sendo usada (pode ter sido ampliada) */
  window: Window;
  /** nomes do pedido que nenhuma notícia cita (aviso ao jornalista) */
  missing: string[];
}

const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

/** Notícias que citam os nomes do pedido vêm na frente; se nenhuma cita um nome, avisa. */
function byNames(list: Article[], names: string[]): { list: Article[]; missing: string[] } {
  if (!names.length) return { list, missing: [] };
  const hay = (a: Article) => fold(`${a.title} ${a.snippet} ${a.source}`);
  const missing = names.filter((n) => !list.some((a) => hay(a).includes(fold(n))));
  const wanted = names.filter((n) => !missing.includes(n));
  if (!wanted.length) return { list, missing };
  const hits = list.filter((a) => wanted.every((n) => hay(a).includes(fold(n))));
  const some = list.filter((a) => !hits.includes(a) && wanted.some((n) => hay(a).includes(fold(n))));
  // só as que citam os nomes, se houver o bastante
  const chosen = hits.length >= 3 ? hits : [...hits, ...some];
  return { list: chosen.length ? chosen : list, missing };
}

async function searchOnce(query: string, w: Window, http: Http, year?: number): Promise<Article[]> {
  const when = year ? ` after:${year}-01-01 before:${year + 1}-01-01` : w === 'any' ? '' : ` when:${w}`;
  const g = encodeURIComponent(query + when);
  const b = encodeURIComponent(query);
  const bingFilter = w === 'any' ? 'sortbydate%3d%221%22' : `interval%3d%22${BING_INTERVAL[w]}%22%2bsortbydate%3d%221%22`;
  const safe = async (fn: () => Promise<Article[]>) => {
    try {
      return await fn();
    } catch {
      return [];
    }
  };
  const [google, bing] = await Promise.all([
    safe(async () => parseGoogleRss((await http.getText(`https://news.google.com/rss/search?q=${g}&hl=pt-BR&gl=BR&ceid=BR:pt-419`)).text)),
    safe(async () => parseBingRss((await http.getText(`https://www.bing.com/news/search?q=${b}&format=rss&setlang=pt-br&cc=BR&qft=${bingFilter}`)).text)),
  ]);
  return [...bing, ...google];
}

function dedupe(all: Article[]): Article[] {
  const seen = new Map<string, Article>();
  for (const a of all) {
    if (!a.title || !a.url) continue;
    const k = normTitle(a.title).slice(0, 70);
    const prev = seen.get(k);
    if (!prev) seen.set(k, a);
    else if (!prev.readable && a.readable) seen.set(k, { ...a, date: a.date ?? prev.date });
  }
  return [...seen.values()];
}

/**
 * Busca as notícias das buscas do plano dentro da janela de tempo (amplia se
 * vier pouca coisa), sem repetir, das MAIS NOVAS para as mais antigas.
 */
export async function searchRecent(queries: string[], window: Window, http: Http, max = 20, opts: { year?: number; names?: string[] } = {}): Promise<NewsSearch> {
  let w = opts.year ? 'any' : window;
  for (;;) {
    const lists = await Promise.all(queries.filter(Boolean).map((q) => searchOnce(q, w, http, opts.year)));
    const limit = Date.now() - WINDOW_HOURS[w] * 3600_000;
    let found = dedupe(lists.flat());
    if (w !== 'any') {
      const dated = found.filter((a) => a.date && new Date(a.date).getTime() >= limit);
      // sem data só entra se faltar notícia datada
      found = dated.length >= 6 ? dated : found.filter((a) => !a.date || new Date(a.date).getTime() >= limit);
    }
    if (opts.year) found = found.filter((a) => !a.date || new Date(a.date).getFullYear() === opts.year);
    const named = byNames(found, opts.names ?? []);
    found = named.list.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
    const next = WIDER[w];
    if (found.length >= 6 || !next) return { articles: found.slice(0, max), window: w, missing: named.missing };
    w = next;
  }
}

/** Busca nas fontes públicas, junta, tira repetidas e ordena da mais nova para a mais antiga. */
export async function searchNews(query: string, http: Http, max = 15): Promise<Article[]> {
  const q = encodeURIComponent(query.trim());
  if (!q) return [];
  const safe = async (fn: () => Promise<Article[]>) => {
    try {
      return await fn();
    } catch {
      return [];
    }
  };
  const [google, bing] = await Promise.all([
    safe(async () => parseGoogleRss((await http.getText(`https://news.google.com/rss/search?q=${q}&hl=pt-BR&gl=BR&ceid=BR:pt-419`)).text)),
    safe(async () => parseBingRss((await http.getText(`https://www.bing.com/news/search?q=${q}&format=rss&setlang=pt-br&cc=BR`)).text)),
  ]);
  let all = [...bing, ...google];
  // reserva: GDELT (respeitando o limite de 1 pedido a cada 5 s)
  if (all.length < 3 && Date.now() - lastGdelt > 5500) {
    lastGdelt = Date.now();
    all = all.concat(await safe(async () => parseGdelt((await http.getText(`https://api.gdeltproject.org/api/v2/doc/doc?query=${q}%20sourcelang:portuguese&mode=artlist&format=json&maxrecords=20&sort=datedesc`)).text)));
  }
  const seen = new Map<string, Article>();
  for (const a of all) {
    if (!a.title || !a.url) continue;
    const k = normTitle(a.title).slice(0, 70);
    const prev = seen.get(k);
    // mesma notícia em duas fontes: fica a versão que dá para ler (link direto)
    if (!prev) seen.set(k, a);
    else if (!prev.readable && a.readable) seen.set(k, { ...a, date: a.date ?? prev.date });
  }
  return [...seen.values()].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '')).slice(0, max);
}

const JUNK = /cookie|newsletter|assine|assinante|inscreva|leia (tamb[eé]m|mais)|siga o|clique aqui|todos os direitos|©|whatsapp|publicidade|baixe o app/i;

/**
 * O jornalista colou o link de uma matéria pronta (de qualquer portal) pra
 * usar de inspiração: lê a página uma vez pra montar o "cartão" da notícia
 * (título, fonte, data) — o texto completo é lido depois, no mesmo lugar que
 * já lê as notícias da busca (fetchArticle), sem duplicar trabalho.
 */
export async function articleFromUrl(url: string, http: Http): Promise<Article> {
  const u = url.trim();
  if (!/^https?:\/\//i.test(u)) throw new Error(`Link inválido: ${u}`);
  const r = await http.getText(u);
  if (r.status >= 400 || !r.text) throw new Error(`Não abriu (HTTP ${r.status}): ${u}`);
  const html = r.text.slice(0, 3_000_000);
  const meta = (prop: string) => {
    const m = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']`, 'i').exec(html) ?? new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`, 'i').exec(html);
    return m ? decodeEntities(m[1]!).trim() : '';
  };
  const title = meta('og:title') || decodeEntities(stripTags(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '')).trim();
  if (!title) throw new Error(`Não achei o título da matéria: ${u}`);
  let source = meta('og:site_name');
  if (!source) {
    try {
      source = new URL(r.url || u).hostname.replace(/^www\./, '');
    } catch {
      source = 'portal';
    }
  }
  return { title, url: r.url || u, source, date: isoDate(meta('article:published_time')), snippet: meta('og:description') || meta('description'), via: 'link', readable: true };
}

/** Lê a página do veículo e extrai título, data e o texto principal da matéria. */
export async function fetchArticle(a: Pick<Article, 'url' | 'title' | 'source' | 'date' | 'snippet'>, http: Http): Promise<ArticleText> {
  const base: ArticleText = { url: a.url, title: a.title, source: a.source, date: a.date, text: a.snippet };
  try {
    const r = await http.getText(a.url);
    if (r.status >= 400 || !r.text) return base;
    const html = r.text.slice(0, 3_000_000);
    const meta = (prop: string) => {
      const m = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']`, 'i').exec(html) ?? new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`, 'i').exec(html);
      return m ? decodeEntities(m[1]!).trim() : '';
    };
    const scope = /<article[\s\S]*?<\/article>/i.exec(html)?.[0] ?? html;
    const paras = (scope.match(/<p[\s>][\s\S]*?<\/p>/gi) ?? [])
      .map(stripTags)
      .filter((p) => p.length >= 50 && !JUNK.test(p));
    const desc = meta('og:description') || meta('description');
    let text = [desc, ...paras].filter(Boolean).join('\n');
    if (text.length > 6000) text = text.slice(0, 6000);
    return {
      url: r.url || a.url,
      title: meta('og:title') || a.title,
      source: meta('og:site_name') || a.source,
      date: isoDate(meta('article:published_time')) ?? a.date,
      text: text || a.snippet,
    };
  } catch {
    return base;
  }
}
