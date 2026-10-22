/**
 * Baixar vídeo por link (Reels do Instagram ou link direto de vídeo).
 *
 * Roda no BACK-END: no PC dentro do servidor, no app pela camada nativa do
 * celular (com a internet do próprio aparelho). Caminhos, em ordem, cada um
 * com reserva:
 * 1. link direto de vídeo (.mp4/.mov/.webm ou resposta video/*) → baixa direto;
 * 2. Instagram: a mesma consulta pública que o site do Instagram faz para mostrar
 *    o post sem login (com os cookies e o token da própria página);
 * 3. página de incorporação (embed) do post;
 * 4. metadados da página (og:video).
 * Depois confere se o arquivo é um MP4 de verdade e completo (não corrompido);
 * se não for, tenta outra qualidade/caminho. O Instagram muda isso sem aviso e
 * às vezes limita pedidos: aí a mensagem explica e o jornalista importa o
 * arquivo manualmente.
 */

export interface DlResponse {
  status: number;
  text: string;
  url: string;
  /** cookies recebidos (Set-Cookie), já no formato nome=valor */
  cookies: string[];
}

export interface DlHttp {
  get(url: string, headers: Record<string, string>): Promise<DlResponse>;
  post(url: string, headers: Record<string, string>, body: string): Promise<DlResponse>;
  /** baixa o arquivo (bytes) */
  binary(url: string, headers: Record<string, string>): Promise<{ status: number; contentType: string; bytes: Uint8Array }>;
}

export interface DlResult {
  bytes: Uint8Array;
  fileName: string;
  /** caminho que funcionou */
  via: 'direto' | 'instagram' | 'embed' | 'página';
  steps: string[];
}

