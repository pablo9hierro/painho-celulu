/**
 * "Baixar vídeo" no app: no celular pela camada nativa (internet do próprio
 * aparelho, sem bloqueio do navegador); no PC pelo servidor local.
 * O arquivo recebido é conferido (MP4 completo, com trilha de vídeo) antes de
 * ir para a edição — nada corrompido entra no projeto.
 */
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { downloadVideo, DownloadError, instagramCode, looksLikeVideo, type DlHttp } from './reelDownload';
import { linkPorSites } from '../platform/extrator';

const UA_MOBILE = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36';
import { indexMp4 } from '../engine/mp4index';

const native = Capacitor.isNativePlatform();

/** Set-Cookie vindo da camada nativa (string única ou lista) → ["nome=valor"] */
function cookiesFrom(headers: Record<string, string | string[] | undefined>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (k.toLowerCase() !== 'set-cookie' || !v) continue;
    const list = Array.isArray(v) ? v : String(v).split(/,(?=\s*[A-Za-z0-9_-]+=)/);
    for (const c of list) {
      const nv = c.split(';')[0]!.trim();
      if (nv.includes('=')) out.push(nv);
    }
  }
  return out;
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/^data:[^,]*,/, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const nativeDl: DlHttp = {
  async get(url, headers) {
    const r = await CapacitorHttp.get({ url, headers, responseType: 'text', connectTimeout: 15_000, readTimeout: 20_000 });
    return { status: r.status, text: typeof r.data === 'string' ? r.data : JSON.stringify(r.data), url: r.url || url, cookies: cookiesFrom(r.headers) };
  },
  async post(url, headers, body) {
    const r = await CapacitorHttp.post({ url, headers, data: body, responseType: 'text', connectTimeout: 15_000, readTimeout: 20_000 });
    return { status: r.status, text: typeof r.data === 'string' ? r.data : JSON.stringify(r.data), url: r.url || url, cookies: cookiesFrom(r.headers) };
  },
  async binary(url, headers) {
    const r = await CapacitorHttp.get({ url, headers, responseType: 'blob', connectTimeout: 20_000, readTimeout: 120_000 });
    const ct = String((r.headers as Record<string, string>)['Content-Type'] ?? (r.headers as Record<string, string>)['content-type'] ?? '');
    const bytes = typeof r.data === 'string' ? b64ToBytes(r.data) : new Uint8Array(await (r.data as Blob).arrayBuffer());
    return { status: r.status, contentType: ct, bytes };
  },
};

export interface Downloaded {
  file: File;
  via: string;
  steps: string[];
}

export class LinkDownloadError extends Error {
  constructor(
    message: string,
    readonly steps: string[],
  ) {
    super(message);
  }
}

/** O próprio player do aparelho consegue abrir o vídeo? (duração e imagem) */
function playable(file: File): Promise<boolean> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'metadata';
    const done = (ok: boolean) => {
      clearTimeout(timer);
      v.removeAttribute('src');
      v.load();
      URL.revokeObjectURL(url);
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), 15_000);
    v.onloadedmetadata = () => done(Number.isFinite(v.duration) && v.duration > 0 && v.videoWidth > 0);
    v.onerror = () => done(false);
    v.src = url;
  });
}

/** Confere se o arquivo é um vídeo inteiro e utilizável (senão, é corrompido/incompleto). */
async function verify(file: File): Promise<void> {
  const head = new Uint8Array(await file.slice(0, 64 * 1024).arrayBuffer());
  if (file.size < 50 * 1024 || !looksLikeVideo(head.length >= 50 * 1024 ? head : new Uint8Array(await file.slice(0, 50 * 1024).arrayBuffer()))) {
    throw new LinkDownloadError('O arquivo baixado veio vazio, incompleto ou não é um vídeo.', []);
  }
  // MP4 normal: o índice precisa ter trilha de vídeo
  const idx = await indexMp4(file).catch(() => null);
  if (idx?.video) return;
  // reserva (MP4 fragmentado, WebM...): o player do aparelho precisa abrir
  if (await playable(file)) return;
  throw new LinkDownloadError('O vídeo baixado está corrompido ou incompleto. Tente baixar de novo.', []);
}

/** onStep: o que está tentando agora (para mostrar na tela) */
export async function downloadFromLink(link: string, onStep?: (s: string) => void): Promise<Downloaded> {
  let file: File;
  let via = '';
  let steps: string[] = [];
  if (native) {
    const code = instagramCode(link);
    // 1º: sites tipo SnapInsta num navegador escondido (o mesmo que funciona no navegador do celular)
    let viaSite: File | null = null;
    if (code) {
      try {
        const { link: arquivo, site } = await linkPorSites(link.trim(), steps, onStep);
        const bin = await nativeDl.binary(arquivo, { 'User-Agent': UA_MOBILE, Referer: `https://${site.replace(/^https?:\/\//, '')}` });
        if (bin.status < 400 && looksLikeVideo(bin.bytes)) {
          viaSite = new File([bin.bytes as BlobPart], `reels-${code}.mp4`, { type: 'video/mp4' });
          via = new URL(site).hostname;
        } else steps.push(`arquivo do site: HTTP ${bin.status}, ${bin.bytes.length} bytes`);
      } catch (e) {
        steps.push(`sites de download: ${(e as Error).message}`);
      }
    }
    if (viaSite) file = viaSite;
    else {
      // 2º: os caminhos diretos do Instagram (página, consulta pública, incorporação)
      onStep?.('Tentando direto no Instagram…');
      try {
        const r = await downloadVideo(link, nativeDl);
        file = new File([r.bytes as BlobPart], r.fileName, { type: 'video/mp4' });
        via = r.via;
        steps = [...steps, ...r.steps];
      } catch (e) {
        throw new LinkDownloadError(
          code ? 'Não consegui baixar nem pelos sites de download (fastdl, sssinstagram, igram) nem direto do Instagram. Confira se o post é público e tente de novo em alguns minutos.' : (e as Error).message,
          [...steps, ...(e instanceof DownloadError ? e.steps : [])],
        );
      }
    }
  } else {
    let res: Response;
    try {
      res = await fetch(`/api/download?url=${encodeURIComponent(link)}`);
    } catch {
      throw new LinkDownloadError('Sem conexão com o servidor do app no PC. Ele está rodando?', []);
    }
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string; steps?: string[] };
      throw new LinkDownloadError(j.error ?? `Erro ${res.status} ao baixar.`, j.steps ?? []);
    }
    const name = decodeURIComponent(res.headers.get('X-File-Name') ?? 'video.mp4');
    via = res.headers.get('X-Via') ?? '';
    file = new File([await res.blob()], name, { type: 'video/mp4' });
  }
  await verify(file);
  return { file, via, steps };
}
