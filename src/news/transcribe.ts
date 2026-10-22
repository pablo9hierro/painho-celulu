/**
 * Transcrição da fala para legendas: manda o áudio (WAV 16 kHz mono, em
 * pedaços de ~1 min) para a mesma IA barata da matéria (Gemini 2.5 Flash Lite
 * pela OpenRouter ou pela chave do Google). Custa frações de centavo por minuto.
 * A IA devolve frases curtas com início/fim e QUEM fala (1, 2, 3...); as
 * pessoas são mantidas entre pedaços passando a descrição de cada voz.
 */
import { fetchPost, MODELS, providerOf, type Post } from './openrouter';
import { estimateUsd } from './cost';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const GOOGLE = 'https://generativelanguage.googleapis.com/v1beta';

export interface Segmento {
  falante: number;
  inicio: number;
  fim: number;
  texto: string;
}
export interface Falante {
  id: number;
  voz: string;
}
export interface Transcricao {
  segmentos: Segmento[];
  falantes: Falante[];
  costUsd: number;
}

function prompt(dur: number, falantes: Falante[]): string {
  return [
    'Transcreva EXATAMENTE a fala deste áudio em português do Brasil, como legenda de vídeo.',
    `O áudio tem ${dur.toFixed(1)} segundos. Divida em frases curtas (no máximo 8 palavras cada), na ordem em que são faladas.`,
    'Para cada frase dê "inicio" e "fim" em segundos (com uma casa decimal) a partir do começo deste áudio, o mais preciso possível.',
    'Identifique quem fala: cada pessoa diferente recebe um número (1, 2, 3...). Se só uma pessoa fala, use sempre 1.',
    falantes.length
      ? `Pessoas já identificadas nos trechos anteriores (mantenha o mesmo número para a mesma voz): ${falantes.map((f) => `${f.id} = ${f.voz}`).join('; ')}.`
      : '',
    'Não invente fala: trechos só com música ou silêncio ficam de fora. Pontuação normal, sem tudo em maiúsculas.',
    'Responda só JSON: {"segmentos":[{"falante":1,"inicio":0.0,"fim":2.4,"texto":"..."}],"falantes":[{"id":1,"voz":"descrição curta da voz, ex.: homem, voz grave"}]}',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Lê o JSON da IA e arruma tempos fora da ordem ou do áudio. */
export function parseTranscricao(raw: string, dur: number): { segmentos: Segmento[]; falantes: Falante[] } {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return { segmentos: [], falantes: [] };
  let j: { segmentos?: Partial<Segmento>[]; falantes?: Partial<Falante>[] };
  try {
    j = JSON.parse(m[0]);
  } catch {
    return { segmentos: [], falantes: [] };
  }
  const segs: Segmento[] = [];
  let last = 0;
  for (const s of j.segmentos ?? []) {
    const texto = String(s.texto ?? '').replace(/\s+/g, ' ').trim();
    if (!texto) continue;
    let inicio = Number(s.inicio);
    let fim = Number(s.fim);
    if (!Number.isFinite(inicio)) inicio = last;
    inicio = Math.min(Math.max(inicio, last), dur);
    if (!Number.isFinite(fim) || fim <= inicio) fim = inicio + Math.max(0.8, texto.split(' ').length * 0.35);
    fim = Math.min(fim, dur);
    if (fim - inicio < 0.3) continue;
    const falante = Math.min(9, Math.max(1, Math.round(Number(s.falante) || 1)));
    segs.push({ falante, inicio, fim, texto });
    last = fim;
  }
  const falantes = (j.falantes ?? [])
    .map((f) => ({ id: Math.min(9, Math.max(1, Math.round(Number(f.id) || 1))), voz: String(f.voz ?? '').slice(0, 80) }))
    .filter((f) => f.voz);
  return { segmentos: segs, falantes };
}

/** Transcreve um pedaço de WAV (base64). */
export async function transcribeWav(key: string, wavB64: string, dur: number, falantes: Falante[] = [], post: Post = fetchPost): Promise<Transcricao> {
  const k = key.trim();
  const text = prompt(dur, falantes);
  const errors: string[] = [];
  if (providerOf(k) === 'google') {
    for (const model of ['gemini-2.5-flash-lite', 'gemini-2.5-flash']) {
      const r = await post(`${GOOGLE}/models/${model}:generateContent?key=${encodeURIComponent(k)}`, { 'Content-Type': 'application/json' }, {
        contents: [{ role: 'user', parts: [{ text }, { inline_data: { mime_type: 'audio/wav', data: wavB64 } }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 4000, responseMimeType: 'application/json' },
      });
      const j = r.json as { candidates?: { content?: { parts?: { text?: string }[] } }[]; error?: { message?: string }; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } } | null;
      const content = j?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
      if (r.status >= 200 && r.status < 300 && content) {
        return { ...parseTranscricao(content, dur), costUsd: estimateUsd(model, j?.usageMetadata?.promptTokenCount ?? 0, j?.usageMetadata?.candidatesTokenCount ?? 0) };
      }
      errors.push(`${model}: ${j?.error?.message ?? `HTTP ${r.status}`}`);
    }
    throw new Error(errors.join(' | '));
  }
  for (const model of MODELS) {
    const r = await post(
      ENDPOINT,
      { Authorization: `Bearer ${k}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://primeirasnoticias.com.br', 'X-Title': 'Primeiras Noticias Studio' },
      {
        model,
        messages: [{ role: 'user', content: [{ type: 'text', text }, { type: 'input_audio', input_audio: { data: wavB64, format: 'wav' } }] }],
        temperature: 0,
        max_tokens: 4000,
        usage: { include: true },
        response_format: { type: 'json_object' },
      },
    );
    const j = r.json as { choices?: { message?: { content?: string | null } }[]; error?: { message?: string; code?: number }; usage?: { cost?: number; prompt_tokens?: number; completion_tokens?: number } } | null;
    if (r.status === 402 || j?.error?.code === 402) throw new Error('a OpenRouter respondeu que esta chave está sem crédito');
    if (r.status === 401) throw new Error('chave da OpenRouter inválida');
    const content = j?.choices?.[0]?.message?.content ?? '';
    if (r.status >= 200 && r.status < 300 && content) {
      const u = j?.usage;
      return { ...parseTranscricao(content, dur), costUsd: typeof u?.cost === 'number' ? u.cost : estimateUsd(model, u?.prompt_tokens ?? 0, u?.completion_tokens ?? 0) };
    }
    errors.push(`${model}: ${j?.error?.message ?? `HTTP ${r.status}`}`);
  }
  throw new Error(errors.join(' | '));
}

/** Tempo de cada palavra dentro da frase (proporcional ao tamanho da palavra). */
export function wordTimes(texto: string, dur: number): { w: string; t: number }[] {
  const words = texto.split(/\s+/).filter(Boolean);
  const weight = words.map((w) => 1 + w.replace(/[^\p{L}\p{N}]/gu, '').length);
  const total = weight.reduce((a, b) => a + b, 0) || 1;
  let acc = 0;
  return words.map((w, i) => {
    const t = (acc / total) * dur;
    acc += weight[i]!;
    return { w, t: Math.round(t * 100) / 100 };
  });
}

/** Quebra frases longas em pedaços de até `max` palavras (mantém o tempo proporcional). */
export function splitSegments(segs: Segmento[], max = 7): Segmento[] {
  const out: Segmento[] = [];
  for (const s of segs) {
    const words = s.texto.split(/\s+/).filter(Boolean);
    if (words.length <= max) {
      out.push(s);
      continue;
    }
    const parts = Math.ceil(words.length / max);
    const per = Math.ceil(words.length / parts);
    const times = wordTimes(s.texto, s.fim - s.inicio);
    for (let i = 0; i < words.length; i += per) {
      const a = s.inicio + times[i]!.t;
      const b = i + per < words.length ? s.inicio + times[i + per]!.t : s.fim;
      out.push({ falante: s.falante, inicio: a, fim: b, texto: words.slice(i, i + per).join(' ') });
    }
  }
  return out;
}
