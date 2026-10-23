/**
 * "Qual dessas matérias vai engajar melhor no Instagram?": antes de postar,
 * olha o engajamento REAL do Instagram (não é só visualização no nosso site)
 * nas hashtags do assunto de cada candidata, e usa isso para desempatar.
 *
 * A busca de hashtag (ig_hashtag_search) só permite 30 consultas NOVAS por
 * semana por conta — por isso o id de cada hashtag é guardado para sempre, e
 * o uso da cota (consultas novas nos últimos 7 dias) é controlado aqui. Sem
 * cota ou sem token, a função some do ranking sozinha (cai só no desempenho do
 * nosso blog, que é o que já funcionava).
 */
import type { IgConfig, IgHttp } from './instagram';

const base = (c: IgConfig) => (/^IGAA/i.test(c.token) ? 'https://graph.instagram.com/v21.0' : 'https://graph.facebook.com/v21.0');

const IDS_KEY = 'pn-ig-hashtag-ids';
const QUOTA_KEY = 'pn-ig-hashtag-cota';
const QUOTA_SEMANA = 30;

function loadIds(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(IDS_KEY) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}
function saveIds(v: Record<string, string>) {
  try {
    localStorage.setItem(IDS_KEY, JSON.stringify(v));
  } catch {
    /* sem armazenamento */
  }
}
function quotaLivre(): boolean {
  try {
    const usos = (JSON.parse(localStorage.getItem(QUOTA_KEY) ?? '[]') as number[]).filter((t) => Date.now() - t < 7 * 24 * 3600_000);
    localStorage.setItem(QUOTA_KEY, JSON.stringify(usos));
    return usos.length < QUOTA_SEMANA;
  } catch {
    return true;
  }
}
function gastarCota() {
  try {
    const usos = (JSON.parse(localStorage.getItem(QUOTA_KEY) ?? '[]') as number[]).filter((t) => Date.now() - t < 7 * 24 * 3600_000);
    localStorage.setItem(QUOTA_KEY, JSON.stringify([...usos, Date.now()]));
  } catch {
    /* sem armazenamento */
  }
}

const foldTag = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

async function hashtagId(http: IgHttp, c: IgConfig, palavra: string): Promise<string | null> {
  const key = foldTag(palavra);
  if (!key) return null;
  const ids = loadIds();
  if (ids[key]) return ids[key]!;
  if (!quotaLivre()) return null;
  try {
    const j = (await http.get(`${base(c)}/ig_hashtag_search?user_id=${c.userId}&q=${encodeURIComponent(key)}&access_token=${encodeURIComponent(c.token)}`)) as { data?: { id: string }[] };
    gastarCota();
    const id = j.data?.[0]?.id;
    if (!id) return null;
    saveIds({ ...loadIds(), [key]: id }); // lê de novo: evita perder o id salvo por outra busca em paralelo
    return id;
  } catch {
    return null;
  }
}

/** Engajamento médio (curtida + 3×comentário, pelos posts recentes) da hashtag: "quão quente está o assunto" agora. */
async function hashtagHeat(http: IgHttp, c: IgConfig, palavra: string): Promise<number | null> {
  const id = await hashtagId(http, c, palavra);
  if (!id) return null;
  try {
    const j = (await http.get(`${base(c)}/${id}/recent_media?user_id=${c.userId}&fields=like_count,comments_count&limit=12&access_token=${encodeURIComponent(c.token)}`)) as {
      data?: { like_count?: number; comments_count?: number }[];
    };
    const posts = j.data ?? [];
    if (!posts.length) return null;
    return posts.reduce((s, p) => s + (p.like_count ?? 0) + (p.comments_count ?? 0) * 3, 0) / posts.length;
  } catch {
    return null;
  }
}

/** Palavra-chave mais forte da matéria para medir o assunto (cidade/categoria/1ª palavra-chave). */
export function keyEngagementWord(categoria: string, city: string | null | undefined, palavras: string[]): string {
  return (city || palavras[0] || categoria || '').trim();
}

/**
 * Entre as candidatas (já boas pelo nosso site), pede ao Instagram qual tema
 * está mais quente agora e devolve a ordenada por esse engajamento (maior
 * primeiro). Sem token/cota/sinal, devolve a lista na mesma ordem (quem chamou
 * decide o desempate pelo nosso próprio desempenho).
 */
export async function reorderByIgHeat<T>(http: IgHttp, c: IgConfig, items: T[], wordOf: (x: T) => string, max = 3): Promise<{ item: T; heat: number | null }[]> {
  const top = items.slice(0, max);
  const rest = items.slice(max).map((item) => ({ item, heat: null as number | null }));
  const withHeat = await Promise.all(top.map(async (item) => ({ item, heat: await hashtagHeat(http, c, wordOf(item)).catch(() => null) })));
  const known = withHeat.filter((x) => x.heat !== null);
  if (!known.length) return [...withHeat, ...rest];
  known.sort((a, b) => b.heat! - a.heat!);
  const unknown = withHeat.filter((x) => x.heat === null);
  return [...known, ...unknown, ...rest];
}
