/**
 * Operações de timeline. Todas são funções puras que recebem um projeto e
 * devolvem um novo projeto (ou mutam um rascunho do immer — ambas as formas funcionam,
 * porque nunca dependemos de identidade de objetos).
 */
import type { Clip, Project, Track } from './model';
import { hasAudioProps, isTimeStretchable } from './model';
import { uid } from './id';

export const MIN_CLIP = 0.1;
export const EPS = 1e-6;

export const clipEnd = (c: Clip) => c.start + c.duration;

export function projectDuration(p: Project): number {
  let d = 0;
  for (const c of p.clips) d = Math.max(d, clipEnd(c));
  return d;
}

export function findClip(p: Project, id: string): Clip | undefined {
  return p.clips.find((c) => c.id === id);
}

export function findTrack(p: Project, id: string): Track | undefined {
  return p.tracks.find((t) => t.id === id);
}

export function clipsOnTrack(p: Project, trackId: string, excludeId?: string): Clip[] {
  return p.clips
    .filter((c) => c.trackId === trackId && c.id !== excludeId)
    .sort((a, b) => a.start - b.start);
}

export function trackKindFor(c: Clip): Track['kind'] {
  return c.type === 'audio' ? 'audio' : 'visual';
}

/** Duração máxima na timeline permitida pelo arquivo de origem a partir de sourceIn. */
export function maxDurationFor(c: Clip): number {
  if (!isTimeStretchable(c) || !hasAudioProps(c)) return Infinity;
  if (c.type === 'video' || c.type === 'audio') {
    if (c.sourceDuration <= 0) return Infinity;
    return Math.max(MIN_CLIP, (c.sourceDuration - c.sourceIn) / c.speed);
  }
  return Infinity;
}

/** O intervalo [start, start+duration) colide com algum clipe da trilha? */
export function overlaps(p: Project, trackId: string, start: number, duration: number, excludeId?: string): boolean {
  const end = start + duration;
  return clipsOnTrack(p, trackId, excludeId).some((c) => start < clipEnd(c) - EPS && end > c.start + EPS);
}

/**
 * Encontra a posição livre mais próxima de `desired` em que um clipe de `duration` cabe.
 * Retorna null apenas se não houver espaço (nunca acontece, pois sempre cabe após o último).
 */
export function nearestFreeStart(
  p: Project,
  trackId: string,
  desired: number,
  duration: number,
  excludeId?: string,
): number {
  desired = Math.max(0, desired);
  const others = clipsOnTrack(p, trackId, excludeId);
  if (!overlaps(p, trackId, desired, duration, excludeId)) return desired;
  // candidatos: logo após cada clipe e logo antes de cada clipe
  const candidates: number[] = [0];
  for (const c of others) {
    candidates.push(clipEnd(c));
    candidates.push(c.start - duration);
  }
  let best = Infinity;
  let bestDist = Infinity;
  for (const s of candidates) {
    if (s < -EPS) continue;
    const st = Math.max(0, s);
    if (overlaps(p, trackId, st, duration, excludeId)) continue;
    const d = Math.abs(st - desired);
    if (d < bestDist) {
      bestDist = d;
      best = st;
    }
  }
  return best === Infinity ? (others.length ? clipEnd(others[others.length - 1]!) : 0) : best;
}

export interface SnapResult {
  value: number;
  snapped: boolean;
  target?: number;
}

/** Imanta `t` ao candidato mais próximo dentro do limiar. */
export function snapTime(t: number, candidates: number[], threshold: number): SnapResult {
  let best: number | undefined;
  let bestD = threshold;
  for (const c of candidates) {
    const d = Math.abs(c - t);
    if (d <= bestD) {
      bestD = d;
      best = c;
    }
  }
  return best === undefined ? { value: t, snapped: false } : { value: best, snapped: true, target: best };
}

