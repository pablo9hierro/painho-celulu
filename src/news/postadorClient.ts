/**
 * Ponte do Postador com o "back-end":
 * - PC (web): servidor Node (/api/pautas, /api/site/write, /api/pautas/image);
 * - app Android: a MESMA lógica roda no aparelho, com a camada nativa
 *   (CapacitorHttp: sem bloqueio de outros sites) e a chave da IA do aparelho.
 * Os dois fazem exatamente a mesma coisa.
 */
import { CapacitorCookies, CapacitorHttp } from '@capacitor/core';
import { capturePautas, type Pauta, type PautaHttp } from './pautas';
import { planSearch, type SearchPlan } from './plan';
import { cachedTrends } from './trends';
import { aiChat } from './openrouter';
import { writeSiteStory, type SiteStory, type ToneOption } from './siteWriter';
import { api, getAiKey, native, nativeHttp, nativePost } from './client';

const UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36';

const header = (h: Record<string, string> | undefined, k: string) => {
  if (!h) return '';
  const hit = Object.keys(h).find((x) => x.toLowerCase() === k);
  return hit ? String(h[hit]) : '';
};

export const nativePautaHttp: PautaHttp = {
  ...nativeHttp,
  async postForm(url, body) {
    const r = await CapacitorHttp.post({ url, headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }, data: body, responseType: 'text', connectTimeout: 12_000, readTimeout: 15_000 });
    return { status: r.status, text: typeof r.data === 'string' ? r.data : JSON.stringify(r.data) };
  },
  async probe(url, referer) {
    const headers = { 'User-Agent': UA, Referer: referer, Accept: 'image/*,*/*;q=0.8' };
    try {
      const r = await CapacitorHttp.request({ method: 'HEAD', url, headers, connectTimeout: 8000, readTimeout: 8000 });
      const type = header(r.headers, 'content-type');
      if (r.status < 400 && type.startsWith('image/')) return { status: r.status, contentType: type, length: Number(header(r.headers, 'content-length')) || 0 };
    } catch {
      /* alguns sites recusam HEAD: tenta o começo do arquivo */
    }
    try {
      const r = await CapacitorHttp.get({ url, headers: { ...headers, Range: 'bytes=0-4095' }, responseType: 'blob', connectTimeout: 8000, readTimeout: 10_000 });
      const range = header(r.headers, 'content-range');
      const len = Number(range.split('/')[1]) || Number(header(r.headers, 'content-length')) || 0;
      return { status: r.status === 206 ? 200 : r.status, contentType: header(r.headers, 'content-type'), length: len };
    } catch {
      return { status: 599, contentType: '', length: 0 };
    }
  },
};

/** Captura e ranqueia as pautas (até 20). `q` = busca livre, como no Google. */
export async function findPautas(q: string, cities: string[]): Promise<{ pautas: Pauta[]; plan: SearchPlan | null }> {
  if (native) {
    let trending: string[] = [];
    try {
      const t = await cachedTrends(nativeHttp, 600_000);
      trending = [...t.searches.map((s) => s.term), ...t.hashtags.map((h) => h.tag)];
    } catch {
      /* sem trends: ranqueia pelo resto */
    }
    const plan = q.trim() ? await planSearch(q, aiChat(getAiKey(), nativePost)) : null;
    const pautas = await capturePautas(nativePautaHttp, { queries: plan?.queries, window: plan?.recency ?? '1d', cities, trending });
    return { pautas, plan };
  }
  return api<{ pautas: Pauta[]; plan: SearchPlan | null }>(`/api/pautas?q=${encodeURIComponent(q.trim())}&cities=${encodeURIComponent(cities.join(','))}`);
}

/** Escreve a matéria do site (com as imagens nos lugares) e escolhe o tom/áudio do vídeo. */
export async function writeSite(p: Pauta, prompt: string, tones: ToneOption[]): Promise<SiteStory> {
  if (native) return writeSiteStory(p, aiChat(getAiKey(), nativePost), prompt, tones);
  return api<SiteStory>('/api/site/write', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pauta: p, prompt, tones, apiKey: getAiKey() || undefined }),
  });
}

const extFor = (type: string) => (type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : type.includes('gif') ? 'gif' : 'jpg');

