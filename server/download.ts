/** Rota de "Baixar vídeo" no PC: baixa pelo servidor e devolve o MP4 conferido. */
import type { Express } from 'express';
import { downloadVideo, DownloadError, type DlHttp } from '../src/news/reelDownload';

const cookiesOf = (h: Headers) => (typeof h.getSetCookie === 'function' ? h.getSetCookie() : []).map((c) => c.split(';')[0]!.trim()).filter(Boolean);

export const nodeDl: DlHttp = {
  async get(url, headers) {
    const r = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(20_000) });
    return { status: r.status, text: await r.text(), url: r.url, cookies: cookiesOf(r.headers) };
  },
  async post(url, headers, body) {
    const r = await fetch(url, { method: 'POST', headers, body, redirect: 'follow', signal: AbortSignal.timeout(20_000) });
    return { status: r.status, text: await r.text(), url: r.url, cookies: cookiesOf(r.headers) };
  },
  async binary(url, headers) {
    const r = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(120_000) });
    return { status: r.status, contentType: r.headers.get('content-type') ?? '', bytes: new Uint8Array(await r.arrayBuffer()) };
  },
};

export function registerDownload(app: Express) {
  app.get('/api/download', async (req, res) => {
    const url = String(req.query.url ?? '').slice(0, 2000);
    try {
      const r = await downloadVideo(url, nodeDl);
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('X-File-Name', encodeURIComponent(r.fileName));
      res.setHeader('X-Via', r.via);
      res.setHeader('Access-Control-Expose-Headers', 'X-File-Name, X-Via');
      res.end(Buffer.from(r.bytes));
    } catch (e) {
      const steps = e instanceof DownloadError ? e.steps : [];
      res.status(422).json({ error: (e as Error).message, steps });
    }
  });
}