export class DownloadError extends Error {
  constructor(
    message: string,
    readonly steps: string[],
  ) {
    super(message);
  }
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36';
const APP_ID = '936619743392459';
/** identificadores da consulta pública do post (o Instagram troca de tempos em tempos) */
const DOC_IDS = ['8845758582119845', '10015901848480474', '25018359077785073'];
const MIN_BYTES = 50 * 1024;
const MAX_BYTES = 400 * 1024 * 1024;

/** Código do post em links de Reels/post/IGTV (inclui links de compartilhar com ?igsh=). */
export function instagramCode(link: string): string | null {
  const m = /instagram\.com\/(?:[A-Za-z0-9_.]+\/)?(?:reel|reels|p|tv)\/([A-Za-z0-9_-]{5,})/i.exec(link);
  return m ? m[1]! : null;
}

export function isDirectVideoLink(link: string): boolean {
  return /^https?:\/\/[^\s]+\.(mp4|m4v|mov|webm)(\?|#|$)/i.test(link);
}

const unescapeJson = (s: string) => {
  try {
    return JSON.parse(`"${s}"`) as string;
  } catch {
    return s.replace(/\\u0026/g, '&').replace(/\\\//g, '/');
  }
};

/** É um MP4/MOV de verdade (caixa ftyp no início) ou WebM? */
export function looksLikeVideo(bytes: Uint8Array): boolean {
  if (bytes.length < MIN_BYTES) return false;
  const tag = String.fromCharCode(bytes[4]!, bytes[5]!, bytes[6]!, bytes[7]!);
  const webm = bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
  return tag === 'ftyp' || webm;
}

/** Todos os links de vídeo encontrados numa resposta (JSON ou HTML), do maior para o menor. */
export function videoUrlsIn(text: string): string[] {
  const found: { url: string; w: number }[] = [];
  for (const m of text.matchAll(/"video_url"\s*:\s*"([^"]+)"/g)) found.push({ url: unescapeJson(m[1]!), w: 10_000 });
  // video_versions: [{width, height, url}]
  for (const m of text.matchAll(/\{[^{}]*"width"\s*:\s*(\d+)[^{}]*"url"\s*:\s*"([^"]+\.mp4[^"]*)"[^{}]*\}/g)) found.push({ url: unescapeJson(m[2]!), w: Number(m[1]) });
  for (const m of text.matchAll(/<meta[^>]+property=["']og:video(?::secure_url)?["'][^>]*content=["']([^"']+)["']/gi)) found.push({ url: m[1]!.replace(/&amp;/g, '&'), w: 5000 });
  const seen = new Set<string>();
  return found
    .sort((a, b) => b.w - a.w)
    .map((f) => f.url)
    .filter((u) => /^https?:\/\//.test(u) && !seen.has(u) && seen.add(u));
}

/** Diz se a resposta do Instagram indica bloqueio/login/indisponível (para a mensagem certa). */
function igProblem(status: number, text: string): string | null {
  if (status === 429 || /wait a few minutes|try again later|rate.?limit/i.test(text)) return 'limite';
  if (status === 404 || /page isn.t available|"status":"fail".*not.?found|media.?not.?found/i.test(text)) return 'removido';
  if (/login_required|"require_login":true|private/i.test(text)) return 'privado';
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchVideo(http: DlHttp, url: string, referer: string, steps: string[]): Promise<Uint8Array | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await http.binary(url, { 'User-Agent': UA, Referer: referer, Accept: 'video/*,*/*;q=0.8' });
      if (r.status >= 400) {
        steps.push(`download HTTP ${r.status}`);
        continue;
      }
      if (r.bytes.length > MAX_BYTES) {
        steps.push('arquivo grande demais');
        return null;
      }
      if (!looksLikeVideo(r.bytes)) {
        steps.push(`arquivo recebido não é vídeo (${r.contentType || 'sem tipo'}, ${r.bytes.length} bytes)`);
        continue;
      }
      return r.bytes;
    } catch (e) {
      steps.push(`falha no download: ${(e as Error).message}`);
    }
    await sleep(800);
  }
  return null;
}

async function tryUrls(http: DlHttp, urls: string[], referer: string, steps: string[]): Promise<Uint8Array | null> {
  for (const u of urls.slice(0, 4)) {
    const b = await fetchVideo(http, u, referer, steps);
    if (b) return b;
  }
  return null;
}

/** Baixa o vídeo do link. Lança DownloadError com mensagem clara quando não der. */
export async function downloadVideo(link: string, http: DlHttp): Promise<DlResult> {
  const steps: string[] = [];
  const clean = link.trim();
  if (!/^https?:\/\//i.test(clean)) throw new DownloadError('Cole um link completo (começando com https://).', steps);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');

  // 1) link direto de vídeo
  if (isDirectVideoLink(clean)) {
    const b = await fetchVideo(http, clean, clean, steps);
    if (b) return { bytes: b, fileName: `video-${stamp}.mp4`, via: 'direto', steps };
    throw new DownloadError('Não foi possível baixar esse arquivo de vídeo (o site recusou ou o arquivo não é um vídeo válido).', steps);
  }

  const code = instagramCode(clean);
  if (!code) {
    // outro site: tenta achar vídeo na página (og:video etc.)
    try {
      const r = await http.get(clean, { 'User-Agent': UA, 'Accept-Language': 'pt-BR' });
      const b = await tryUrls(http, videoUrlsIn(r.text), clean, steps);
      if (b) return { bytes: b, fileName: `video-${stamp}.mp4`, via: 'página', steps };
    } catch (e) {
      steps.push(`página: ${(e as Error).message}`);
    }
    throw new DownloadError('Não achei um vídeo nesse link. Por enquanto o app baixa Reels/posts do Instagram e links diretos de vídeo.', steps);
  }

  const postUrl = `https://www.instagram.com/reel/${code}/`;
  const fileName = `reels-${code}.mp4`;
  let problem: string | null = null;
  let cookies: string[] = [];
  let lsd = '';
  let pageText = '';

  // 2) página do post: cookies + token, e às vezes o próprio vídeo
  try {
    const r = await http.get(postUrl, { 'User-Agent': UA, 'Accept-Language': 'pt-BR,pt;q=0.9' });
    pageText = r.text;
    cookies = r.cookies;
    lsd = /"LSD",\[\],\{"token":"([^"]+)"/.exec(r.text)?.[1] ?? /"lsd":"([^"]+)"/.exec(r.text)?.[1] ?? '';
    problem = igProblem(r.status, r.text);
    steps.push(`página do post: HTTP ${r.status}${lsd ? ', token ok' : ', sem token'}`);
  } catch (e) {
    steps.push(`página do post: ${(e as Error).message}`);
  }

  // 3) consulta pública do post (a mesma do site), com reserva de identificadores e nova tentativa
  if (lsd) {
    const csrf = cookies.find((c) => c.startsWith('csrftoken='))?.split('=')[1] ?? '';
    const headers = {
      'User-Agent': UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-IG-App-ID': APP_ID,
      'X-FB-LSD': lsd,
      'X-CSRFToken': csrf,
      'X-ASBD-ID': '129477',
      'Sec-Fetch-Site': 'same-origin',
      Origin: 'https://www.instagram.com',
      Referer: postUrl,
      Cookie: cookies.join('; '),
    };
    outer: for (let round = 0; round < 2; round++) {
      for (const doc of DOC_IDS) {
        try {
          const body = `av=0&__d=www&__user=0&__a=1&__req=3&lsd=${encodeURIComponent(lsd)}&fb_api_caller_class=RelayModern&fb_api_req_friendly_name=PolarisPostActionLoadPostQueryQuery&variables=${encodeURIComponent(JSON.stringify({ shortcode: code }))}&server_timestamps=true&doc_id=${doc}`;
          const r = await http.post('https://www.instagram.com/graphql/query', headers, body);
          const p = igProblem(r.status, r.text);
          steps.push(`consulta ${doc.slice(0, 4)}…: HTTP ${r.status}${p ? ` (${p})` : ''}`);
          if (p) problem = p;
          if (/"is_video"\s*:\s*false/.test(r.text) && !/"video_url"/.test(r.text)) {
            throw new DownloadError('Esse post é uma foto, não um vídeo.', steps);
          }
          const urls = videoUrlsIn(r.text);
          if (urls.length) {
            const b = await tryUrls(http, urls, postUrl, steps);
            if (b) return { bytes: b, fileName, via: 'instagram', steps };
          }
          if (p === 'limite') break; // não adianta trocar de identificador agora
        } catch (e) {
          if (e instanceof DownloadError) throw e;
          steps.push(`consulta: ${(e as Error).message}`);
        }
      }
      if (problem !== 'limite' || round > 0) break outer;
      await sleep(2500); // limite de pedidos: espera um pouco e tenta de novo uma vez
    }
  }

  // 4) página de incorporação e 5) metadados da página
  for (const [label, u] of [
    ['embed', `https://www.instagram.com/p/${code}/embed/captioned/`],
    ['embed', `https://www.instagram.com/reel/${code}/embed/`],
  ] as const) {
    try {
      const r = await http.get(u, { 'User-Agent': UA, 'Accept-Language': 'pt-BR', Cookie: cookies.join('; ') });
      const p = igProblem(r.status, r.text);
      if (p) problem = problem ?? p;
      const b = await tryUrls(http, videoUrlsIn(r.text), postUrl, steps);
      steps.push(`${label}: HTTP ${r.status}`);
      if (b) return { bytes: b, fileName, via: label, steps };
    } catch (e) {
      steps.push(`${label}: ${(e as Error).message}`);
    }
  }
  if (pageText) {
    const b = await tryUrls(http, videoUrlsIn(pageText), postUrl, steps);
    if (b) return { bytes: b, fileName, via: 'página', steps };
  }

  const why =
    problem === 'limite'
      ? 'O Instagram está limitando os downloads agora (muitos pedidos). Espere alguns minutos e tente de novo'
      : problem === 'privado'
        ? 'Esse vídeo pede login ou é de conta privada'
        : problem === 'removido'
          ? 'Esse post não está mais disponível (apagado ou link errado)'
          : 'O Instagram não liberou o vídeo por nenhum caminho (pode ter mudado o site)';
  throw new DownloadError(`${why}. Enquanto isso, baixe pelo SnapInsta e use "Importar arquivo".`, steps);
}
