/**
 * Legendas automáticas no editor: mixa o áudio do projeto (do jeito que vai
 * sair no vídeo, com cortes e velocidade), manda em pedaços de 1 min para a
 * IA transcrever (o texto) e encosta cada frase na voz de verdade (o tempo).
 *
 * UM item de legenda por bloco de vídeo (do mesmo tamanho dele e AGRUPADO com
 * ele: arrastou o vídeo, a legenda vai junto). Dentro do item ficam todas as
 * frases com o tempo de cada palavra; na tela aparece só a frase da hora.
 * Dá para gerar do projeto todo ou só de um trecho (Ajustes do vídeo).
 */
import type { AudioClip, Caption, Clip, MediaAsset, Project, TextClip, VideoClip } from '../core/model';
import { createTextClip } from '../core/factory';
import { clipEnd, newTrack, placeClip, projectDuration } from '../core/timeline';
import { uid } from '../core/id';
import { mixAudioWindows } from '../engine/webcodecsExporter';
import { getAiKey } from '../news/client';
import { speechRegions, transcribeWav, type Falante, type Regiao, type Segmento } from '../news/transcribe';
import { getEditor } from '../state/store';
import { frases, type Frase, type PalavraTempo } from '../news/frases';
import { relogioPalavras } from '../platform/whisper';
export { frases, type Frase };

export const CAPTION_PRESET = 'pn-legenda';
export type CaptionLook = Caption['look'];
const RATE = 16_000;
const CHUNK_S = 60;

/** filtro passa-baixa (sinc com janela de Hann) para a taxa de entrada, guardado por taxa */
const filtros = new Map<number, Float32Array>();
function passaBaixa(ratio: number): Float32Array {
  let h = filtros.get(ratio);
  if (h) return h;
  const H = 32;
  const fc = 0.45 / ratio; // corta em ~7,2 kHz (abaixo da metade de 16 kHz)
  h = new Float32Array(2 * H + 1);
  let soma = 0;
  for (let k = 0; k <= 2 * H; k++) {
    const x = k - H;
    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    h[k] = sinc * (0.5 + 0.5 * Math.cos((Math.PI * x) / (H + 1)));
    soma += h[k]!;
  }
  for (let k = 0; k < h.length; k++) h[k]! /= soma;
  filtros.set(ratio, h);
  return h;
}

/**
 * 48 kHz estéreo → 16 kHz mono, com filtro passa-baixa de verdade antes de
 * reduzir: sem ele o chiado agudo "dobra" para dentro da voz e o ouvinte
 * (Whisper) pula palavras.
 */
function toMono16k(buf: AudioBuffer): Float32Array {
  const ratio = buf.sampleRate / RATE;
  const n = Math.floor(buf.length / ratio);
  const out = new Float32Array(n);
  const chans = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i));
  const mono = new Float32Array(buf.length);
  for (const c of chans) for (let j = 0; j < buf.length; j++) mono[j]! += c[j]! / chans.length;
  if (ratio <= 1) {
    for (let i = 0; i < n; i++) out[i] = mono[Math.min(buf.length - 1, Math.round(i * ratio))]!;
    return out;
  }
  const h = passaBaixa(ratio);
  const H = (h.length - 1) / 2;
  for (let i = 0; i < n; i++) {
    const c = Math.round(i * ratio);
    let s = 0;
    const k0 = Math.max(0, H - c);
    const k1 = Math.min(h.length - 1, buf.length - 1 - c + H);
    for (let k = k0; k <= k1; k++) s += h[k]! * mono[c + k - H]!;
    out[i] = s;
  }
  return out;
}

export function wavBase64(pcm: Float32Array, rate = RATE): string {
  const bytes = new Uint8Array(44 + pcm.length * 2);
  const v = new DataView(bytes.buffer);
  const str = (o: number, s: string) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + pcm.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i]!)) * 0x7fff, true);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function rms(pcm: Float32Array): number {
  let s = 0;
  for (let i = 0; i < pcm.length; i += 4) s += pcm[i]! * pcm[i]!;
  return Math.sqrt(s / Math.max(1, pcm.length / 4));
}

