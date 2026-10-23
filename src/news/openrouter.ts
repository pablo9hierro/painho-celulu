/**
 * IA que escreve a matéria: Gemini 2.5 Flash Lite (pago), por um destes caminhos,
 * escolhido automaticamente pelo formato da chave:
 * - chave da OpenRouter (sk-or-...) → google/gemini-2.5-flash-lite;
 * - chave do Google AI Studio (AIza...) → API do Gemini direto.
 * Modelo: Gemini 2.5 Flash Lite (pago); se falhar, Gemini 2.5 Flash. Nada gratuito.
 */
import type { Chat, ChatMessage } from './writer';
import { estimateUsd, recordAi } from './cost';

/** OpenRouter: Gemini 2.5 Flash Lite (escolha do usuário); reserva: Gemini 2.5 Flash, também pago */
export const MODELS = ['google/gemini-2.5-flash-lite', 'google/gemini-2.5-flash'];
/** Google direto: preferência quando não der para listar os modelos da conta */
const GOOGLE_MODELS = ['gemini-2.5-flash-lite', 'gemini-2.5-flash'];

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const GOOGLE = 'https://generativelanguage.googleapis.com/v1beta';

export type Post = (url: string, headers: Record<string, string>, body: unknown) => Promise<{ status: number; json: unknown }>;

/** POST com fetch (servidor e navegador). */
export const fetchPost: Post = async (url, headers, body) => {
  const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(90_000) });
  let json: unknown = null;
  try {
    json = await r.json();
  } catch {
    /* corpo vazio */
  }
  return { status: r.status, json };
};

export type Provider = 'openrouter' | 'google' | null;
export function providerOf(key: string): Provider {
  const k = key.trim();
  if (/^sk-or-/i.test(k)) return 'openrouter';
  if (/^AIza[0-9A-Za-z_-]{20,}$/.test(k)) return 'google';
  return k ? 'openrouter' : null;
}

export function openRouterChat(apiKey: string, post: Post = fetchPost, models = MODELS): Chat {
  return async (messages: ChatMessage[], opts = {}) => {
    const errors: string[] = [];
    for (const model of models) {
      try {
        const r = await post(
          ENDPOINT,
          { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://primeirasnoticias.com.br', 'X-Title': 'Primeiras Noticias Studio' },
          {
            model,
            messages,
            temperature: 0.3,
            max_tokens: opts.maxTokens ?? 1800,
            // pede o custo exato desta chamada
            usage: { include: true },
            ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
          },
        );
        const j = r.json as { choices?: { message?: { content?: string | null } }[]; model?: string; error?: { message?: string; code?: number }; usage?: { cost?: number; prompt_tokens?: number; completion_tokens?: number } } | null;
        if (r.status === 402 || j?.error?.code === 402) throw new Error('a OpenRouter respondeu que esta chave está sem crédito (confira se é a chave da conta com crédito)');
        if (r.status === 401) throw new Error('chave da OpenRouter inválida');
        const content = j?.choices?.[0]?.message?.content?.trim();
        if (r.status >= 200 && r.status < 300 && content) {
          const u = j?.usage;
          const costUsd = typeof u?.cost === 'number' ? u.cost : estimateUsd(model, u?.prompt_tokens ?? 0, u?.completion_tokens ?? 0);
          recordAi(costUsd, opts.label ?? 'texto');
          return { content, model: j?.model ?? model, costUsd };
        }
        errors.push(`${model}: ${j?.error?.message ?? `HTTP ${r.status}`}`);
      } catch (e) {
        // sem crédito ou chave inválida: não adianta tentar outros modelos
        if (/crédito|inválida/.test((e as Error).message)) throw e;
        errors.push(`${model}: ${(e as Error).message}`);
      }
    }
    throw new Error(errors.slice(-2).join(' | '));
  };
}

export function googleChat(apiKey: string, post: Post = fetchPost): Chat {
  return async (messages: ChatMessage[], opts = {}) => {
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const contents = messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
    const errors: string[] = [];
    for (const model of GOOGLE_MODELS) {
      try {
        const r = await post(
          `${GOOGLE}/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
          { 'Content-Type': 'application/json' },
          {
            ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
            contents,
            generationConfig: { temperature: 0.3, maxOutputTokens: opts.maxTokens ?? 1800, ...(opts.json ? { responseMimeType: 'application/json' } : {}) },
          },
        );
        const j = r.json as { candidates?: { content?: { parts?: { text?: string }[] } }[]; error?: { message?: string; status?: string }; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } } | null;
        if (r.status === 400 && /API key/i.test(j?.error?.message ?? '')) throw new Error('chave do Google inválida');
        if (r.status === 403) throw new Error('chave do Google sem permissão para o Gemini (ative a API ou o faturamento)');
        const content = j?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('').trim();
        if (r.status >= 200 && r.status < 300 && content) {
          const costUsd = estimateUsd(model, j?.usageMetadata?.promptTokenCount ?? 0, j?.usageMetadata?.candidatesTokenCount ?? 0);
          recordAi(costUsd, opts.label ?? 'texto');
          return { content, model: `google/${model}`, costUsd };
        }
        errors.push(`${model}: ${j?.error?.message ?? `HTTP ${r.status}`}`);
      } catch (e) {
        if (/inválida|permissão/.test((e as Error).message)) throw e;
        errors.push(`${model}: ${(e as Error).message}`);
      }
    }
    throw new Error(errors.slice(-2).join(' | '));
  };
}

/** Escritor certo para a chave informada (ou null sem chave). */
export function aiChat(key: string, post: Post = fetchPost): Chat | null {
  const p = providerOf(key);
  if (p === 'google') return googleChat(key.trim(), post);
  if (p === 'openrouter') return openRouterChat(key.trim(), post);
  return null;
}