export function snapCandidates(p: Project, playhead: number, excludeIds: string[] = []): number[] {
  const out = [0, playhead];
  for (const c of p.clips) {
    if (excludeIds.includes(c.id)) continue;
    out.push(c.start, clipEnd(c));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Mutações
// ---------------------------------------------------------------------------

function mapClip(p: Project, id: string, fn: (c: Clip) => Clip): Project {
  return { ...p, clips: p.clips.map((c) => (c.id === id ? fn(c) : c)) };
}

/** Move um clipe para `start` (e opcionalmente outra trilha compatível), resolvendo colisões. */
export function moveClip(p: Project, id: string, start: number, trackId?: string): Project {
  const clip = findClip(p, id);
  if (!clip) return p;
  let targetTrack = trackId ? findTrack(p, trackId) : findTrack(p, clip.trackId);
  if (!targetTrack || targetTrack.kind !== trackKindFor(clip) || targetTrack.locked) {
    targetTrack = findTrack(p, clip.trackId)!;
  }
  const s = nearestFreeStart(p, targetTrack.id, start, clip.duration, id);
  return mapClip(p, id, (c) => ({ ...c, start: s, trackId: targetTrack!.id }));
}

/** Arrasta a borda esquerda: altera início, ponto de entrada da mídia e duração. */
export function trimStart(p: Project, id: string, newStart: number): Project {
  const clip = findClip(p, id);
  if (!clip) return p;
  const end = clipEnd(clip);
  // limite à esquerda: vizinho anterior e início da mídia
  const prev = clipsOnTrack(p, clip.trackId, id).filter((c) => clipEnd(c) <= clip.start + EPS);
  let lo = prev.length ? clipEnd(prev[prev.length - 1]!) : 0;
  if (clip.type === 'video' || clip.type === 'audio') {
    lo = Math.max(lo, clip.start - clip.sourceIn / clip.speed);
  }
  const s = Math.min(Math.max(newStart, lo), end - MIN_CLIP);
  const delta = s - clip.start;
  return mapClip(p, id, (c) => {
    const next = { ...c, start: s, duration: end - s } as Clip;
    if (next.type === 'video' || next.type === 'audio') {
      next.sourceIn = Math.max(0, next.sourceIn + delta * next.speed);
    }
    if (next.type !== 'audio' && next.keyframes.length) {
      next.keyframes = next.keyframes.map((k) => ({ ...k, t: k.t - delta })).filter((k) => k.t >= -EPS);
    }
    return next;
  });
}

/** Arrasta a borda direita: altera apenas a duração. */
export function trimEnd(p: Project, id: string, newEnd: number): Project {
  const clip = findClip(p, id);
  if (!clip) return p;
  const next = clipsOnTrack(p, clip.trackId, id).find((c) => c.start >= clipEnd(clip) - EPS);
  let hi = next ? next.start : Infinity;
  hi = Math.min(hi, clip.start + maxDurationFor(clip));
  const e = Math.max(clip.start + MIN_CLIP, Math.min(newEnd, hi));
  return mapClip(p, id, (c) => ({ ...c, duration: e - c.start }));
}

/** Divide o clipe no tempo `t` da timeline. Retorna o projeto e o id da segunda parte. */
export function splitClip(p: Project, id: string, t: number): { project: Project; newId: string | null } {
  const clip = findClip(p, id);
  if (!clip || t <= clip.start + MIN_CLIP || t >= clipEnd(clip) - MIN_CLIP) return { project: p, newId: null };
  const local = t - clip.start;
  const newId = uid();
  const left = { ...clip, duration: local } as Clip;
  const right = { ...clip, id: newId, start: t, duration: clip.duration - local } as Clip;
  if (right.type === 'video' || right.type === 'audio') {
    right.sourceIn = right.sourceIn + local * right.speed;
    right.fadeIn = 0;
    (left as typeof right).fadeOut = 0;
  }
  if (left.type !== 'audio' && right.type !== 'audio') {
    left.animOut = { ...left.animOut, type: 'none' };
    right.animIn = { ...right.animIn, type: 'none' };
    if (clip.type !== 'audio' && clip.keyframes.length) {
      left.keyframes = clip.keyframes.filter((k) => k.t <= local + EPS);
      right.keyframes = clip.keyframes.filter((k) => k.t >= local - EPS).map((k) => ({ ...k, t: k.t - local }));
    }
  }
  const clips: Clip[] = [];
  for (const c of p.clips) {
    if (c.id === id) clips.push(left, right);
    else clips.push(c);
  }
  return { project: { ...p, clips }, newId };
}

/** Remove clipes. Com `ripple`, fecha o espaço deixado na mesma trilha. */
export function deleteClips(p: Project, ids: string[], ripple = false): Project {
  let clips = p.clips;
  if (ripple) {
    const removed = p.clips.filter((c) => ids.includes(c.id)).sort((a, b) => b.start - a.start);
    for (const r of removed) {
      clips = clips.map((c) =>
        c.trackId === r.trackId && c.start >= clipEnd(r) - EPS && !ids.includes(c.id)
          ? { ...c, start: Math.max(0, c.start - r.duration) }
          : c,
      );
    }
  }
  return { ...p, clips: clips.filter((c) => !ids.includes(c.id)) };
}

export function duplicateClip(p: Project, id: string): { project: Project; newId: string | null } {
  const clip = findClip(p, id);
  if (!clip) return { project: p, newId: null };
  const newId = uid();
  const copy = structuredClone(clip) as Clip;
  copy.id = newId;
  copy.start = nearestFreeStart(p, clip.trackId, clipEnd(clip), clip.duration);
  return { project: { ...p, clips: [...p.clips, copy] }, newId };
}

export function setSpeed(p: Project, id: string, speed: number): Project {
  return mapClip(p, id, (c) => {
    if (c.type !== 'video' && c.type !== 'audio') return c;
    const sp = Math.min(4, Math.max(0.25, speed));
    const srcSpan = c.duration * c.speed;
    const next = { ...c, speed: sp, duration: Math.max(MIN_CLIP, srcSpan / sp) };
    return next;
  });
}

// ---------------------------------------------------------------------------
// Trilhas
// ---------------------------------------------------------------------------

export function newTrack(kind: Track['kind'], name: string): Track {
  return { id: uid(), kind, name, hidden: false, muted: false, locked: false };
}

/** Adiciona uma trilha visual no topo do empilhamento, ou de áudio ao fim. */
export function addTrack(p: Project, kind: Track['kind']): { project: Project; trackId: string } {
  const count = p.tracks.filter((t) => t.kind === kind).length;
  const t = newTrack(kind, kind === 'visual' ? `Camada ${count + 1}` : `Áudio ${count + 1}`);
  return { project: { ...p, tracks: [...p.tracks, t] }, trackId: t.id };
}

/**
 * Coloca um clipe novo na primeira trilha compatível com espaço livre a partir de `start`;
 * se nenhuma tiver, cria uma trilha nova. Com `preferTrackId`, tenta essa primeiro.
 */
export function placeClip(p: Project, clip: Clip, preferTrackId?: string): Project {
  const kind = trackKindFor(clip);
  const tracks = p.tracks.filter((t) => t.kind === kind && !t.locked);
  const ordered = preferTrackId
    ? [...tracks.filter((t) => t.id === preferTrackId), ...tracks.filter((t) => t.id !== preferTrackId)]
    : // elementos gráficos vão para o topo; vídeo/áudio para a trilha mais baixa
      clip.type === 'video' || clip.type === 'audio' || clip.type === 'image'
      ? tracks
      : [...tracks].reverse();
  for (const t of ordered) {
    if (!overlaps(p, t.id, clip.start, clip.duration)) {
      return { ...p, clips: [...p.clips, { ...clip, trackId: t.id }] };
    }
  }
  const { project, trackId } = addTrack(p, kind);
  return { ...project, clips: [...project.clips, { ...clip, trackId }] };
}

/** Remove trilhas vazias, preservando pelo menos uma de cada tipo. */
export function pruneEmptyTracks(p: Project): Project {
  const used = new Set(p.clips.map((c) => c.trackId));
  const keep: Track[] = [];
  const kept = { visual: 0, audio: 0 };
  for (const t of p.tracks) {
    if (used.has(t.id)) {
      keep.push(t);
      kept[t.kind]++;
    }
  }
  for (const kind of ['visual', 'audio'] as const) {
    if (kept[kind] === 0) {
      const t = p.tracks.find((x) => x.kind === kind);
      if (t) keep.splice(kind === 'visual' ? 0 : keep.length, 0, t);
    }
  }
  return { ...p, tracks: p.tracks.filter((t) => keep.includes(t)) };
}

export function moveTrack(p: Project, trackId: string, dir: -1 | 1): Project {
  const idx = p.tracks.findIndex((t) => t.id === trackId);
  const j = idx + dir;
  if (idx < 0 || j < 0 || j >= p.tracks.length) return p;
  if (p.tracks[j]!.kind !== p.tracks[idx]!.kind) return p;
  const tracks = [...p.tracks];
  [tracks[idx], tracks[j]] = [tracks[j]!, tracks[idx]!];
  return { ...p, tracks };
}

// ---------------------------------------------------------------------------
// Grupos (Ctrl+G), vácuos e faixa nova ao arrastar
// ---------------------------------------------------------------------------

/** Ids de todos os itens que andam junto com estes (mesmo grupo). */
export function withGroups(p: Project, ids: string[]): string[] {
  const groups = new Set(p.clips.filter((c) => ids.includes(c.id) && c.group).map((c) => c.group!));
  return [...new Set([...ids, ...p.clips.filter((c) => c.group && groups.has(c.group)).map((c) => c.id)])];
}

/** Agrupa (2+ itens) ou desagrupa (se já estão todos no mesmo grupo). */
export function toggleGroup(p: Project, ids: string[]): Project {
  const sel = p.clips.filter((c) => ids.includes(c.id));
  if (!sel.length) return p;
  const same = sel.every((c) => c.group && c.group === sel[0]!.group);
  if (same) {
    const g = sel[0]!.group;
    return { ...p, clips: p.clips.map((c) => (c.group === g ? { ...c, group: undefined } : c)) };
  }
  if (sel.length < 2) return p;
  const g = uid();
  return { ...p, clips: p.clips.map((c) => (ids.includes(c.id) ? { ...c, group: g } : c)) };
}

/**
 * Tira os vácuos: trechos de tempo em que NENHUMA faixa tem vídeo, foto ou
 * áudio. Tudo que vem depois anda para a esquerda. Um trecho que continua em
 * outra faixa (0–10 s numa, 10–15 s na outra) não tem vácuo e não se mexe.
 */
export function closeGaps(p: Project): Project {
  const cover = p.clips
    .filter((c) => c.type === 'video' || c.type === 'image' || c.type === 'audio')
    .map((c) => [c.start, clipEnd(c)] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  if (!cover.length) return p;
  const gaps: [number, number][] = [];
  let end = 0;
  for (const [a, b] of cover) {
    if (a > end + 0.01) gaps.push([end, a]);
    end = Math.max(end, b);
  }
  if (!gaps.length) return p;
  const shift = (t: number) => gaps.reduce((s, [a, b]) => (t >= b - 1e-6 ? s + (b - a) : s), 0);
  return { ...p, clips: p.clips.map((c) => ({ ...c, start: Math.max(0, c.start - shift(c.start)) })) };
}

/** Itens (fora `ignore`) que ocupariam o mesmo tempo nesta faixa. */
export function overlapping(p: Project, trackId: string, start: number, duration: number, ignore: string[]): Clip[] {
  return p.clips.filter((c) => c.trackId === trackId && !ignore.includes(c.id) && c.start < start + duration - EPS && clipEnd(c) > start + EPS);
}

/** Cria uma faixa logo acima (visual) ou logo abaixo (áudio) desta e devolve o id. */
export function insertTrackNear(p: Project, refTrackId: string, kind: Track['kind']): { project: Project; trackId: string } {
  const count = p.tracks.filter((t) => t.kind === kind).length;
  const t = newTrack(kind, kind === 'visual' ? `Camada ${count + 1}` : `Áudio ${count + 1}`);
  const idx = p.tracks.findIndex((x) => x.id === refTrackId);
  const tracks = [...p.tracks];
  tracks.splice(idx < 0 ? tracks.length : idx + 1, 0, t);
  return { project: { ...p, tracks }, trackId: t.id };
}
