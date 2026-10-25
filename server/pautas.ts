/** Rotas do Postador no PC: captura e ranking de pautas (com conferência de imagens). */
import type { Express, Request, Response } from 'express';
import { enrichPauta } from '../src/news/enrich';
import { writeSiteStory, type ToneOption } from '../src/news/siteWriter';
import type { Pauta } from '../src/news/pautas';
import { capturePautas, type PautaHttp } from '../src/news/pautas';
import { planSearch } from '../src/news/plan';
import { cachedTrends } from '../src/news/trends';
import { aiChat } from '../src/news/openrouter';
import { nodeHttp } from './news';
import { addNews, deleteNews, listNews, searchNews, WEBSG_DEFAULT, type SitePost, type WebsgConfig } from '../src/news/websg';
import { nodePrepareCover, nodeSiteHttp } from './siteHttp';

/** acesso ao painel: o que veio do app ou, se vazio, o .env.local do PC */
function siteCfg(body: { site?: Partial<WebsgConfig> }): WebsgConfig {
  const s = body.site ?? {};
  return {
    base: (s.base || process.env.WEBSG_URL || WEBSG_DEFAULT).trim(),
    user: (s.user || process.env.WEBSG_USER || '').trim(),
    pass: s.pass || process.env.WEBSG_PASS || '',
  };
}
/** uma sessão (cookies) por usuário do painel, reaproveitada entre os pedidos */
const sessions = new Map<string, ReturnType<typeof nodeSiteHttp>>();
const session = (c: WebsgConfig) => {
  const k = `${c.base}|${c.user}`;
  if (!sessions.has(k)) sessions.set(k, nodeSiteHttp());
  return sessions.get(k)!;
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36';

export const nodePautaHttp: PautaHttp = {
  ...nodeHttp,
  async postForm(url, body) {
    const r = await fetch(url, { method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body, signal: AbortSignal.timeout(15_000) });
    return { status: r.status, text: await r.text() };
  },
  async probe(url, referer) {
    // HEAD primeiro; alguns sites recusam HEAD → GET só do começo
    const headers = { 'User-Agent': UA, Referer: referer, Accept: 'image/*,*/*;q=0.8' };
    let r = await fetch(url, { method: 'HEAD', headers, redirect: 'follow', signal: AbortSignal.timeout(8000) }).catch(() => null);
    if (!r || r.status >= 400 || !(r.headers.get('content-type') ?? '').startsWith('image/')) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      r = await fetch(url, { headers: { ...headers, Range: 'bytes=0-4095' }, redirect: 'follow', signal: ctrl.signal }).catch(() => null);
      clearTimeout(t);
      if (r) await r.body?.cancel().catch(() => undefined);
    }
    if (!r) return { status: 599, contentType: '', length: 0 };
    const len = Number(r.headers.get('content-length') ?? 0);
    const range = r.headers.get('content-range');
    const total = range ? Number(range.split('/')[1]) || len : len;
    return { status: r.status === 206 ? 200 : r.status, contentType: r.headers.get('content-type') ?? '', length: total };
  },
};

const key = () => (process.env.AI_API_KEY || process.env.OPENROUTER_API_KEY || process.env.GEMINI_API_KEY || '').trim();

export function registerPautas(app: Express, json: (req: Request, res: Response, next: () => void) => void) {
  app.get('/api/pautas', async (req, res) => {
    const q = String(req.query.q ?? '').slice(0, 300).trim();
    const cities = String(req.query.cities ?? '')
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);
    try {
      // em alta agora: termos do Google Trends + hashtags (influenciam o ranking)
      let trending: string[] = [];
      try {
        const t = await cachedTrends(nodeHttp, 600_000);
        trending = [...t.searches.map((s) => s.term), ...t.hashtags.map((h) => h.tag)];
      } catch {
        /* sem trends: ranqueia pelo resto */
      }
      const plan = q ? await planSearch(q, aiChat(key())) : null;
      const pautas = await capturePautas(nodePautaHttp, { queries: plan?.queries, window: plan?.recency ?? '1d', cities, trending });
      res.json({ pautas, plan });
    } catch (e) {
      res.status(502).json({ error: `Não foi possível capturar as pautas: ${(e as Error).message}` });
    }
  });

  // matéria para o site (e tom/áudio do post em vídeo) a partir de uma pauta
  app.post('/api/site/write', json, async (req, res) => {
    const body = req.body as { pauta?: Pauta; prompt?: string; apiKey?: string; tones?: ToneOption[] };
    if (!body.pauta?.url) return res.status(400).json({ error: 'Escolha uma pauta.' });
    try {
      const k = body.apiKey?.trim() || key();
      const steps: string[] = [];
      const rica = await enrichPauta(body.pauta, nodeHttp, steps);
      const story = await writeSiteStory(rica, aiChat(k), String(body.prompt ?? '').slice(0, 1000), (body.tones ?? []).slice(0, 30));
      res.json({ ...story, steps: [...steps, ...story.steps] });
    } catch (e) {
      res.status(500).json({ error: `Falha ao escrever: ${(e as Error).message}` });
    }
  });

  // foto da matéria (o navegador não baixa direto de outros sites): repassa a imagem
  app.get('/api/pautas/image', async (req, res) => {
    const url = String(req.query.url ?? '');
    if (!/^https?:\/\//.test(url)) return res.status(400).json({ error: 'Link inválido.' });
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, Referer: String(req.query.ref ?? ''), Accept: 'image/*,*/*;q=0.8' }, redirect: 'follow', signal: AbortSignal.timeout(20_000) });
      const type = r.headers.get('content-type') ?? '';
      if (!r.ok || !type.startsWith('image/')) return res.status(502).json({ error: `O site não entregou a imagem (${r.status}).` });
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 25 * 1024 * 1024) return res.status(413).json({ error: 'Imagem grande demais.' });
      res.setHeader('Content-Type', type);
      res.send(buf);
    } catch (e) {
      res.status(502).json({ error: `Não foi possível baixar a imagem: ${(e as Error).message}` });
    }
  });

  // painel do site: testar acesso, listar/buscar, publicar e apagar
  const site = (fn: (body: Record<string, unknown>, c: WebsgConfig) => Promise<unknown>) => async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const c = siteCfg(body as { site?: Partial<WebsgConfig> });
    try {
      res.json(await fn(body, c));
    } catch (e) {
      res.status(502).json({ error: (e as Error).message });
    }
  };
  app.post('/api/site/test', json, site(async (_b, c) => ({ ok: true, total: (await listNews(session(c), c, 1)).length })));
  app.post('/api/site/list', json, site(async (b, c) => ({ news: await searchNews(session(c), c, String(b.q ?? '').slice(0, 200), Math.min(8, Math.max(1, Number(b.pages) || 3))) })));
  app.post('/api/site/delete', json, site(async (b, c) => {
    await deleteNews(session(c), c, Number(b.id));
    return { ok: true };
  }));
  app.post('/api/site/publish', json, site(async (b, c) => {
    const post = b.post as Omit<SitePost, 'foto'>;
    const foto = b.foto as { data: string; type: string; name: string } | null;
    if (!post?.titulo) throw new Error('Matéria sem título.');
    return addNews(session(c), c, { ...post, foto: foto ? { ...foto, data: new Uint8Array(Buffer.from(foto.data, 'base64')) } : null }, { prepareCover: nodePrepareCover });
  }));
}
