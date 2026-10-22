import { describe, expect, it } from 'vitest';
import { animState, inOutProgress, transformAt, upsertKeyframe } from './animation';
import { atempoChain, buildAudioPlan, buildFfmpegAudioGraph, gainAt } from './audio';
import { dragCrop, hitTest, NO_CROP, removeCrop, resizeTransform, rotate, snapPosition } from './geometry';
import { evaluateScene, frameTimes } from './scene';
import { createBlurClip, createProject, createTextClip, createVideoClip, fitContain, fitCover } from './factory';
import { placeClip } from './timeline';
import { effectiveCrop, setCropAt, setTransformAt, toggleKeyframeAt } from './edit';
import { insertFrame, FRAMES, frameWindow, getFrame } from './frames';
import type { MediaAsset, Transform, VisualClip } from './model';
import { ProjectSchema } from './model';

const T: Transform = { x: 100, y: 100, width: 200, height: 100, rotation: 0, opacity: 1 };
const video: MediaAsset = {
  id: 'm',
  name: 'v',
  kind: 'video',
  duration: 8,
  width: 1920,
  height: 1080,
  fps: 30,
  hasAudio: true,
  url: '',
  status: 'ready',
  thumbs: null,
  waveform: null,
  size: 0,
  createdAt: '',
};

describe('animação', () => {
  it('entrada e saída não se sobrepõem', () => {
    const r = inOutProgress(0.5, 1, { type: 'fade', duration: 2 }, { type: 'fade', duration: 2 });
    expect(r.inP).toBeCloseTo(1);
    expect(r.outP).toBeCloseTo(1);
    expect(inOutProgress(0, 4, { type: 'fade', duration: 1 }, { type: 'none', duration: 1 }).inP).toBe(0);
  });

  it('estados genéricos terminam na identidade', () => {
    for (const t of ['fade', 'slide-up', 'zoom-in', 'pop', 'wipe'] as const) {
      const s = animState(t, 1, { w: 100, h: 100 });
      expect(s.opacity).toBeCloseTo(1);
      expect(s.dx).toBeCloseTo(0);
      expect(s.dy).toBeCloseTo(0);
      expect(s.scale).toBeCloseTo(1);
    }
  });

  it('interpola keyframes', () => {
    const kfs = upsertKeyframe(upsertKeyframe([], 0, T), 2, { ...T, x: 300 });
    expect(transformAt(T, kfs, 1).x).toBeCloseTo(200);
    expect(transformAt(T, kfs, 5).x).toBeCloseTo(300);
    expect(transformAt(T, [], 1)).toBe(T);
  });
});

describe('geometria', () => {
  it('hit-test considera rotação', () => {
    expect(hitTest(T, 195, 100)).toBe(true);
    const r = { ...T, rotation: 90 };
    expect(hitTest(r, 195, 100)).toBe(false);
    expect(hitTest(r, 100, 195)).toBe(true);
  });

  it('redimensiona pelo canto mantendo o canto oposto fixo', () => {
    const out = resizeTransform(T, 'se', 100, 50, { keepAspect: true, fromCenter: false });
    expect(out.width).toBeCloseTo(300);
    expect(out.height).toBeCloseTo(150);
    // canto superior esquerdo continua em (0,50)
    expect(out.x - out.width / 2).toBeCloseTo(0);
    expect(out.y - out.height / 2).toBeCloseTo(50);
  });

  it('borda lateral muda só a largura', () => {
    const out = resizeTransform(T, 'e', 40, 999, { keepAspect: false, fromCenter: false });
    expect(out.width).toBeCloseTo(240);
    expect(out.height).toBeCloseTo(100);
  });

  it('rotate é inversível', () => {
    const a = rotate(3, 4, 33);
    const b = rotate(a.x, a.y, -33);
    expect(b.x).toBeCloseTo(3);
    expect(b.y).toBeCloseTo(4);
  });

  it('imanta ao centro do quadro', () => {
    const s = snapPosition({ ...T, x: 537 }, { width: 1080, height: 1920 }, [], 6);
    expect(s.x).toBe(540);
    expect(s.guides.some((g) => g.axis === 'x' && g.pos === 540)).toBe(true);
  });

  it('encaixes contain/cover', () => {
    const c = fitContain(1920, 1080, 1080, 1920);
    expect(c.width).toBeCloseTo(1080);
    expect(c.height).toBeCloseTo(607.5);
    const v = fitCover(1920, 1080, 1080, 1920);
    expect(v.height).toBeCloseTo(1920);
  });
});

