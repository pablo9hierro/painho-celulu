/**
 * Custos da IA em reais. A OpenRouter informa o custo exato (em dólar) de cada
 * chamada; com a chave do Google, o custo é calculado pelos tokens e pela
 * tabela de preço do Gemini. A cotação do dólar vem da AwesomeAPI (pública e
 * gratuita); sem ela, usa um valor aproximado (e avisa).
 */

/** preço por 1 milhão de tokens (US$): entrada, saída */
export const PRICES: Record<string, [number, number]> = {
  'gemini-2.5-flash-lite': [0.1, 0.4],
  'gemini-2.5-flash': [0.3, 2.5],
};

export function estimateUsd(model: string, inTokens: number, outTokens: number): number {
  const key = Object.keys(PRICES).find((k) => model.replace(/^google\//, '') === k) ?? 'gemini-2.5-flash-lite';
  const [pi, po] = PRICES[key]!;
  return (inTokens * pi + outTokens * po) / 1e6;
}

export interface Fx {
  /** reais por 1 dólar */
  rate: number;
  /** quando a cotação foi tirada */
  at: string;
  /** true = valor aproximado (cotação indisponível) */
  approx: boolean;
}

/** usado só se a cotação ao vivo falhar */
export const FALLBACK_RATE = 5.1;

let cache: { at: number; fx: Fx } | null = null;

export async function usdBrl(getJson: (url: string) => Promise<unknown>): Promise<Fx> {
  if (cache && Date.now() - cache.at < 3600_000) return cache.fx;
  try {
    const j = (await getJson('https://economia.awesomeapi.com.br/json/last/USD-BRL')) as { USDBRL?: { bid?: string; create_date?: string } };
    const rate = Number(j?.USDBRL?.bid);
    if (rate > 1 && rate < 20) {
      const fx = { rate, at: j.USDBRL!.create_date ?? new Date().toISOString(), approx: false };
      cache = { at: Date.now(), fx };
      return fx;
    }
  } catch {
    /* cai no aproximado */
  }
  return { rate: FALLBACK_RATE, at: new Date().toISOString(), approx: true };
}

/** "R$ 0,0123" (mais casas quando o valor é muito pequeno) */
export function brl(usd: number, rate: number): string {
  const v = usd * rate;
  const digits = v === 0 ? 2 : v < 0.01 ? 4 : 2;
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/**
 * Gasto com IA neste aparelho: total acumulado (guardado) e desta sessão (desde
 * que o app abriu), por função. Toda chamada de IA feita no aparelho entra aqui
 * sozinha (recordAi); o que roda no servidor do PC entra pelo addSpend da tela.
 */
const KEY = 'pn-ai-spend';
export interface Spend {
  usd: number;
  uses: number;
  /** desta sessão */
  sessionUsd: number;
  sessionUses: number;
  /** total por função (ex.: "legendas", "matéria", "post em vídeo") */
  by: Record<string, number>;
}
let session = { usd: 0, uses: 0 };
const inBrowser = () => typeof window !== 'undefined' && typeof localStorage !== 'undefined';
const isNativeApp = () => inBrowser() && !!(window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.();

/** registra uma chamada de IA feita NESTE aparelho */
export function recordAi(usd: number, what = 'outros'): Spend {
  if (!inBrowser()) return emptySpend();
  const cur = getSpend();
  const v = Math.max(0, usd || 0);
  session = { usd: session.usd + v, uses: session.uses + 1 };
  const next = { usd: cur.usd + v, uses: cur.uses + 1, by: { ...cur.by, [what]: (cur.by[what] ?? 0) + v } };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* sem armazenamento */
  }
  const s = { ...next, sessionUsd: session.usd, sessionUses: session.uses };
  window.dispatchEvent(new CustomEvent('pn-ai-spend', { detail: s }));
  return s;
}
const emptySpend = (): Spend => ({ usd: 0, uses: 0, sessionUsd: 0, sessionUses: 0, by: {} });

/** custo que veio do servidor (PC). No celular a chamada já foi registrada pelo recordAi. */
export function addSpend(usd: number, what = 'matéria'): Spend {
  if (isNativeApp()) return getSpend();
  return recordAi(usd, what);
}
export function getSpend(): Spend {
  try {
    const j = JSON.parse(localStorage.getItem(KEY) ?? '{}') as { usd?: number; uses?: number; by?: Record<string, number> };
    return { usd: Number(j.usd) || 0, uses: Number(j.uses) || 0, sessionUsd: session.usd, sessionUses: session.uses, by: j.by && typeof j.by === 'object' ? j.by : {} };
  } catch {
    return emptySpend();
  }
}