/** Trechos de vídeo/áudio com fala (cada um ganha um bloco de legenda). */
export function blocosDeFala(p: Project): (VideoClip | AudioClip)[] {
  const muted = new Set(p.tracks.filter((tr) => tr.muted).map((tr) => tr.id));
  const comSom = p.clips
    .filter((c): c is VideoClip | AudioClip => (c.type === 'video' && c.hasAudio !== false) || c.type === 'audio')
    .filter((c) => !c.muted && c.volume > 0 && !muted.has(c.trackId))
    .sort((a, b) => (a.type === b.type ? a.start - b.start : a.type === 'video' ? -1 : 1));
  const out: (VideoClip | AudioClip)[] = [];
  for (const c of comSom) if (!out.some((o) => c.start < clipEnd(o) - 0.05 && clipEnd(c) > o.start + 0.05)) out.push(c);
  return out.sort((a, b) => a.start - b.start);
}

/** Um item de legenda por bloco (puro: testável). Devolve também o grupo de cada bloco. */
export function buildCaptionBlocks(
  p: Project,
  fr: Frase[],
  blocos: Clip[],
  look: CaptionLook,
  upper: boolean,
  extra: { linhas?: number; align?: 'left' | 'center' | 'right'; offset?: number } = {},
): { clips: TextClip[]; grupos: Map<string, string> } {
  const prev = p.clips.find((x): x is TextClip => x.type === 'text' && x.preset === CAPTION_PRESET);
  const alvo = blocos.length ? blocos.map((b) => ({ id: b.id, start: b.start, dur: b.duration, group: b.group })) : [{ id: '', start: 0, dur: Math.max(projectDuration(p), ...fr.map((x) => x.fim + 0.5)), group: undefined as string | undefined }];
  const clips: TextClip[] = [];
  const grupos = new Map<string, string>();
  for (const b of alvo) {
    const dentro = fr.filter((f) => f.ini >= b.start - 0.05 && f.ini < b.start + b.dur);
    if (!dentro.length) continue;
    const group = b.id ? (b.group ?? uid()) : undefined;
    if (group) grupos.set(b.id, group);
    const c = createTextClip(p, CAPTION_PRESET, b.start);
    const words = dentro.flatMap((f, i) => f.palavras.map((w) => ({ w: w.w, t: Math.max(0, +(w.t - b.start).toFixed(2)), e: Math.min(b.dur, +(w.e - b.start).toFixed(2)), s: i, sp: f.sp })));
    clips.push({
      ...c,
      name: `Legenda: ${dentro[0]!.palavras.map((w) => w.w).join(' ').slice(0, 24)}`,
      duration: b.dur,
      ...(group ? { group } : {}),
      ...(prev ? { transform: { ...prev.transform } } : {}),
      fields: { ...c.fields, title: dentro.map((f) => f.palavras.map((w) => w.w).join(' ')).join('\n') },
      style: { ...c.style, uppercase: upper, ...(extra.align ? { align: extra.align } : {}) },
      caption: { words, speaker: dentro[0]!.sp, look, ...(extra.linhas ? { linhas: extra.linhas } : {}), ...(extra.offset ? { offset: extra.offset } : {}) },
    });
  }
  return { clips, grupos };
}

/** compatível: projeto inteiro num bloco por trecho de vídeo */
export function buildCaptionClips(p: Project, segs: Segmento[], look: CaptionLook, upper: boolean, extra: { linhas?: number; align?: 'left' | 'center' | 'right' } = {}, regs: Regiao[] = []): TextClip[] {
  return buildCaptionBlocks(p, frases(segs, regs), blocosDeFala(p), look, upper, extra).clips;
}

/**
 * Põe as legendas na trilha "Legendas" e agrupa cada uma com o seu vídeo.
 * `todas`: troca todas as legendas antigas; senão só as dos mesmos blocos.
 */
export function applyCaptions(p: Project, clips: TextClip[], grupos: Map<string, string> = new Map(), todas = true): Project {
  const gruposNovos = new Set(grupos.values());
  const old = new Set(p.clips.filter((c) => c.type === 'text' && c.preset === CAPTION_PRESET && (todas || (c.group && gruposNovos.has(c.group)))).map((c) => c.id));
  let next: Project = { ...p, clips: p.clips.filter((c) => !old.has(c.id)).map((c) => (grupos.has(c.id) ? { ...c, group: grupos.get(c.id) } : c)) };
  let track = next.tracks.find((t) => t.kind === 'visual' && t.name === 'Legendas');
  if (!track) {
    track = newTrack('visual', 'Legendas');
    next = { ...next, tracks: [...next.tracks, track] };
  }
  for (const c of clips) next = placeClip(next, c, track.id);
  return next;
}