describe('áudio', () => {
  it('atempo decompõe velocidades fora de 0.5–2', () => {
    expect(atempoChain(4)).toEqual([2, 2]);
    expect(atempoChain(0.25)).toEqual([0.5, 0.5]);
    expect(atempoChain(1.5)).toEqual([1.5]);
  });

  it('plano ignora mudos e trilhas silenciadas e gera grafo FFmpeg', () => {
    let p = createProject('a', 'reel');
    const v = createVideoClip(p, video, 1);
    v.fadeIn = 0.5;
    p = placeClip(p, v, p.tracks[0]!.id);
    const plan = buildAudioPlan(p);
    expect(plan).toHaveLength(1);
    expect(gainAt(plan[0]!, 1)).toBe(0);
    expect(gainAt(plan[0]!, 1.25)).toBeCloseTo(0.5);
    const g = buildFfmpegAudioGraph(plan, new Map([['m', 1]]), 9)!;
    expect(g.filter).toContain('[1:a]atrim=start=0:duration=8');
    expect(g.filter).toContain('adelay=1000|1000');
    expect(g.filter).toContain('afade=t=in');
    expect(g.output).toBe('[aout]');

    const muted = { ...p, tracks: p.tracks.map((t) => ({ ...t, muted: true })) };
    expect(buildAudioPlan(muted)).toHaveLength(0);
    expect(buildFfmpegAudioGraph([], new Map(), 5)).toBeNull();
  });
});

