import { describe, expect, it } from 'vitest';
import { createProject, createTextClip, createVideoClip, createAudioClip } from './factory';
import type { MediaAsset, Project, VideoClip } from './model';
import { ProjectSchema } from './model';
import {
  deleteClips,
  duplicateClip,
  moveClip,
  nearestFreeStart,
  placeClip,
  projectDuration,
  pruneEmptyTracks,
  setSpeed,
  snapTime,
  splitClip,
  trimEnd,
  trimStart,
} from './timeline';

const asset = (over: Partial<MediaAsset> = {}): MediaAsset => ({
  id: 'm1',
  name: 'video.mp4',
  kind: 'video',
  duration: 10,
  width: 1920,
  height: 1080,
  fps: 30,
  hasAudio: true,
  url: '/x',
  status: 'ready',
  thumbs: null,
  waveform: null,
  size: 1,
  createdAt: '',
  ...over,
});

function withVideo(): { p: Project; v: VideoClip } {
  let p = createProject('t', 'reel');
  const v = createVideoClip(p, asset(), 0);
  p = placeClip(p, v, p.tracks[0]!.id);
  return { p, v: p.clips[0] as VideoClip };
}

describe('timeline', () => {
  it('cria projeto válido segundo o schema', () => {
    const { p } = withVideo();
    expect(ProjectSchema.safeParse(p).success).toBe(true);
    expect(projectDuration(p)).toBe(10);
  });

  it('divide um clipe preservando o ponto de entrada da mídia', () => {
    const { p, v } = withVideo();
    const { project, newId } = splitClip(p, v.id, 4);
    expect(newId).toBeTruthy();
    const a = project.clips.find((c) => c.id === v.id) as VideoClip;
    const b = project.clips.find((c) => c.id === newId) as VideoClip;
    expect(a.duration).toBeCloseTo(4);
    expect(b.start).toBeCloseTo(4);
    expect(b.duration).toBeCloseTo(6);
    expect(b.sourceIn).toBeCloseTo(4);
  });

  it('não divide nas extremidades', () => {
    const { p, v } = withVideo();
    expect(splitClip(p, v.id, 0.01).newId).toBeNull();
    expect(splitClip(p, v.id, 9.99).newId).toBeNull();
  });

  it('apara a borda esquerda ajustando sourceIn e respeitando o início da mídia', () => {
    const { p, v } = withVideo();
    const p2 = trimStart(p, v.id, 2);
    const c = p2.clips[0] as VideoClip;
    expect(c.start).toBeCloseTo(2);
    expect(c.sourceIn).toBeCloseTo(2);
    expect(c.duration).toBeCloseTo(8);
    // puxar para antes do início da mídia é limitado
    const p3 = trimStart(p2, v.id, -5);
    const c3 = p3.clips[0] as VideoClip;
    expect(c3.start).toBeCloseTo(0);
    expect(c3.sourceIn).toBeCloseTo(0);
  });

  it('apara a borda direita sem ultrapassar a duração da mídia', () => {
    const { p, v } = withVideo();
    const p2 = trimEnd(p, v.id, 30);
    expect(p2.clips[0]!.duration).toBeCloseTo(10);
    const p3 = trimEnd(p, v.id, 3);
    expect(p3.clips[0]!.duration).toBeCloseTo(3);
  });

  it('texto pode ser esticado livremente', () => {
    const { p } = withVideo();
    const t = createTextClip(p, 'pn-faixa', 0);
    const p2 = placeClip(p, t);
    const p3 = trimEnd(p2, t.id, 25);
    expect(p3.clips.find((c) => c.id === t.id)!.duration).toBeCloseTo(25);
  });

  it('move sem sobrepor e encaixa no espaço livre mais próximo', () => {
    const { p, v } = withVideo();
    const v2 = createVideoClip(p, asset({ id: 'm2', duration: 5 }), 10);
    let p2 = placeClip(p, v2, p.tracks[0]!.id);
    p2 = moveClip(p2, v2.id, 3);
    const moved = p2.clips.find((c) => c.id === v2.id)!;
    expect(moved.trackId).toBe(v.trackId);
    expect(moved.start).toBeCloseTo(10); // colide com o primeiro → vai para depois dele
    expect(nearestFreeStart(p2, v.trackId, 12, 1, 'nope')).toBeCloseTo(15);
  });

  it('não move vídeo para trilha de áudio', () => {
    const { p, v } = withVideo();
    const audioTrack = p.tracks.find((t) => t.kind === 'audio')!;
    const p2 = moveClip(p, v.id, 0, audioTrack.id);
    expect(p2.clips[0]!.trackId).toBe(v.trackId);
  });

  it('exclusão com ripple fecha o espaço', () => {
    const { p, v } = withVideo();
    const v2 = createVideoClip(p, asset({ id: 'm2', duration: 5 }), 10);
    const p2 = placeClip(p, v2, p.tracks[0]!.id);
    const p3 = deleteClips(p2, [v.id], true);
    expect(p3.clips).toHaveLength(1);
    expect(p3.clips[0]!.start).toBeCloseTo(0);
  });

  it('duplica para depois do original', () => {
    const { p, v } = withVideo();
    const { project, newId } = duplicateClip(p, v.id);
    const d = project.clips.find((c) => c.id === newId)!;
    expect(d.start).toBeCloseTo(10);
  });

  it('velocidade altera a duração mantendo o trecho de origem', () => {
    const { p, v } = withVideo();
    const p2 = setSpeed(p, v.id, 2);
    expect(p2.clips[0]!.duration).toBeCloseTo(5);
  });

  it('placeClip cria trilha nova quando não há espaço', () => {
    const { p } = withVideo();
    const a1 = createAudioClip(p, asset({ id: 'a', kind: 'audio' }), 0);
    const a2 = createAudioClip(p, asset({ id: 'b', kind: 'audio' }), 0);
    const p2 = placeClip(placeClip(p, a1), a2);
    expect(p2.tracks.filter((t) => t.kind === 'audio')).toHaveLength(2);
    expect(pruneEmptyTracks(p2).tracks.length).toBeLessThanOrEqual(p2.tracks.length);
  });

  it('ímã encaixa dentro do limiar', () => {
    expect(snapTime(4.96, [0, 5, 10], 0.1)).toEqual({ value: 5, snapped: true, target: 5 });
    expect(snapTime(4.5, [0, 5, 10], 0.1).snapped).toBe(false);
  });
});

