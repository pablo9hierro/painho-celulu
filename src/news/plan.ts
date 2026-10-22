/**
 * Entender o pedido do jornalista antes de buscar (como quem digita no Google):
 * a IA transforma o texto em até 3 buscas de notícia (palavras-chave, nomes,
 * local, corrigindo erros) e decide a janela de tempo. Por padrão é notícia
 * ATUAL; só busca o passado quando o pedido diz isso. Sem IA, uma regra simples
 * faz o mesmo papel.
 */
import type { Chat } from './writer';

export type Recency = '1d' | '3d' | '7d' | '30d' | 'any';

export interface SearchPlan {
  queries: string[];
  recency: Recency;
  /** explicação curta para mostrar ao jornalista */
  note: string;
  /** ano antigo pedido explicitamente (busca só naquele ano) */
  year?: number;
  /** nomes próprios do pedido (lugar, pessoa, órgão) que a notícia precisa citar */
  names: string[];
  /** a janela veio de uma data citada no pedido (manda mais que a IA) */
  fromDate?: boolean;
  /** custo da IA para entender o pedido (US$) */
  costUsd?: number;
}

const NAME_STOP = new Set(['PM', 'A', 'O', 'E', 'De', 'Da', 'Do', 'Em', 'No', 'Na']);

/** Nomes próprios do pedido (palavras com inicial maiúscula ou siglas). */
export function namesIn(text: string): string[] {
  const out: string[] = [];
  for (const m of stripTime(text).matchAll(/\b(\p{Lu}[\p{L}-]{3,}|\p{Lu}{3,})\b/gu)) {
    const w = m[1]!;
    if (!NAME_STOP.has(w) && !out.includes(w)) out.push(w);
  }
  return out;
}

const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const RECENCIES: Recency[] = ['1d', '3d', '7d', '30d', 'any'];
const OLD_INTENT = /\b(antig[oa]s?|passad[oa]|hist[oó]ric[oa]|relembr|retrospectiva|h[aá] (anos|meses)|naquela [eé]poca|arquivo)\b/i;

/** Datas citadas no texto ("15 de outubro de 2026", "15/10/2026", "15/10"). */
function datesIn(text: string, now: Date): Date[] {
  const out: Date[] = [];
  const y0 = now.getFullYear();
  for (const m of text.matchAll(/\b(\d{1,2})\s+de\s+(janeiro|fevereiro|mar[cç]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)(?:\s+de\s+(\d{4}))?/gi)) {
    const mi = MONTHS.indexOf(m[2]!.toLowerCase().replace('marco', 'março'));
    out.push(new Date(Number(m[3] ?? y0), mi, Number(m[1])));
  }
  for (const m of text.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g)) {
    let y = Number(m[3] ?? y0);
    if (y < 100) y += 2000;
    out.push(new Date(y, Number(m[2]) - 1, Number(m[1])));
  }
  return out.filter((d) => !Number.isNaN(d.getTime()));
}