describe('cena e edição', () => {
  it('avalia camadas na ordem das trilhas e respeita trilhas ocultas', () => {
    let p = createProject('s', 'reel');
    p = placeClip(p, createVideoClip(p, video, 0), p.tracks[0]!.id);
    const t = createTextClip(p, 'pn-urgente', 0);
    p = placeClip(p, t);
    p = placeClip(p, createBlurClip(p, { x: 100, y: 100, width: 50, height: 50 }, 0));
    const items = evaluateScene(p, 1);
    expect(items[0]!.clip.type).toBe('video');
    expect(items.map((i) => i.clip.type)).toContain('blur');
    const hidden = { ...p, tracks: p.tracks.map((tr, i) => (i === 0 ? { ...tr, hidden: true } : tr)) };
    expect(evaluateScene(hidden, 1).some((i) => i.clip.type === 'video')).toBe(false);
    expect(evaluateScene(p, 100)).toHaveLength(0);
  });

  it('mediaTime considera sourceIn e velocidade', () => {
    let p = createProject('s', 'reel');
    const v = createVideoClip(p, video, 2);
    v.sourceIn = 1;
    v.speed = 2;
    p = placeClip(p, v, p.tracks[0]!.id);
    expect(evaluateScene(p, 3)[0]!.mediaTime).toBeCloseTo(3);
  });

  it('com keyframes, mover grava keyframe no instante', () => {
    let p = createProject('k', 'reel');
    const t = createTextClip(p, 'plain', 0);
    p = placeClip(p, t);
    p = toggleKeyframeAt(p, t.id, 0);
    p = setTransformAt(p, t.id, 2, { ...t.transform, x: 10 });
    const c = p.clips.find((x) => x.id === t.id)!;
    expect(c.type !== 'audio' && c.keyframes.length).toBe(2);
    expect(evaluateScene(p, 2)[0]!.transform.x).toBeCloseTo(10);
  });

  it('modo Movimento (Pan/Crop): mexer no item sem keyframes cria nó no início e na agulha', () => {
    let p = createProject('k', 'reel');
    const t = createTextClip(p, 'plain', 0);
    p = placeClip(p, t);
    const x0 = t.transform.x;
    p = setTransformAt(p, t.id, 2, { ...t.transform, x: 10 }, true);
    const c = p.clips.find((x) => x.id === t.id)!;
    expect(c.type !== 'audio' && c.keyframes.map((k) => k.t)).toEqual([0, 2]);
    expect(evaluateScene(p, 0)[0]!.transform.x).toBeCloseTo(x0);
    expect(evaluateScene(p, 2)[0]!.transform.x).toBeCloseTo(10);
    expect(evaluateScene(p, 1)[0]!.transform.x).not.toBeCloseTo(x0); // se move entre os nós
    // sem o modo, continua mudando o item inteiro
    let q = placeClip(createProject('q', 'reel'), createTextClip(p, 'plain', 0));
    const id = q.clips[0]!.id;
    q = setTransformAt(q, id, 2, { ...(q.clips[0] as { transform: Transform }).transform, x: 10 });
    expect((q.clips[0] as { keyframes: unknown[] }).keyframes).toHaveLength(0);
  });

  it('Pan/Crop: o corte vira nó e anima entre os nós', () => {
    let p = createProject('c', 'reel');
    const v = createVideoClip(p, { ...video, duration: 10 }, 0);
    p = placeClip(p, v, p.tracks[0]!.id);
    const tr = v.transform;
    p = setCropAt(p, v.id, 0, tr, { l: 0, t: 0, r: 0, b: 0 }, true);
    p = setCropAt(p, v.id, 4, { ...tr, width: tr.width * 0.5 }, { l: 0.5, t: 0, r: 0, b: 0 }, true);
    const c = p.clips.find((x) => x.id === v.id)!;
    expect(c.type === 'video' && c.keyframes.map((k) => [k.t, k.crop?.l])).toEqual([[0, 0], [4, 0.5]]);
    expect(effectiveCrop(c as VisualClip, 4)!.l).toBeCloseTo(0.5);
    const mid = effectiveCrop(c as VisualClip, 2)!.l;
    expect(mid).toBeGreaterThan(0.05);
    expect(mid).toBeLessThan(0.45);
    // mover em outro instante mantém o corte daquele instante no nó novo
    p = setTransformAt(p, v.id, 6, { ...tr, x: 100 }, true);
    const c2 = p.clips.find((x) => x.id === v.id)!;
    expect(c2.type === 'video' && c2.keyframes.find((k) => k.t === 6)?.crop?.l).toBeCloseTo(0.5);
  });

  it('moldura é item normal: entra na agulha, pode haver várias e enquadra o vídeo do trecho', () => {
    let p = createProject('m', 'reel');
    p = placeClip(p, createVideoClip(p, { ...video, duration: 20 }, 0), p.tracks[0]!.id);
    for (const f of FRAMES) {
      const r = insertFrame(p, f.id, 2);
      expect(ProjectSchema.safeParse(r.project).success).toBe(true);
      const fr = r.project.clips.find((c) => c.id === r.clipId)!;
      expect(fr.start).toBe(2);
      expect(fr.duration).toBeCloseTo(15);
    }
    // duas molduras no mesmo trecho: as duas existem, em trilhas de moldura diferentes
    const a2 = insertFrame(p, 'topo', 0).project;
    const b2 = insertFrame(a2, 'central', 0).project;
    const frames = b2.clips.filter((c) => c.type === 'frame');
    expect(frames).toHaveLength(2);
    expect(new Set(frames.map((c) => c.trackId)).size).toBe(2);
    // trilhas de moldura logo acima da principal, abaixo das manchetes
    expect(b2.tracks[1]!.name.startsWith('Moldura')).toBe(true);
    expect(b2.tracks[2]!.name.startsWith('Moldura')).toBe(true);
    // moldura em outro trecho não briga com a primeira: reaproveita a mesma trilha
    const c2 = insertFrame(a2, 'editorial', 16).project;
    expect(c2.tracks.filter((t) => t.name.startsWith('Moldura'))).toHaveLength(1);
    const win = frameWindow(getFrame('central'), p.width, p.height);
    const v = b2.clips.find((c) => c.type === 'video')!;
    expect(v.type === 'video' && v.transform.height).toBeCloseTo(win.h);
    expect(v.type === 'video' && v.transform.y).toBeCloseTo(win.y + win.h / 2);
  });

  it('corte: arrastar a borda corta só aquele lado e mantém o resto parado', () => {
    const tr = { x: 500, y: 500, width: 400, height: 200, rotation: 0, opacity: 1 };
    const r = dragCrop(tr, NO_CROP, 'l', 100);
    expect(r.crop.l).toBeCloseTo(0.25);
    expect(r.transform.width).toBeCloseTo(300);
    // borda direita continua no mesmo lugar
    expect(r.transform.x + r.transform.width / 2).toBeCloseTo(700);
    const back = removeCrop(r.transform, r.crop);
    expect(back.width).toBeCloseTo(400);
    expect(back.x).toBeCloseTo(500);
    const t2 = dragCrop(tr, NO_CROP, 'b', -50);
    expect(t2.crop.b).toBeCloseTo(0.25);
    expect(t2.transform.y - t2.transform.height / 2).toBeCloseTo(400); // topo parado
  });

  it('disfarce de voz entra no plano de áudio e no FFmpeg sem mudar a duração', () => {
    let p = createProject('v', 'reel');
    const v = createVideoClip(p, video, 0);
    v.voice = 'high';
    p = placeClip(p, v, p.tracks[0]!.id);
    const plan = buildAudioPlan(p);
    expect(plan[0]!.pitch).toBeGreaterThan(1);
    const g = buildFfmpegAudioGraph(plan, new Map([['m', 1]]), 8)!;
    expect(g.filter).toMatch(/asetrate=\d+,aresample=48000,atempo=0\.\d+/);
  });

  it('elementos entram na agulha com no máximo 15 s e sem passar do fim do vídeo', () => {
    let p = createProject('d', 'reel');
    const long = { ...video, duration: 60 };
    p = placeClip(p, createVideoClip(p, long, 0), p.tracks[0]!.id);
    const t = createTextClip(p, 'pn-faixa', 10);
    expect(t.start).toBe(10);
    expect(t.duration).toBe(15);
    expect(createTextClip(p, 'pn-faixa', 55).duration).toBeCloseTo(5);
    const empty = createProject('e', 'reel');
    expect(createTextClip(empty, 'pn-faixa', 0).duration).toBe(15);
    // desfoque/filtro nascem com 5 s (bordas à vista para esticar/encolher), sem passar do fim
    expect(createBlurClip(p, { x: 0, y: 0, width: 10, height: 10 }, 50).duration).toBeCloseTo(5);
    expect(createBlurClip(p, { x: 0, y: 0, width: 10, height: 10 }, 57).duration).toBeCloseTo(3);
  });

  it('quadros de exportação', () => {
    expect(frameTimes(1, 30)).toHaveLength(30);
    expect(frameTimes(1, 30)[29]).toBeCloseTo(29 / 30);
  });
});
