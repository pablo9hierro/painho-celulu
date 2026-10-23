/**
 * Transcrição da fala para legendas: manda o áudio (WAV 16 kHz mono, em
 * pedaços de ~1 min) para a mesma IA barata da matéria (Gemini 2.5 Flash Lite
 * pela OpenRouter ou pela chave do Google). Custa frações de centavo por minuto.
 * A IA devolve frases curtas com início/fim e QUEM fala (1, 2, 3...); as
 * pessoas são mantidas entre pedaços passando a descrição de cada voz.
 */
import { fetchPost, MODELS, providerOf, type Post } from './openrouter';
import { estimateUsd, recordAi } from './cost';

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
        const costUsd = estimateUsd(model, j?.usageMetadata?.promptTokenCount ?? 0, j?.usageMetadata?.candidatesTokenCount ?? 0);
        recordAi(costUsd, 'legendas');
        return { ...parseTranscricao(content, dur), costUsd };
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
      const costUsd = typeof u?.cost === 'number' ? u.cost : estimateUsd(model, u?.prompt_tokens ?? 0, u?.completion_tokens ?? 0);
      recordAi(costUsd, 'legendas');
      return { ...parseTranscricao(content, dur), costUsd };
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

// ---------------------------------------------------------------- sincronia pela própria voz (sem IA)

export interface Regiao {
  ini: number;
  fim: number;
}

/**
 * Onde tem voz no áudio (detector de energia em janelas de 20 ms, com limiar que
 * se adapta ao ruído/música de fundo). A IA erra o tempo em até 1-2 s; a voz não.
 */
export function speechRegions(pcm: Float32Array, rate: number, offset = 0): Regiao[] {
  const win = Math.max(1, Math.round(rate * 0.02));
  const n = Math.floor(pcm.length / win);
  if (!n) return [];
  const e = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = i * win; j < (i + 1) * win; j++) s += pcm[j]! * pcm[j]!;
    e[i] = Math.sqrt(s / win);
  }
  const sorted = [...e].sort((a, b) => a - b);
  const floor = sorted[Math.floor(n * 0.2)] ?? 0;
  const loud = sorted[Math.floor(n * 0.95)] ?? 0;
  const th = Math.max(0.004, floor + (loud - floor) * 0.18);
  const out: Regiao[] = [];
  let start = -1;
  let quiet = 0;
  for (let i = 0; i < n; i++) {
    if (e[i]! >= th) {
      if (start < 0) start = i;
      quiet = 0;
    } else if (start >= 0 && ++quiet > 12) {
      // 240 ms de silêncio fecha o trecho
      out.push({ ini: start, fim: i - quiet + 1 });
      start = -1;
      quiet = 0;
    }
  }
  if (start >= 0) out.push({ ini: start, fim: n - quiet });
  const t = win / rate;
  return out.filter((r) => (r.fim - r.ini) * t >= 0.12).map((r) => ({ ini: offset + r.ini * t, fim: offset + r.fim * t }));
}

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : 0;
};

/**
 * Encosta as frases da IA na voz de verdade. A IA acerta a ORDEM e o texto, mas
 * erra o tempo; o detector acerta o tempo da voz. Cada frase recebe um bloco de
 * trechos de voz seguidos (fronteiras sempre numa pausa), escolhendo a divisão
 * que melhor combina o tempo da IA com o tamanho de cada frase.
 */
