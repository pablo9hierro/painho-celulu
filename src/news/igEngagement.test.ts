import { beforeEach, describe, expect, it } from 'vitest';
import { keyEngagementWord, reorderByIgHeat } from './igEngagement';
import type { IgHttp } from './instagram';

const mem = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};

describe('engajamento do Instagram no desempate do Reels', () => {
  beforeEach(() => mem.clear());

  it('palavra do assunto: cidade > palavra-chave > categoria', () => {
    expect(keyEngagementWord('Policial', 'Bayeux', ['assalto'])).toBe('Bayeux');
    expect(keyEngagementWord('Policial', null, ['assalto'])).toBe('assalto');
    expect(keyEngagementWord('Policial', null, [])).toBe('Policial');
  });

  it('busca o id da hashtag, mede o engajamento recente e reordena (mais quente primeiro)', async () => {
    const calls: string[] = [];
    const http: IgHttp = {
      async get(url) {
        calls.push(url);
        if (url.includes('ig_hashtag_search')) {
          const q = /q=([^&]+)/.exec(url)![1];
          return { data: [{ id: `id-${q}` }] };
        }
        if (url.includes('id-quente')) return { data: [{ like_count: 900, comments_count: 100 }, { like_count: 800, comments_count: 50 }] };
        if (url.includes('id-fria')) return { data: [{ like_count: 2, comments_count: 0 }] };
        return { data: [] };
      },
      async post() {
        return {};
      },
      async upload() {
        return {};
      },
    };
    const items = [{ id: 1, tema: 'quente' }, { id: 2, tema: 'fria' }];
    const r = await reorderByIgHeat(http, { userId: 'u', token: 'EAA' }, items, (x) => x.tema);
    expect(r[0]!.item.tema).toBe('quente');
    expect(r[0]!.heat).toBeGreaterThan(r[1]!.heat!);
    // 2ª chamada reusa o id da hashtag (cache): não busca ig_hashtag_search de novo
    calls.length = 0;
    await reorderByIgHeat(http, { userId: 'u', token: 'EAA' }, items, (x) => x.tema);
    expect(calls.filter((c) => c.includes('ig_hashtag_search'))).toHaveLength(0);
  });

  it('sem token/sinal ou cota estourada, devolve a lista como veio (quem chamou decide)', async () => {
    const http: IgHttp = {
      async get() {
        throw new Error('sem internet');
      },
      async post() {
        return {};
      },
      async upload() {
        return {};
      },
    };
    const items = [{ a: 1 }, { a: 2 }];
    const r = await reorderByIgHeat(http, { userId: 'u', token: 'EAA' }, items, () => 'x');
    expect(r.map((x) => x.item)).toEqual(items);
    expect(r.every((x) => x.heat === null)).toBe(true);
  });

  it('a cota de busca de hashtag é limitada a 30 por semana (não gasta mais que isso)', async () => {
    let buscas = 0;
    const http: IgHttp = {
      async get(url) {
        if (url.includes('ig_hashtag_search')) {
          buscas++;
          return { data: [{ id: `id-${buscas}` }] };
        }
        return { data: [{ like_count: 1, comments_count: 0 }] };
      },
      async post() {
        return {};
      },
      async upload() {
        return {};
      },
    };
    for (let i = 0; i < 35; i++) await reorderByIgHeat(http, { userId: 'u', token: 'EAA' }, [{ a: i }], (x) => `tema${x.a}`);
    expect(buscas).toBeLessThanOrEqual(30);
  });
});
