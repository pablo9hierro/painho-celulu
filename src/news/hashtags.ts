/**
 * Escolhe as 5 hashtags da matéria olhando o que está em alta agora:
 * candidatas = hashtags sugeridas pela IA + hashtags em alta que combinam com o
 * assunto + nomes principais da própria matéria; cada uma é conferida (quanto
 * está sendo falada nas últimas 48 h) e ficam as 5 mais fortes e pertinentes.
 */
import type { ArticleText } from './search';
import { toHashtag, type HashtagRank } from './trends';

export interface HashtagPick {
  tag: string;
  /** por que entrou (para mostrar ao jornalista) */
  why: string;
  score: number;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** "#CorinthiansXCaracas" → "corinthians x caracas" */
const words = (tag: string) => norm(tag.replace(/^#/, '').replace(/([a-zà-ú0-9])([A-ZÀ-Ú])/g, '$1 $2'));

const STOP = new Set(['segundo', 'creditos', 'fonte', 'nesta', 'neste', 'nesse', 'nessa', 'apos', 'durante']);

/** Nomes próprios mais citados no corpo da matéria. */
function entities(text: string): string[] {
  const body = text
    .split('\n')
    .slice(1)
    .filter((l) => !/^\s*(#|cr[ée]ditos|fontes?)/i.test(l))
    .join(' ');
  const out = new Map<string, number>();
  const ws = body.split(/\s+/);
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i]!.replace(/[^\p{L}\p{N}-]/gu, '');
    if (!/^\p{Lu}\p{Ll}/u.test(w) || STOP.has(norm(w))) continue;
    if (i > 0 && /[.:!?]$/.test(ws[i - 1]!)) continue; // início de frase
    let p = w;
    while (i + 1 < ws.length && !/[.,;:!?)]$/.test(ws[i]!)) {
      const nx = ws[i + 1]!.replace(/[^\p{L}\p{N}-]/gu, '');
      if (/^\p{Lu}/u.test(nx)) {
        p += ' ' + nx;
        i++;
      } else break;
    }
    if (p.length >= 4) out.set(p, (out.get(p) ?? 0) + 1);
  }
  return [...out.entries()].sort((a, b) => b[1] - a[1]).map(([e]) => e);
}

export async function pickHashtags(
  text: string,
  sources: ArticleText[],
  trending: HashtagRank[],
  lookup: ((tag: string) => Promise<number>) | null,
  count = 5,
): Promise<HashtagPick[]> {
  // só vale hashtag em alta se o assunto estiver no texto da própria matéria
  const corpus = norm(
    text
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join(' '),
  );
  void sources; // fontes ficam para uso futuro (a escolha olha só o texto final)
  const cands = new Map<string, HashtagPick>();
  const add = (tag: string, score: number, why: string) => {
    if (!tag || tag.length < 3) return;
    const k = tag.toLowerCase();
    const cur = cands.get(k);
    if (cur) {
      cur.score += score;
      if (!cur.why.includes(why)) cur.why += ` · ${why}`;
    } else cands.set(k, { tag, score, why });
  };
  // 1) as que a IA sugeriu
  for (const m of text.matchAll(/#[\p{L}\p{N}_]+/gu)) add(m[0], 12, 'sugerida pela IA');
  // 2) em alta agora e com a ver com a matéria
  const maxT = Math.max(1, ...trending.map((t) => t.score));
  for (const t of trending) {
    const w = words(t.tag);
    if (w.length >= 3 && corpus.includes(w)) add(t.tag, 20 + 40 * (t.score / maxT), 'em alta agora');
  }
  // 3) nomes principais da matéria
  entities(text)
    .slice(0, 6)
    .forEach((e, i) => add(toHashtag(e), 14 - i * 2, 'assunto da matéria'));
  // confere o quanto cada candidata está sendo falada (até 8, em paralelo)
  const list = [...cands.values()].sort((a, b) => b.score - a.score);
  if (lookup) {
    await Promise.all(
      list.slice(0, 8).map(async (c) => {
        try {
          const n = await Promise.race([lookup(c.tag), new Promise<number>((r) => setTimeout(() => r(-1), 6000))]);
          if (n >= 0) {
            c.score += Math.min(30, n);
            c.why += ` · ${n} notícias em 48 h`;
          }
        } catch {
          /* sem conferência para esta */
        }
      }),
    );
  }
  list.sort((a, b) => b.score - a.score);
  const picked = list.slice(0, count);
  // completa até 5 com hashtags gerais de jornalismo, se faltar
  for (const g of ['#Notícias', '#Brasil', '#Jornalismo', '#Urgente', '#PrimeirasNotícias']) {
    if (picked.length >= count) break;
    if (!picked.some((p) => p.tag.toLowerCase() === g.toLowerCase())) picked.push({ tag: g, why: 'geral', score: 0 });
  }
  return picked;
}

/** Troca a linha de hashtags da legenda pelas escolhidas (mantém créditos e o resto). */
export function applyHashtags(text: string, tags: string[]): string {
  const lines = text.split('\n').filter((l) => !/^\s*#/.test(l));
  return `${lines.join('\n').trim()}\n\n${tags.join(' ')}`;
}

/** Último passo da matéria: troca as hashtags pelas 5 escolhidas com base no que está em alta. */
export async function withTrendingHashtags<T extends { text: string; steps: string[] }>(r: T, texts: ArticleText[], http: import('./search').Http): Promise<T & { hashtags: HashtagPick[] }> {
  if (!r.text) return { ...r, hashtags: [] };
  const { cachedTrends, lookupHashtag } = await import('./trends');
  let trending: HashtagRank[] = [];
  try {
    trending = (await cachedTrends(http, 600_000)).hashtags;
  } catch {
    /* sem trends: escolhe pelo assunto */
  }
  try {
    const picks = await pickHashtags(r.text, texts, trending, (tag) => lookupHashtag(tag, http).then((x) => x.recent));
    return { ...r, text: applyHashtags(r.text, picks.map((p) => p.tag)), hashtags: picks, steps: [...r.steps, `Hashtags: ${picks.map((p) => p.tag).join(' ')}`] };
  } catch {
    return { ...r, hashtags: [] };
  }
}