/** último estilo escolhido (vale também para "Gerar legenda deste trecho") */
const ESTILO_KEY = 'pn-legenda-estilo';
export function getCaptionStyle(): CaptionStyle {
  try {
    return { look: 'destaque', upper: false, linhas: 2, align: 'center', offset: 0, ...(JSON.parse(localStorage.getItem(ESTILO_KEY) ?? '{}') as Partial<CaptionStyle>) };
  } catch {
    return { look: 'destaque', upper: false, linhas: 2, align: 'center', offset: 0 };
  }
}
export function saveCaptionStyle(st: CaptionStyle) {
  try {
    localStorage.setItem(ESTILO_KEY, JSON.stringify(st));
  } catch {
    /* sem armazenamento */
  }
}

export interface ProjectTranscript {
  /** frases já encostadas na voz de verdade */
  segs: Segmento[];
  /** trechos com voz */
  regs: Regiao[];
  /** tempo de cada palavra (Whisper no aparelho); vazio se não deu */
  palavras: PalavraTempo[];
  falantes: number;
  costUsd: number;
}

/** Ouve o áudio do projeto (como vai sair no vídeo) e transcreve com o tempo exato de cada frase. */
export async function transcribeProject(p: Project, media: Record<string, MediaAsset>, opts: { onStep?: (s: string) => void; signal?: AbortSignal } = {}): Promise<ProjectTranscript> {
  const key = getAiKey();
  if (!key) throw new Error('Coloque a chave da IA em ⚙ Configurações (tela inicial).');
  const dur = projectDuration(p);
  if (dur < 0.5) throw new Error('O projeto está vazio.');
  const signal = opts.signal ?? new AbortController().signal;
  // junta o áudio em pedaços de 1 min
  const chunks: { start: number; pcm: Float32Array }[] = [];
  let cur: Float32Array[] = [];
  let curStart = 0;
  let curLen = 0;
  const flush = () => {
    if (!curLen) return;
    const pcm = new Float32Array(curLen);
    let o = 0;
    for (const x of cur) pcm.set(x, o), (o += x.length);
    chunks.push({ start: curStart, pcm });
    cur = [];
    curLen = 0;
  };
  opts.onStep?.('Lendo o áudio do vídeo…');
  const has = await mixAudioWindows(p, media, dur, async (buf, startSec) => {
    if (!curLen) curStart = startSec;
    const m = toMono16k(buf);
    cur.push(m);
    curLen += m.length;
    if (curLen >= CHUNK_S * RATE) flush();
  }, signal);
  flush();
  if (!has || !chunks.length) throw new Error('Este projeto não tem áudio com fala.');
  const all: Segmento[] = [];
  // onde tem voz de verdade (para encostar as frases na fala)
  const regs: Regiao[] = chunks.flatMap((c) => speechRegions(c.pcm, RATE, c.start));
  // em paralelo com a IA (que é pela internet): o Whisper no aparelho acerta o tempo de cada palavra
  const passos = { ia: '', relogio: '' };
  const mostra = () => opts.onStep?.([passos.ia, passos.relogio].filter(Boolean).join(' · '));
  const relogio = getCaptionStyle().precisa === false
    ? Promise.resolve<PalavraTempo[]>([])
    : (async () => {
        const out: PalavraTempo[] = [];
        for (const ch of chunks) {
          if (rms(ch.pcm) < 0.003) continue;
          out.push(...(await relogioPalavras(ch.pcm, ch.start, { signal, onStep: (s) => ((passos.relogio = s), mostra()) })));
        }
        return out;
      })().catch((e: unknown) => {
        if (signal.aborted) throw e;
        console.warn('sincronizador de legenda indisponível:', e);
        return [] as PalavraTempo[];
      });
  let falantes: Falante[] = [];
  let cost = 0;
  for (let i = 0; i < chunks.length; i++) {
    const ch = chunks[i]!;
    const len = ch.pcm.length / RATE;
    if (rms(ch.pcm) < 0.003) continue; // silêncio
    passos.ia = `Transcrevendo ${chunks.length > 1 ? `parte ${i + 1} de ${chunks.length}` : 'a fala'}…`;
    mostra();
    const r = await transcribeWav(key, wavBase64(ch.pcm), len, falantes);
    cost += r.costUsd;
    for (const f of r.falantes) if (!falantes.some((x) => x.id === f.id)) falantes = [...falantes, f];
    for (const seg of r.segmentos) all.push({ ...seg, inicio: seg.inicio + ch.start, fim: seg.fim + ch.start });
  }
  if (!all.length) throw new Error('A IA não encontrou fala neste vídeo.');
  passos.ia = '';
  if (!passos.relogio) passos.relogio = 'Acertando o tempo de cada palavra…';
  mostra();
  const palavras = await relogio;
  return { segs: all, regs, palavras, falantes: new Set(all.map((x) => x.falante)).size, costUsd: cost };
}