/** Tira datas e palavras de tempo do texto da busca (a janela cuida disso). */
function stripTime(text: string): string {
  return text
    .replace(/\b(\d{1,2})\s+de\s+(janeiro|fevereiro|mar[cç]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)(\s+de\s+\d{4})?/gi, ' ')
    .replace(/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, ' ')
    .replace(/\b(hoje|ontem|anteontem|agora|nesta|neste|semana passada|esta semana|essa semana|recente|recentes|atual|atuais|[uú]ltimas?)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function windowFor(days: number): Recency {
  if (days <= 1) return '1d';
  if (days <= 2) return '3d';
  if (days <= 6) return '7d';
  if (days <= 29) return '30d';
  return 'any';
}

/** Plano sem IA: busca o texto limpo, janela pelo que o texto indica (padrão: 3 dias). */
export function heuristicPlan(text: string, now = new Date()): SearchPlan {
  const q = stripTime(text) || text.trim();
  let recency: Recency = '3d';
  let note = 'notícias dos últimos 3 dias';
  let year: number | undefined;
  let fromDate = false;
  const years = [...text.matchAll(/\b(19|20)\d{2}\b/g)].map((m) => Number(m[0]));
  const oldYear = years.find((y) => y < now.getFullYear());
  if (oldYear) {
    recency = 'any';
    year = oldYear;
    note = `pedido de notícia de ${oldYear}: busca só naquele ano`;
  } else if (OLD_INTENT.test(text)) {
    recency = 'any';
    note = 'pedido de notícia antiga: sem limite de data';
  } else if (/\bhoje\b|\bagora\b/i.test(text)) {
    recency = '1d';
    note = 'notícias de hoje';
  } else {
    const ds = datesIn(text, now);
    if (ds.length) {
      const days = Math.max(...ds.map((d) => Math.ceil((now.getTime() - d.getTime()) / 864e5)));
      recency = windowFor(days + 1);
      fromDate = true;
      note = recency === 'any' ? 'data antiga citada: sem limite de data' : `data citada no pedido: janela de ${recency.replace('d', ' dias').replace('1 dias', '1 dia')}`;
    } else if (/\bontem\b/i.test(text)) {
      recency = '3d';
    }
  }
  return { queries: [q], recency, note, year, names: namesIn(text), fromDate };
}

const PLAN_PROMPT = (today: string) => `Você ajuda um jornalista a buscar notícias no Google Notícias. Hoje é ${today}.
Transforme o pedido em até 3 buscas curtas no estilo Google (palavras-chave, nomes de pessoas, órgãos, bairro, cidade, estado; corrija erros de digitação; use siglas e nomes como aparecem na imprensa, ex.: "Rocam" e "PM"). Não coloque datas dentro das buscas.
Decida a janela de tempo:
- "1d" se o pedido for de hoje/agora;
- "3d" é o padrão (notícia atual);
- "7d" ou "30d" se citar uma data/período recente que pede isso;
- "any" SÓ se o jornalista pedir explicitamente notícia antiga, de outro ano, de meses atrás ou histórica.
Responda SOMENTE com JSON: {"buscas": ["...", "..."], "recencia": "1d|3d|7d|30d|any", "explicacao": "frase curta"}`;

export async function planSearch(text: string, chat: Chat | null, now = new Date()): Promise<SearchPlan> {
  const base = heuristicPlan(text, now);
  if (!chat || !text.trim()) return base;
  try {
    const today = now.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
    const r = await chat(
      [
        { role: 'system', content: PLAN_PROMPT(today) },
        { role: 'user', content: text },
      ],
      { json: true, maxTokens: 300 },
    );
    const m = /\{[\s\S]*\}/.exec(r.content);
    const j = m ? (JSON.parse(m[0]) as { buscas?: unknown; recencia?: unknown; explicacao?: unknown }) : null;
    const queries = Array.isArray(j?.buscas)
      ? (j!.buscas as unknown[])
          .filter((q): q is string => typeof q === 'string' && q.trim().length > 1)
          .map((q) => stripTime(q) || q.trim())
          .slice(0, 3)
      : [];
    let recency = RECENCIES.includes(j?.recencia as Recency) ? (j!.recencia as Recency) : base.recency;
    // segurança: "any" só com pedido explícito de passado (a regra simples confirma)
    if (recency === 'any' && base.recency !== 'any') recency = base.recency === '1d' ? '1d' : '30d';
    // data citada no pedido: a conta do app manda (a IA às vezes amplia demais)
    if (base.fromDate || base.year) recency = base.recency;
    if (!queries.length) return base;
    // a busca original limpa entra como reserva
    if (!queries.some((q) => q.toLowerCase() === base.queries[0]!.toLowerCase())) queries.push(base.queries[0]!);
    return { ...base, costUsd: r.costUsd ?? 0, queries: queries.slice(0, 4), recency, note: base.fromDate || base.year ? base.note : typeof j?.explicacao === 'string' && j.explicacao ? j.explicacao : base.note };
  } catch {
    return base;
  }
}