/** Baixa a foto da matéria como arquivo (para entrar no vídeo). */
export async function fetchPhoto(url: string, referer: string): Promise<File> {
  if (native) {
    const r = await CapacitorHttp.get({ url, headers: { 'User-Agent': UA, Referer: referer, Accept: 'image/*,*/*;q=0.8' }, responseType: 'blob', connectTimeout: 12_000, readTimeout: 25_000 });
    const type = header(r.headers, 'content-type') || 'image/jpeg';
    if (r.status >= 400 || typeof r.data !== 'string' || !type.startsWith('image/')) throw new Error(`O site não entregou a imagem (${r.status}).`);
    const bin = atob(r.data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], `foto-materia.${extFor(type)}`, { type });
  }
  let r: Response;
  try {
    r = await fetch(`/api/pautas/image?url=${encodeURIComponent(url)}&ref=${encodeURIComponent(referer)}`);
  } catch {
    throw new Error('Sem conexão com o servidor do app no PC. Ele está rodando?');
  }
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? `Erro ${r.status}`);
  }
  const blob = await r.blob();
  return new File([blob], `foto-materia.${extFor(blob.type)}`, { type: blob.type || 'image/jpeg' });
}

// ---------------------------------------------------------------- painel do site (WEBSG)

import type { SiteHttp, SiteNews, SitePost, WebsgConfig } from './websg';

const SITE_KEY = 'pn-websg';

/** acesso ao painel do site: guardado só neste aparelho (no PC pode ficar no .env.local do servidor) */
export function getSiteConfig(): WebsgConfig {
  try {
    return { base: '', user: '', pass: '', ...(JSON.parse(localStorage.getItem(SITE_KEY) ?? '{}') as Partial<WebsgConfig>) };
  } catch {
    return { base: '', user: '', pass: '' };
  }
}
export function setSiteConfig(c: WebsgConfig) {
  try {
    localStorage.setItem(SITE_KEY, JSON.stringify({ base: c.base.trim(), user: c.user.trim(), pass: c.pass }));
  } catch {
    /* sem armazenamento */
  }
}

const b64 = (d: Uint8Array) => {
  let s = '';
  for (let i = 0; i < d.length; i += 0x8000) s += String.fromCharCode(...d.subarray(i, i + 0x8000));
  return btoa(s);
};

/** transporte do app: o Android guarda os cookies da sessão sozinho */
let jsGate = false;
const nativeSiteHttp: SiteHttp = {
  async send(r) {
    // o WEBSG só responde a quem passa no teste de JavaScript (cookie js_ok=1)
    if (!jsGate) {
      await CapacitorCookies.setCookie({ url: new URL(r.url).origin, key: 'js_ok', value: '1', path: '/' }).catch(() => undefined);
      jsGate = true;
    }
    const headers: Record<string, string> = { 'User-Agent': UA, 'Accept-Language': 'pt-BR,pt;q=0.9' };
    if (r.referer) headers.Referer = r.referer;
    if (r.ajax) headers['X-Requested-With'] = 'XMLHttpRequest';
    if (r.method === 'GET') {
      const res = await CapacitorHttp.get({ url: r.url, headers, responseType: 'text', connectTimeout: 15_000, readTimeout: 30_000 });
      return { status: res.status, url: res.url || r.url, text: typeof res.data === 'string' ? res.data : JSON.stringify(res.data) };
    }
    if (r.files?.length || r.ajax) {
      const data = [...(r.form ?? []).map(([key, value]) => ({ key, value, type: 'string' })), ...(r.files ?? []).map((f) => ({ key: f.name, value: b64(f.data), type: 'base64File', contentType: f.type, fileName: f.filename }))];
      const res = await CapacitorHttp.request({ method: 'POST', url: r.url, headers: { ...headers, 'Content-Type': 'multipart/form-data' }, data, dataType: 'formData', responseType: 'text', connectTimeout: 15_000, readTimeout: 60_000 });
      return { status: res.status, url: res.url || r.url, text: typeof res.data === 'string' ? res.data : JSON.stringify(res.data) };
    }
    const body = new URLSearchParams(r.form ?? []).toString();
    const res = await CapacitorHttp.post({ url: r.url, headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }, data: body, responseType: 'text', connectTimeout: 15_000, readTimeout: 30_000 });
    return { status: res.status, url: res.url || r.url, text: typeof res.data === 'string' ? res.data : JSON.stringify(res.data) };
  },
};

/** capa no formato do painel (1200x675, recorte central) feita no próprio aparelho */
async function canvasCover(foto: { data: Uint8Array; type: string; name: string }) {
  const bmp = await createImageBitmap(new Blob([foto.data as BlobPart], { type: foto.type }));
  const c = document.createElement('canvas');
  c.width = 1200;
  c.height = 675;
  const s = Math.max(1200 / bmp.width, 675 / bmp.height);
  c.getContext('2d')!.drawImage(bmp, (1200 - bmp.width * s) / 2, (675 - bmp.height * s) / 2, bmp.width * s, bmp.height * s);
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', 0.88));
  if (!blob) return foto;
  return { data: new Uint8Array(await blob.arrayBuffer()), type: 'image/jpeg', name: foto.name.replace(/\.\w+$/, '') + '.jpg' };
}

