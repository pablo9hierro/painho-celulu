/**
 * Transportes Node: painel do site (com cookies da sessão, seguindo
 * redirecionamentos e guardando o Set-Cookie de cada passo) e Instagram.
 * Usados pelo servidor do PC e pela automação (cron).
 */
import type { SiteHttp, SiteReq, SiteRes } from '../src/news/websg';
import type { IgHttp } from '../src/news/instagram';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36';

export function nodeSiteHttp(): SiteHttp & { cookies: Map<string, string> } {
  // o WEBSG só responde a quem passa no teste de JavaScript (cookie js_ok=1)
  const cookies = new Map<string, string>([['js_ok', '1']]);
  const take = (h: Headers) => {
    const list = (h as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? (h.get('set-cookie') ? [h.get('set-cookie')!] : []);
    for (const c of list) {
      const [pair] = c.split(';');
      const i = pair!.indexOf('=');
      if (i > 0) cookies.set(pair!.slice(0, i).trim(), pair!.slice(i + 1).trim());
    }
  };
  const cookieHeader = () => [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  return {
    cookies,
    async send(r: SiteReq): Promise<SiteRes> {
      let url = r.url;
      let method: string = r.method;
      let body: BodyInit | undefined;
      const headers: Record<string, string> = { 'User-Agent': UA, 'Accept-Language': 'pt-BR,pt;q=0.9', Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' };
      if (r.referer) headers.Referer = r.referer;
      if (r.ajax) {
        headers['X-Requested-With'] = 'XMLHttpRequest';
        headers.Accept = '*/*';
        if (r.referer) headers.Origin = new URL(r.referer).origin;
      }
      if (method === 'POST') {
        if (r.files?.length || r.ajax) {
          const fd = new FormData();
          for (const [k, v] of r.form ?? []) fd.append(k, v);
          for (const f of r.files ?? []) fd.append(f.name, new Blob([f.data as BlobPart], { type: f.type }), f.filename);
          body = fd;
        } else {
          body = new URLSearchParams(r.form ?? []).toString();
          headers['Content-Type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
        }
      } else if (r.form?.length) {
        url += (url.includes('?') ? '&' : '?') + new URLSearchParams(r.form).toString();
      }
      // segue redirecionamentos na mão para não perder cookies de cada passo
      for (let hop = 0; hop < 8; hop++) {
        const res = await fetch(url, { method, headers: { ...headers, ...(cookies.size ? { Cookie: cookieHeader() } : {}) }, body, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
        take(res.headers);
        const loc = res.headers.get('location');
        if (res.status >= 300 && res.status < 400 && loc) {
          headers.Referer = url;
          url = new URL(loc, url).href;
          if (res.status !== 307 && res.status !== 308) {
            method = 'GET';
            body = undefined;
            delete headers['Content-Type'];
          }
          continue;
        }
        return { status: res.status, url, text: await res.text() };
      }
      throw new Error('O painel redirecionou vezes demais.');
    },
  };
}

export const nodeIgHttp: IgHttp = {
  async get(url) {
    const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    return r.json().catch(() => ({ error: { code: r.status, message: `resposta inválida (${r.status})` } }));
  },
  async post(url, params) {
    const r = await fetch(url, { method: 'POST', body: new URLSearchParams(params), signal: AbortSignal.timeout(60_000) });
    return r.json().catch(() => ({ error: { code: r.status, message: `resposta inválida (${r.status})` } }));
  },
  async upload(url, headers, data) {
    const r = await fetch(url, { method: 'POST', headers, body: data as BodyInit, signal: AbortSignal.timeout(300_000) });
    return r.json().catch(() => ({ error: { code: r.status, message: `resposta inválida (${r.status})` } }));
  },
};

/** Capa no formato do painel (1200x675, 16:9, JPEG), recortando ao centro (ffmpeg). */
export async function nodePrepareCover(foto: { data: Uint8Array; type: string; name: string }): Promise<{ data: Uint8Array; type: string; name: string }> {
  const { spawn } = await import('node:child_process');
  const { ffmpegPaths } = await import('./config');
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPaths().ffmpeg, ['-v', 'error', '-i', 'pipe:0', '-vf', 'scale=1200:675:force_original_aspect_ratio=increase,crop=1200:675', '-frames:v', '1', '-q:v', '3', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    p.stdout.on('data', (d: Buffer) => out.push(d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 && out.length ? resolve({ data: new Uint8Array(Buffer.concat(out)), type: 'image/jpeg', name: foto.name.replace(/\.\w+$/, '') + '.jpg' }) : reject(new Error('não consegui recortar a capa'))));
    p.stdin.end(Buffer.from(foto.data));
  });
}
