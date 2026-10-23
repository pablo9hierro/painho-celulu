/**
 * Legendas automáticas no editor: mixa o áudio do projeto (do jeito que vai
 * sair no vídeo, com cortes e velocidade), manda em pedaços de 1 min para a
 * IA transcrever e cria um item "Legenda automática" por frase numa trilha
 * "Legendas" no topo. Gerar de novo substitui as legendas antigas.
 */
import type { Caption, Project, TextClip } from '../core/model';
import { createTextClip } from '../core/factory';
import { newTrack, placeClip, projectDuration } from '../core/timeline';
import { mixAudioWindows } from '../engine/webcodecsExporter';
import { getAiKey } from '../news/client';
import { alignSegments, speechRegions, splitSegments, transcribeWav, wordTimes, wordTimesVoiced, type Falante, type Regiao, type Segmento } from '../news/transcribe';
import { getEditor } from '../state/store';

export const CAPTION_PRESET = 'pn-legenda';
export type CaptionLook = Caption['look'];
const RATE = 16_000;
const CHUNK_S = 60;

/** 48 kHz estéreo → 16 kHz mono (média de 3 amostras: filtro simples contra chiado). */
function toMono16k(buf: AudioBuffer): Float32Array {
  const ratio = buf.sampleRate / RATE;
  const n = Math.floor(buf.length / ratio);
  const out = new Float32Array(n);
  const chans = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i));
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * ratio);
    const b = Math.min(buf.length, Math.floor((i + 1) * ratio));
    let s = 0;
    let k = 0;
    for (let j = a; j < b; j++) for (const c of chans) (s += c[j]!), k++;
    out[i] = k ? s / k : 0;
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

/** Cria os itens de legenda (puro: testável). */
export function buildCaptionClips(p: Project, segs: Segmento[], look: CaptionLook, upper: boolean, extra: { linhas?: number; align?: 'left' | 'center' | 'right' } = {}, regs: Regiao[] = []): TextClip[] {
  return splitSegments(alignSegments(segs, regs)).map((s) => {
    const c = createTextClip(p, CAPTION_PRESET, s.inicio);
    // mesma caixa das legendas que já existem (o usuário pode ter mexido)
    const prev = p.clips.find((x): x is TextClip => x.type === 'text' && x.preset === CAPTION_PRESET);
    const duration = Math.max(0.4, s.fim - s.inicio);
    return {
      ...c,
      name: `Legenda: ${s.texto.slice(0, 24)}`,
      duration,
      ...(prev ? { transform: { ...prev.transform } } : {}),
      fields: { ...c.fields, title: s.texto },
      style: { ...c.style, uppercase: upper, ...(extra.align ? { align: extra.align } : {}) },
      caption: { words: regs.length ? wordTimesVoiced(s.texto, s.inicio, s.inicio + duration, regs) : wordTimes(s.texto, duration * 0.92), speaker: s.falante, look, ...(extra.linhas ? { linhas: extra.linhas } : {}) },
    };
  });
}

/** Troca as legendas antigas pelas novas numa trilha "Legendas" no topo. */
export function applyCaptions(p: Project, clips: TextClip[]): Project {
  const old = new Set(p.clips.filter((c) => c.type === 'text' && c.preset === CAPTION_PRESET).map((c) => c.id));
  let next: Project = { ...p, clips: p.clips.filter((c) => !old.has(c.id)) };
  let track = next.tracks.find((t) => t.kind === 'visual' && t.name === 'Legendas');
  if (!track) {
    track = newTrack('visual', 'Legendas');
    next = { ...next, tracks: [...next.tracks, track] };
  }
  for (const c of clips) next = placeClip(next, c, track.id);
  return next;
}

export async function generateCaptions(opts: { look: CaptionLook; upper: boolean; linhas?: number; align?: 'left' | 'center' | 'right'; onStep?: (s: string) => void; signal?: AbortSignal }): Promise<{ count: number; falantes: number; costUsd: number }> {
  const s = getEditor();
  const p = s.project;
  if (!p) throw new Error('Abra um projeto primeiro.');
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
  const has = await mixAudioWindows(p, s.media, dur, async (buf, startSec) => {
    if (!curLen) curStart = startSec;
    const m = toMono16k(buf);
    cur.push(m);
    curLen += m.length;
    if (curLen >= CHUNK_S * RATE) flush();
  }, signal);
  flush();
  if (!has || !chunks.length) throw new Error('Este projeto não tem áudio com fala.');
  const all: Segmento[] = [];
  // onde tem voz de verdade (para encostar as legendas na fala)
  const regs: Regiao[] = chunks.flatMap((c) => speechRegions(c.pcm, RATE, c.start));
  let falantes: Falante[] = [];
  let cost = 0;
  for (let i = 0; i < chunks.length; i++) {
    const ch = chunks[i]!;
    const len = ch.pcm.length / RATE;
    if (rms(ch.pcm) < 0.003) continue; // silêncio
    opts.onStep?.(`Transcrevendo ${chunks.length > 1 ? `parte ${i + 1} de ${chunks.length}` : 'a fala'}…`);
    const r = await transcribeWav(key, wavBase64(ch.pcm), len, falantes);
    cost += r.costUsd;
    for (const f of r.falantes) if (!falantes.some((x) => x.id === f.id)) falantes = [...falantes, f];
    for (const seg of r.segmentos) all.push({ ...seg, inicio: seg.inicio + ch.start, fim: seg.fim + ch.start });
  }
  if (!all.length) throw new Error('A IA não encontrou fala neste vídeo.');
  const clips = buildCaptionClips(getEditor().project ?? p, all, opts.look, opts.upper, { linhas: opts.linhas, align: opts.align }, regs);
  getEditor().apply((pr) => applyCaptions(pr, clips));
  const speakers = new Set(all.map((x) => x.falante)).size;
  return { count: clips.length, falantes: speakers, costUsd: cost };
}

export interface CaptionStyle {
  look: CaptionLook;
  upper: boolean;
  linhas: number;
  align: 'left' | 'center' | 'right';
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
            caption: { ...(c.caption ?? { words: [], speaker: 1, look: 'limpa' as const }), ...(st.look ? { look: st.look } : {}), ...(st.linhas ? { linhas: st.linhas } : {}) },
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
