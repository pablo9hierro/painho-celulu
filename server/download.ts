/** Rota de "Baixar vídeo" no PC: baixa pelo servidor e devolve o MP4 conferido. */
import type { Express } from 'express';
import { downloadVideo, DownloadError, instagramCode, looksLikeVideo, type DlHttp } from '../src/news/reelDownload';
import { EXTRATOR_SITES, extratorScript } from '../src/news/extratorScript';

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

const UA_MOBILE = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36';

/**
 * No PC, o mesmo truque do celular: abre os sites tipo SnapInsta num Chrome
 * escondido (o do Playwright, que já vem nas ferramentas do projeto) e pega o
 * link do arquivo. Sem o Playwright instalado, só pula.
 */
async function viaSites(reel: string, steps: string[]): Promise<Uint8Array | null> {
  let chromium: typeof import('@playwright/test').chromium;
  try {
    ({ chromium } = await import('@playwright/test'));
  } catch {
    steps.push('sites de download: Playwright não instalado');
    return null;
  }
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ userAgent: UA_MOBILE });
    for (const site of EXTRATOR_SITES) {
      const host = new URL(site).hostname;
      const page = await ctx.newPage();
      let out = '';
      page.on('console', (m) => {
        const t = m.text();
        if (/^PN(DONE|FAIL) /.test(t)) out = t;
      });
      try {
        await page.goto(site, { waitUntil: 'load', timeout: 30_000 });
        await page.evaluate('window.PNExtrator = { done: function(h){ console.log("PNDONE " + h); }, fail: function(m){ console.log("PNFAIL " + m); } };');
        await page.evaluate(extratorScript(reel));
        const t0 = Date.now();
        while (!out && Date.now() - t0 < 50_000) await page.waitForTimeout(400);
        if (out.startsWith('PNDONE ')) {
          const bin = await nodeDl.binary(out.slice(7), { 'User-Agent': UA_MOBILE, Referer: site });
          if (bin.status < 400 && looksLikeVideo(bin.bytes)) {
            steps.push(`${host}: ok`);
            return bin.bytes;
          }
          steps.push(`${host}: arquivo HTTP ${bin.status}`);
        } else steps.push(`${host}: ${out.slice(7) || 'sem resposta'}`);
      } catch (e) {
        steps.push(`${host}: ${(e as Error).message.split('\n')[0]}`);
      } finally {
        await page.close();
      }
    }
    return null;
  } finally {
    await browser.close();
  }
}

export function registerDownload(app: Express) {
  app.get('/api/download', async (req, res) => {
    const url = String(req.query.url ?? '').slice(0, 2000);
    const code = instagramCode(url);
    const steps: string[] = [];
    const send = (bytes: Uint8Array, fileName: string, via: string) => {
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('X-File-Name', encodeURIComponent(fileName));
      res.setHeader('X-Via', via);
      res.setHeader('Access-Control-Expose-Headers', 'X-File-Name, X-Via');
      res.end(Buffer.from(bytes));
    };
    // Reels: 1º pelos sites de download (o que funciona hoje), depois direto
    if (code && process.env.PN_SEM_SITES !== '1') {
      const b = await viaSites(url.trim(), steps).catch((e: Error) => (steps.push(`sites: ${e.message}`), null));
      if (b) return send(b, `reels-${code}.mp4`, 'sites');
    }
    try {
      const r = await downloadVideo(url, nodeDl);
      send(r.bytes, r.fileName, r.via);
    } catch (e) {
      res.status(422).json({ error: (e as Error).message, steps: [...steps, ...(e instanceof DownloadError ? e.steps : [])] });
    }
  });
}