const withBase = (c: WebsgConfig): WebsgConfig => ({ ...c, base: c.base || 'https://primeirasnoticias.com.br/websg/' });

async function siteApi<T>(path: string, body: unknown): Promise<T> {
  return api<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...(body as object), site: getSiteConfig() }) });
}

export async function siteTest(): Promise<{ ok: true; total: number }> {
  if (native) {
    const { listNews } = await import('./websg');
    const l = await listNews(nativeSiteHttp, withBase(getSiteConfig()), 1);
    return { ok: true, total: l.length };
  }
  return siteApi('/api/site/test', {});
}

export async function siteList(q: string): Promise<SiteNews[]> {
  if (native) {
    const { searchNews } = await import('./websg');
    return searchNews(nativeSiteHttp, withBase(getSiteConfig()), q, 3);
  }
  return (await siteApi<{ news: SiteNews[] }>('/api/site/list', { q })).news;
}

export async function siteDelete(id: number): Promise<void> {
  if (native) {
    const { deleteNews } = await import('./websg');
    return deleteNews(nativeSiteHttp, withBase(getSiteConfig()), id);
  }
  await siteApi('/api/site/delete', { id });
}


export async function sitePublish(post: SitePost): Promise<{ id: number | null; steps: string[] }> {
  if (native) {
    const { addNews } = await import('./websg');
    return addNews(nativeSiteHttp, withBase(getSiteConfig()), post, { prepareCover: canvasCover });
  }
  const { foto, ...rest } = post;
  return siteApi('/api/site/publish', { post: rest, foto: foto ? { ...foto, data: b64(foto.data) } : null });
}

// ---------------------------------------------------------------- Instagram (tokens e renovação)

import { account as igAccount, type IgHttp } from './instagram';
import { maintainTokens, type TokenMeta } from './igToken';

const IG_KEY = 'pn-instagram';
export interface IgDeviceConfig {
  userId: string;
  /** token do Facebook (EAA...): posta os Reels */
  fbToken: string;
  /** token do Instagram (IGAA...): renovado sozinho no aparelho */
  igToken: string;
  meta: TokenMeta;
}
export function getIgConfig(): IgDeviceConfig {
  try {
    return { userId: '', fbToken: '', igToken: '', meta: {}, ...(JSON.parse(localStorage.getItem(IG_KEY) ?? '{}') as Partial<IgDeviceConfig>) };
  } catch {
    return { userId: '', fbToken: '', igToken: '', meta: {} };
  }
}
export function setIgConfig(c: IgDeviceConfig) {
  try {
    localStorage.setItem(IG_KEY, JSON.stringify(c));
  } catch {
    /* sem armazenamento */
  }
}

const nativeIgHttp: IgHttp = {
  async get(url) {
    const r = await CapacitorHttp.get({ url, connectTimeout: 15_000, readTimeout: 30_000 });
    return typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
  },
  async post(url, params) {
    const r = await CapacitorHttp.post({ url, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, data: new URLSearchParams(params).toString(), connectTimeout: 15_000, readTimeout: 60_000 });
    return typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
  },
  async upload(url, headers, data) {
    const r = await CapacitorHttp.post({ url, headers: { ...headers, 'Content-Type': 'application/octet-stream' }, data: b64(data), dataType: 'file', connectTimeout: 15_000, readTimeout: 300_000 });
    return typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
  },
};

export interface IgStatus {
  configurado: boolean;
  conta: { username: string; followers_count?: number } | null;
  igRenovadoEm: string | null;
  igVence: string | null;
  fbAcessoVence: string | null;
  avisos: string[];
}

/** Situação do Instagram; no app também renova o token do Instagram quando for a hora. */
export async function instagramStatus(): Promise<IgStatus> {
  if (!native) return api<IgStatus>('/api/instagram/status');
  const c = getIgConfig();
  const token = c.fbToken || c.igToken;
  if (!token || !c.userId) return { configurado: false, conta: null, igRenovadoEm: null, igVence: null, fbAcessoVence: null, avisos: [] };
  // no aparelho não há segredo do app: renova só o do Instagram (não precisa)
  const r = await maintainTokens(nativeIgHttp, { igToken: c.igToken || undefined }, c.meta);
  setIgConfig({ ...c, igToken: r.igToken ?? c.igToken, meta: { ...r.meta, igToken: undefined } });
  let conta: IgStatus['conta'] = null;
  try {
    conta = await igAccount(nativeIgHttp, { userId: c.userId, token });
  } catch {
    conta = null;
  }
  return { configurado: true, conta, igRenovadoEm: r.meta.igRefreshedAt ?? null, igVence: r.meta.igExpiresAt ?? null, fbAcessoVence: r.meta.fbDataExpiresAt ?? null, avisos: r.warnings };
}
