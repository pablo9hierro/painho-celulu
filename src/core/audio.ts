/**
 * Plano de mixagem de áudio — usado pelo player do preview (volume por instante)
 * e pela exportação (grafo de filtros do FFmpeg). Mesma fonte, mesmo resultado.
 */
import type { Project } from './model';
import { clamp } from './animation';

export interface AudioSegment {
  clipId: string;
  mediaId: string;
  /** início na timeline (s) */
  start: number;
  duration: number;
  sourceIn: number;
  speed: number;
  volume: number;
  fadeIn: number;
  fadeOut: number;
  /** fator de tom do disfarce de voz (1 = normal) */
  pitch: number;
}

/** Fatores de tom do disfarce de voz (aguda / grave). */
export const VOICE_PITCH = { normal: 1, high: 1.38, low: 0.74 } as const;

export function buildAudioPlan(p: Project): AudioSegment[] {
  const out: AudioSegment[] = [];
  for (const c of p.clips) {
    if (c.type !== 'video' && c.type !== 'audio') continue;
    if (c.type === 'video' && !c.hasAudio) continue;
    if (c.muted || c.volume <= 0) continue;
    const track = p.tracks.find((t) => t.id === c.trackId);
    if (!track || track.muted || (track.volume ?? 1) <= 0) continue;
    if (track.kind === 'visual' && track.hidden) continue;
    out.push({
      clipId: c.id,
      mediaId: c.mediaId,
      start: c.start,
      duration: c.duration,
      sourceIn: c.sourceIn,
      speed: c.speed,
      volume: c.volume * (track.volume ?? 1),
      fadeIn: Math.min(c.fadeIn, c.duration / 2),
      fadeOut: Math.min(c.fadeOut, c.duration / 2),
      pitch: VOICE_PITCH[c.voice ?? 'normal'],
    });
  }
  return out;
}

/** Ganho de um segmento no tempo de timeline `t` (inclui fades). */
export function gainAt(seg: AudioSegment, t: number): number {
  const local = t - seg.start;
  if (local < 0 || local > seg.duration) return 0;
  let g = seg.volume;
  if (seg.fadeIn > 0) g *= clamp(local / seg.fadeIn, 0, 1);
  if (seg.fadeOut > 0) g *= clamp((seg.duration - local) / seg.fadeOut, 0, 1);
  return g;
}

/** Decompõe a velocidade em uma cadeia de atempo (cada um entre 0.5 e 2). */
export function atempoChain(speed: number): number[] {
  const chain: number[] = [];
  let s = speed;
  while (s > 2) {
    chain.push(2);
    s /= 2;
  }
  while (s < 0.5) {
    chain.push(0.5);
    s /= 0.5;
  }
  if (Math.abs(s - 1) > 1e-4 || chain.length === 0) chain.push(s);
  return chain;
}

const f = (n: number) => Number(n.toFixed(4)).toString();

/**
 * Monta o filter_complex do FFmpeg. `inputIndex` mapeia mediaId → índice de entrada.
 * Retorna null quando não há áudio (a exportação gera trilha silenciosa).
 */
export function buildFfmpegAudioGraph(
  plan: AudioSegment[],
  inputIndex: Map<string, number>,
  totalDuration: number,
): { filter: string; output: string } | null {
  const parts: string[] = [];
  const labels: string[] = [];
  plan.forEach((s, i) => {
    const idx = inputIndex.get(s.mediaId);
    if (idx === undefined) return;
    const srcLen = s.duration * s.speed;
    const chain = [
      `atrim=start=${f(s.sourceIn)}:duration=${f(srcLen)}`,
      'asetpts=PTS-STARTPTS',
      ...atempoChain(s.speed)
        .filter((x) => Math.abs(x - 1) > 1e-4)
        .map((x) => `atempo=${f(x)}`),
      'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo',
      // disfarce de voz: muda o tom e devolve a duração original
      ...(Math.abs(s.pitch - 1) > 1e-3 ? [`asetrate=${Math.round(48000 * s.pitch)}`, 'aresample=48000', `atempo=${f(1 / s.pitch)}`] : []),
      `volume=${f(s.volume)}`,
    ];
    if (s.fadeIn > 0) chain.push(`afade=t=in:st=0:d=${f(s.fadeIn)}`);
    if (s.fadeOut > 0) chain.push(`afade=t=out:st=${f(Math.max(0, s.duration - s.fadeOut))}:d=${f(s.fadeOut)}`);
    const delayMs = Math.round(s.start * 1000);
    chain.push(`adelay=${delayMs}|${delayMs}`);
    const label = `a${i}`;
    parts.push(`[${idx}:a]${chain.join(',')}[${label}]`);
    labels.push(`[${label}]`);
  });
  if (labels.length === 0) return null;
  const mix =
    labels.length === 1
      ? `${labels[0]}apad,atrim=duration=${f(totalDuration)}[aout]`
      : `${labels.join('')}amix=inputs=${labels.length}:normalize=0:dropout_transition=0,apad,atrim=duration=${f(totalDuration)}[aout]`;
  parts.push(mix);
  return { filter: parts.join(';'), output: '[aout]' };
}