describe('grupo, vácuos e faixa nova (linha do tempo estilo CapCut)', () => {
  it('agrupa, acha o grupo e desagrupa', async () => {
    const { toggleGroup, withGroups } = await import('./timeline');
    let p = createProject('t', 'reel');
    const a = createVideoClip(p, asset({ duration: 20 }), 0);
    p = placeClip(p, a);
    const b = createVideoClip(p, asset({ duration: 20 }), 10);
    p = placeClip(p, b);
    p = toggleGroup(p, [a.id, b.id]);
    expect(withGroups(p, [a.id]).sort()).toEqual([a.id, b.id].sort());
    p = toggleGroup(p, [a.id, b.id]);
    expect(withGroups(p, [a.id])).toEqual([a.id]);
  });

  it('tira o vácuo sem quebrar a continuação que está em outra faixa', async () => {
    const { closeGaps, addTrack } = await import('./timeline');
    let p = createProject('t', 'reel');
    const t1 = p.tracks.find((t) => t.kind === 'visual')!.id;
    const { project, trackId: t2 } = addTrack(p, 'visual');
    p = project;
    const a = { ...createVideoClip(p, asset({ duration: 20 }), 0), duration: 10, trackId: t1 };
    const b = { ...createVideoClip(p, asset({ duration: 20 }), 10), start: 10, duration: 5, trackId: t2 };
    const c = { ...createVideoClip(p, asset({ duration: 20 }), 20), start: 20, duration: 3, trackId: t1 }; // vácuo de 15 a 20
    p = { ...p, clips: [a, b, c] };
    const q = closeGaps(p);
    expect(q.clips.find((x) => x.id === b.id)!.start).toBe(10); // continua colado no fim do A
    expect(q.clips.find((x) => x.id === c.id)!.start).toBe(15); // o vácuo sumiu
  });

  it('acha quem está no caminho e cria faixa logo acima', async () => {
    const { overlapping, insertTrackNear } = await import('./timeline');
    let p = createProject('t', 'reel');
    const a = createVideoClip(p, asset({ duration: 20 }), 0);
    p = placeClip(p, a);
    const tr = a.trackId || p.clips[0]!.trackId;
    expect(overlapping(p, tr, 1, 2, [])).toHaveLength(1);
    expect(overlapping(p, tr, 1, 2, [p.clips[0]!.id])).toHaveLength(0);
    const r = insertTrackNear(p, tr, 'visual');
    const idx = r.project.tracks.findIndex((t) => t.id === r.trackId);
    expect(r.project.tracks[idx - 1]!.id).toBe(tr);
  });
});
