/**
 * Back-end da "Postagem": busca de notícias públicas, leitura das matérias e
 * redação da legenda com IA (chave só no servidor, em .env.local: AI_API_KEY).
 */
import type { Express, Request, Response } from 'express';
import { articleFromUrl, fetchArticle, searchRecent, type Article, type Http } from '../src/news/search';
import { planSearch } from '../src/news/plan';
import { writeStory } from '../src/news/writer';
import { aiChat } from '../src/news/openrouter';
import { cachedTrends, lookupHashtag } from '../src/news/trends';
import { withTrendingHashtags } from '../src/news/hashtags';
import { usdBrl } from '../src/news/cost';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36';

export const nodeHttp: Http = {
  async getText(url) {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'pt-BR,pt;q=0.9', Accept: 'text/html,application/xhtml+xml,application/xml,application/rss+xml;q=0.9,*/*;q=0.8' },
      redirect: 'follow',
      signal: AbortSignal.timeout(12_000),
    });
    return { status: r.status, text: await r.text(), url: r.url };
  },
};

/** chave da IA no servidor: OpenRouter (sk-or-...) ou Google AI Studio (AIza...) */
const key = () => (process.env.AI_API_KEY || process.env.OPENROUTER_API_KEY || process.env.GEMINI_API_KEY || '').trim();

export function registerNews(app: Express, json: (req: Request, res: Response, next: () => void) => void) {
  app.get('/api/news/config', (_req, res) => res.json({ ai: !!key() }));
  // cotação do dólar (para mostrar o custo da IA em reais)
  app.get('/api/fx', async (_req, res) => res.json(await usdBrl(async (u) => (await fetch(u, { signal: AbortSignal.timeout(10_000) })).json())));

  // trends: guarda a última captura por 3 min (Atualizar força uma nova)
  app.get('/api/trends', async (req, res) => {
    try {
      res.json(await cachedTrends(nodeHttp, 180_000, req.query.refresh === '1'));
    } catch (e) {
      res.status(502).json({ error: `Não foi possível capturar as trends: ${(e as Error).message}` });
    }
  });
  app.get('/api/trends/hashtag', async (req, res) => {
    try {
      res.json(await lookupHashtag(String(req.query.tag ?? '').slice(0, 80), nodeHttp));
    } catch (e) {
      res.status(502).json({ error: (e as Error).message });
    }
  });

  app.get('/api/news', async (req, res) => {
    const q = String(req.query.q ?? '').slice(0, 300);
    try {
      const plan = await planSearch(q, aiChat(key()));
      const r = await searchRecent(plan.queries, plan.recency, nodeHttp, 20, { year: plan.year, names: plan.names });
      res.json({ articles: r.articles, plan: { ...plan, used: r.window, missing: r.missing } });
    } catch (e) {
      res.status(502).json({ error: `Não foi possível buscar notícias: ${(e as Error).message}` });
    }
  });

  // o jornalista cola um ou mais links de matérias prontas (de qualquer portal) pra se inspirar
  app.post('/api/news/from-link', json, async (req, res) => {
    const urls = ((req.body as { urls?: string[] }).urls ?? []).slice(0, 8);
    const out: Article[] = [];
    const falhas: string[] = [];
    for (const u of urls) {
      try {
        out.push(await articleFromUrl(String(u), nodeHttp));
      } catch (e) {
        falhas.push(`${u}: ${(e as Error).message}`);
      }
    }
    res.json({ articles: out, falhas });
  });

  app.post('/api/news/write', json, async (req, res) => {
    const body = req.body as { query?: string; articles?: Article[]; prompt?: string; apiKey?: string; tamanho?: 'resumido' | 'normal' | 'completo' };
    const articles = (body.articles ?? []).slice(0, 8);
    if (!articles.length) return res.status(400).json({ error: 'Escolha ao menos uma notícia.' });
    try {
      // lê o texto das matérias (as que têm link direto), em paralelo
      const texts = await Promise.all(articles.map((a) => (a.readable ? fetchArticle(a, nodeHttp) : Promise.resolve({ url: a.url, title: a.title, source: a.source, date: a.date, text: a.snippet }))));
      const k = body.apiKey?.trim() || key();
      const tam = body.tamanho === 'resumido' || body.tamanho === 'completo' ? body.tamanho : 'normal';
      const story = await writeStory(String(body.query ?? ''), texts, aiChat(k), String(body.prompt ?? '').slice(0, 1000), tam);
      const result = await withTrendingHashtags(story, texts, nodeHttp);
      res.json({ ...result, sources: texts.map((t) => ({ url: t.url, title: t.title, source: t.source, chars: t.text.length })) });
    } catch (e) {
      res.status(500).json({ error: `Falha ao escrever: ${(e as Error).message}` });
    }
  });
}