export function alignSegments(segs: Segmento[], allRegs: Regiao[]): Segmento[] {
  const n = segs.length;
  if (!n || !allRegs.length) return segs;
  const regs = allRegs.filter((r) => r.fim >= segs[0]!.inicio - 2.5 && r.ini <= segs[n - 1]!.fim + 2.5);
  const R = regs.length;
  if (R < n) return shiftOnly(segs, regs);
  const chars = segs.map((s) => Math.max(2, s.texto.replace(/\s+/g, '').length));
  const voicedAll = regs.reduce((s, r) => s + r.fim - r.ini, 0);
  const spc = voicedAll / chars.reduce((a, b) => a + b, 0);
  const pre = [0];
  for (const r of regs) pre.push(pre[pre.length - 1]! + r.fim - r.ini);
  const voiced = (i: number, j: number) => pre[j + 1]! - pre[i]!; // trechos i..j
  // custo da frase k ocupar os trechos i..j
  const cost = (k: number, i: number, j: number) => Math.abs(regs[i]!.ini - segs[k]!.inicio) * 0.6 + Math.abs(regs[j]!.fim - segs[k]!.fim) * 0.6 + Math.abs(voiced(i, j) - chars[k]! * spc);
  // dp[k][j] = menor custo com as frases 0..k terminando no trecho j (frases podem pular trechos de ruído entre elas)
  const INF = 1e9;
  const dp = Array.from({ length: n }, () => new Float64Array(R).fill(INF));
  const from = Array.from({ length: n }, () => new Int32Array(R).fill(-1));
  const startOf = Array.from({ length: n }, () => new Int32Array(R).fill(-1));
  for (let j = 0; j < R; j++)
    for (let i = 0; i <= j; i++) {
      const c = cost(0, i, j) + i * 0.3;
      if (c < dp[0]![j]!) {
        dp[0]![j] = c;
        startOf[0]![j] = i;
      }
    }
  for (let k = 1; k < n; k++)
    for (let j = k; j < R; j++)
      for (let i = k; i <= j; i++) {
        let bestPrev = INF;
        let arg = -1;
        for (let p = k - 1; p < i; p++) {
          const v = dp[k - 1]![p]! + (i - p - 1) * 0.3; // trechos pulados (ruído) custam um pouco
          if (v < bestPrev) {
            bestPrev = v;
            arg = p;
          }
        }
        const c = bestPrev + cost(k, i, j);
        if (c < dp[k]![j]!) {
          dp[k]![j] = c;
          from[k]![j] = arg;
          startOf[k]![j] = i;
        }
      }
  let j = 0;
  for (let x = 0; x < R; x++) if (dp[n - 1]![x]! + (R - 1 - x) * 0.3 < dp[n - 1]![j]! + (R - 1 - j) * 0.3) j = x;
  const out: Segmento[] = new Array(n);
  for (let k = n - 1; k >= 0; k--) {
    const i = startOf[k]![j]!;
    out[k] = { ...segs[k]!, inicio: Math.round(regs[i]!.ini * 100) / 100, fim: Math.round(regs[j]!.fim * 100) / 100 };
    j = from[k]![j]!;
  }
  return out;
}

/** poucos trechos de voz (fala sem pausas): só corrige o atraso geral */
function shiftOnly(segs: Segmento[], regs: Regiao[]): Segmento[] {
  const onsets = regs.map((r) => r.ini);
  const deltas = segs
    .map((s) => {
      let best: number | null = null;
      for (const x of onsets) if (Math.abs(x - s.inicio) <= 2 && (best === null || Math.abs(x - s.inicio) < Math.abs(best - s.inicio))) best = x;
      return best === null ? null : best - s.inicio;
    })
    .filter((d): d is number => d !== null);
  const shift = deltas.length ? median(deltas) : 0;
  return segs.map((s) => ({ ...s, inicio: Math.max(0, s.inicio + shift), fim: Math.max(0.3, s.fim + shift) }));
}

/** tempo de cada palavra só nos trechos COM voz da frase (karaokê rente à fala). Tempos relativos ao início. */
export function wordTimesVoiced(texto: string, ini: number, fim: number, regs: Regiao[]): { w: string; t: number }[] {
  const parts = regs.map((r) => ({ a: Math.max(ini, r.ini), b: Math.min(fim, r.fim) })).filter((r) => r.b - r.a > 0.05);
  const voiced = parts.reduce((s, r) => s + r.b - r.a, 0);
  if (voiced < (fim - ini) * 0.3) return wordTimes(texto, (fim - ini) * 0.92);
  const words = texto.split(/\s+/).filter(Boolean);
  const weight = words.map((w) => 1 + w.replace(/[^\p{L}\p{N}]/gu, '').length);
  const total = weight.reduce((a, b) => a + b, 0) || 1;
  let acc = 0;
  return words.map((w, i) => {
    // posição no tempo "falado" → tempo real
    let v = (acc / total) * voiced;
    acc += weight[i]!;
    let t = parts[0]!.a;
    for (const r of parts) {
      const len = r.b - r.a;
      if (v <= len) {
        t = r.a + v;
        break;
      }
      v -= len;
      t = r.b;
    }
    return { w, t: Math.round((t - ini) * 100) / 100 };
  });
}
