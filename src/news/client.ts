/**
 * Ponte da tela de Postagem com o "back-end" de notícias:
 * - PC: servidor Node (/api/news), onde fica a chave da IA (.env.local);
 * - app Android: camada nativa (CapacitorHttp, sem bloqueio do navegador),
 *   com a chave guardada no próprio aparelho.
 */
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { articleFromUrl, fetchArticle, searchRecent, type Article, type ArticleText, type Http, type Window } from './search';
import { planSearch, type SearchPlan } from './plan';
import { writeStory, type StoryResult } from './writer';
import { aiChat } from './openrouter';
import { cachedTrends, lookupHashtag, type HashtagLookup, type TrendsResult } from './trends';
import { withTrendingHashtags, type HashtagPick } from './hashtags';
import { usdBrl, type Fx } from './cost';

const KEY_STORE = 'pn-ai-key';
export const native = Capacitor.isNativePlatform();
const UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36';

export function getAiKey(): string {
  try {
    return localStorage.getItem(KEY_STORE) ?? '';
  } catch {
    return '';
  }
}
export function setAiKey(k: string) {
  try {
    if (k.trim()) localStorage.setItem(KEY_STORE, k.trim());
    else localStorage.removeItem(KEY_STORE);
  } catch {
    /* sem armazenamento */
  }
}

export const nativeHttp: Http = {
  async getText(url) {
    const r = await CapacitorHttp.get({ url, headers: { 'User-Agent': UA, 'Accept-Language': 'pt-BR,pt;q=0.9' }, responseType: 'text', connectTimeout: 12_000, readTimeout: 15_000 });
    return { status: r.status, text: typeof r.data === 'string' ? r.data : JSON.stringify(r.data), url: r.url || url };
  },
};

export const nativePost = async (url: string, headers: Record<string, string>, body: unknown) => {
  const r = await CapacitorHttp.post({ url, headers, data: body, connectTimeout: 15_000, readTimeout: 90_000 });
  let json = r.data as unknown;
  if (typeof json === 'string') {
    try {
      json = JSON.parse(json);
    } catch {
      /* deixa como texto */
    }
  }
  return { status: r.status, json };
};

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  let r: Response;
  try {
    r = await fetch(url, init);
  } catch {
    throw new Error('Sem conexão com o servidor do app no PC. Ele está rodando?');
  }
  const j = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(j.error ?? `Erro ${r.status}`);
  return j;
}

/** A IA está pronta para escrever? (chave no servidor do PC ou no aparelho) */
export async function aiReady(): Promise<boolean> {
  if (getAiKey()) return true;
  if (native) return false;
  try {
    return (await api<{ ai: boolean }>('/api/news/config')).ai;
  } catch {
    return false;
  }
}

export async function getFx(): Promise<Fx> {
  if (native)
    return usdBrl(async (url) => {
      const r = await CapacitorHttp.get({ url, connectTimeout: 10_000, readTimeout: 10_000 });
      return typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
    });
  try {
    return await api<Fx>('/api/fx');
  } catch {
    return usdBrl(async () => {
      throw new Error('sem cotação');
    });
  }
}

export type NewsPlan = SearchPlan & { used: Window; missing?: string[] };

export async function findNews(query: string): Promise<{ articles: Article[]; plan: NewsPlan | null }> {
  if (native) {
    const plan = await planSearch(query, aiChat(getAiKey(), nativePost));
    const r = await searchRecent(plan.queries, plan.recency, nativeHttp, 20, { year: plan.year, names: plan.names });
    return { articles: r.articles, plan: { ...plan, used: r.window, missing: r.missing } };
  }
  const r = await api<{ articles: Article[]; plan?: NewsPlan }>(`/api/news?q=${encodeURIComponent(query)}`);
  return { articles: r.articles, plan: r.plan ?? null };
}

/** O jornalista colou um ou mais links de matérias prontas: lê cada um pra usar de inspiração. */
export async function findFromLinks(urls: string[]): Promise<{ articles: Article[]; falhas: string[] }> {
  const list = urls.map((u) => u.trim()).filter(Boolean);
  if (native) {
    const articles: Article[] = [];
    const falhas: string[] = [];
    for (const u of list) {
      try {
        articles.push(await articleFromUrl(u, nativeHttp));
      } catch (e) {
        falhas.push(`${u}: ${(e as Error).message}`);
      }
    }
    return { articles, falhas };
  }
  return api<{ articles: Article[]; falhas: string[] }>('/api/news/from-link', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ urls: list }),
  });
}

export async function findTrends(refresh = false): Promise<TrendsResult> {
  if (native) return cachedTrends(nativeHttp, 180_000, refresh);
  return api<TrendsResult>(`/api/trends${refresh ? '?refresh=1' : ''}`);
}

export async function findHashtag(tag: string): Promise<HashtagLookup> {
  if (native) return lookupHashtag(tag, nativeHttp);
  return api<HashtagLookup>(`/api/trends/hashtag?tag=${encodeURIComponent(tag)}`);
}

export type WriteResult = StoryResult & { sources: { url: string; title: string; source: string; chars: number }[]; hashtags?: HashtagPick[] };

export async function writeFromNews(query: string, articles: Article[], prompt: string): Promise<WriteResult> {
  if (native) {
    const texts: ArticleText[] = await Promise.all(articles.map((a) => (a.readable ? fetchArticle(a, nativeHttp) : Promise.resolve({ url: a.url, title: a.title, source: a.source, date: a.date, text: a.snippet }))));
    const key = getAiKey();
    const r = await withTrendingHashtags(await writeStory(query, texts, aiChat(key, nativePost), prompt), texts, nativeHttp);
    return { ...r, sources: texts.map((t) => ({ url: t.url, title: t.title, source: t.source, chars: t.text.length })) };
  }
  return api<WriteResult>('/api/news/write', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, articles, prompt, apiKey: getAiKey() || undefined }),
  });
}
