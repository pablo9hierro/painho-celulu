/** Edições de alto nível sobre clipes, compartilhadas por canvas, inspector e atalhos. */
import type { Clip, Project, Transform, VisualClip } from './model';
import { isVisual } from './model';
import { transformAt, upsertKeyframe } from './animation';

export function updateClip<T extends Clip>(p: Project, id: string, fn: (c: T) => T): Project {
  return { ...p, clips: p.clips.map((c) => (c.id === id ? fn(c as T) : c)) };
}

export function patchClip(p: Project, id: string, patch: Partial<Clip>): Project {
  return { ...p, clips: p.clips.map((c) => (c.id === id ? ({ ...c, ...patch } as Clip) : c)) };
}

/**
 * Define a transformação de um clipe no instante `t` da timeline. Se o clipe já
 * tem keyframes, grava/atualiza um keyframe naquele instante; senão altera a base.
 */
/**
 * Grava a transformação no instante `t`. Com keyframes, cria/atualiza o nó na
 * agulha. Com `auto` (modo Movimento, como o Event Pan/Crop do Vegas), um item
 * ainda sem keyframes ganha um nó no início com a posição antiga e outro na
 * agulha com a nova — o item passa a se mover entre eles.
 */
export function setTransformAt(p: Project, id: string, t: number, tr: Transform, auto = false): Project {
  return updateClip<VisualClip>(p, id, (c) => {
    if (!isVisual(c)) return c;
    const local = Math.min(c.duration, Math.max(0, t - c.start));
    if (c.keyframes.length) return { ...c, keyframes: upsertKeyframe(c.keyframes, local, tr) };
    if (auto) {
      const first = upsertKeyframe([], 0, local > 1 / 60 ? c.transform : tr);
      return { ...c, transform: tr, keyframes: local > 1 / 60 ? upsertKeyframe(first, local, tr) : first };
    }
    return { ...c, transform: tr };
  });
}

/** Transformação efetiva (keyframes aplicados) no instante da timeline. */
export function effectiveTransform(c: VisualClip, t: number): Transform {
  return transformAt(c.transform, c.keyframes, Math.max(0, t - c.start));
}

/** Liga keyframes: cria o primeiro com o estado atual. Desliga: mantém o estado atual como base. */
export function toggleKeyframeAt(p: Project, id: string, t: number): Project {
  return updateClip<VisualClip>(p, id, (c) => {
    if (!isVisual(c)) return c;
    const local = Math.min(c.duration, Math.max(0, t - c.start));
    const cur = transformAt(c.transform, c.keyframes, local);
    const existing = c.keyframes.find((k) => Math.abs(k.t - local) < 1 / 60);
    if (existing) {
      const rest = c.keyframes.filter((k) => k !== existing);
      return { ...c, keyframes: rest, transform: rest.length ? c.transform : cur };
    }
    return { ...c, keyframes: upsertKeyframe(c.keyframes, local, cur) };
  });
}

export function clearKeyframes(p: Project, id: string, t: number): Project {
  return updateClip<VisualClip>(p, id, (c) => {
    if (!isVisual(c)) return c;
    return { ...c, transform: effectiveTransform(c, t), keyframes: [] };
  });
}