export async function generateCaptions(opts: { look: CaptionLook; upper: boolean; linhas?: number; align?: 'left' | 'center' | 'right'; offset?: number; onStep?: (s: string) => void; signal?: AbortSignal }): Promise<{ count: number; falantes: number; costUsd: number }> {
  const s = getEditor();
  const p = s.project;
  if (!p) throw new Error('Abra um projeto primeiro.');
  const tr = await transcribeProject(p, s.media, opts);
  const cur = getEditor().project ?? p;
  const { clips, grupos } = buildCaptionBlocks(cur, frases(tr.segs, tr.regs, tr.palavras), blocosDeFala(cur), opts.look, opts.upper, { linhas: opts.linhas, align: opts.align, offset: opts.offset });
  getEditor().apply((pr) => applyCaptions(pr, clips, grupos, true));
  return { count: clips.length, falantes: tr.falantes, costUsd: tr.costUsd };
}

/** Legenda só deste trecho de vídeo/áudio (Ajustes do item): não mexe nas outras. */
export async function generateCaptionsForClip(clipId: string, onStep?: (s: string) => void): Promise<{ frases: number; costUsd: number }> {
  const s = getEditor();
  const p = s.project;
  const clip = p?.clips.find((c) => c.id === clipId);
  if (!p || !clip || (clip.type !== 'video' && clip.type !== 'audio')) throw new Error('Selecione um vídeo ou áudio.');
  // ouve só este trecho (como se começasse no zero) e depois devolve para o lugar dele
  const so: Project = { ...p, clips: [{ ...clip, start: 0 }] };
  const tr = await transcribeProject(so, s.media, { onStep });
  const segs = tr.segs.map((x) => ({ ...x, inicio: x.inicio + clip.start, fim: x.fim + clip.start }));
  const regs = tr.regs.map((r) => ({ ini: r.ini + clip.start, fim: r.fim + clip.start }));
  const palavras = tr.palavras.map((w) => ({ ...w, t: w.t + clip.start, e: w.e + clip.start }));
  const st = getCaptionStyle();
  const cur = getEditor().project ?? p;
  const alvo = cur.clips.find((c) => c.id === clipId) ?? clip;
  const fr = frases(segs, regs, palavras);
  const { clips, grupos } = buildCaptionBlocks(cur, fr, [alvo], st.look, st.upper, { linhas: st.linhas, align: st.align, offset: st.offset });
  getEditor().apply((pr) => applyCaptions(pr, clips, grupos, false));
  return { frases: fr.length, costUsd: tr.costUsd };
}

export interface CaptionStyle {
  look: CaptionLook;
  upper: boolean;
  linhas: number;
  align: 'left' | 'center' | 'right';
  /** ajuste fino da sincronia (s) */
  offset: number;
  /** tempo de cada palavra pelo Whisper no aparelho (padrão: sim) */
  precisa?: boolean;
}

/** Muda o visual de todas as legendas de uma vez. */
export function restyleCaptions(st: Partial<CaptionStyle>) {
  getEditor().apply((p) => ({
    ...p,
    clips: p.clips.map((c) =>
      c.type === 'text' && c.preset === CAPTION_PRESET
        ? {
            ...c,
            style: { ...c.style, ...(st.upper !== undefined ? { uppercase: st.upper } : {}), ...(st.align ? { align: st.align } : {}) },
            caption: { ...(c.caption ?? { words: [], speaker: 1, look: 'limpa' as const }), ...(st.look ? { look: st.look } : {}), ...(st.linhas ? { linhas: st.linhas } : {}), ...(st.offset !== undefined ? { offset: st.offset } : {}) },
          }
        : c,
    ),
  }));
}

/**
 * Mexeu (arrastou/esticou) uma legenda: todas as outras vão para a mesma caixa,
 * para as legendas não pularem de lugar ao longo do vídeo.
 */
export function syncCaptionBox(p: Project, id: string): Project {
  const src = p.clips.find((c) => c.id === id);
  if (!src || src.type !== 'text' || src.preset !== CAPTION_PRESET) return p;
  return { ...p, clips: p.clips.map((c) => (c.type === 'text' && c.preset === CAPTION_PRESET && c.id !== id ? { ...c, transform: { ...src.transform }, keyframes: [] } : c)) };
}
