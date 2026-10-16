/** Edições de alto nível sobre clipes, compartilhadas por canvas, inspector e atalhos. */
import type { Clip, Crop, Project, Transform, VisualClip } from './model';
import { isVisual } from './model';
import { cropAt, transformAt, upsertKeyframe } from './animation';

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
    // corte vigente neste instante (para o nó guardar e não "desfazer" o corte)
    const base = c.type === 'video' || c.type === 'image' ? c.crop : undefined;
    const hasCrop = !!base || c.keyframes.some((k) => k.crop);
    const cropNow = hasCrop ? cropAt(base, c.keyframes, local) : undefined;
    if (c.keyframes.length) return { ...c, keyframes: upsertKeyframe(c.keyframes, local, tr, undefined, cropNow) };
    if (auto) {
      const first = upsertKeyframe([], 0, local > 1 / 60 ? c.transform : tr, undefined, hasCrop ? base : undefined);
      return { ...c, transform: tr, keyframes: local > 1 / 60 ? upsertKeyframe(first, local, tr, undefined, cropNow) : first };
    }
    return { ...c, transform: tr };
  });
}

/**
 * Corte + caixa no instante `t` (alças de corte). Com nós (ou no modo Pan/Crop)
 * o corte fica gravado no nó da agulha e anima entre os nós, como no Vegas.
 */
export function setCropAt(p: Project, id: string, t: number, tr: Transform, crop: Crop, auto = false): Project {
  return updateClip<VisualClip>(p, id, (c) => {
    if (c.type !== 'video' && c.type !== 'image') return c;
    const local = Math.min(c.duration, Math.max(0, t - c.start));
    if (c.keyframes.length) return { ...c, keyframes: upsertKeyframe(c.keyframes, local, tr, undefined, crop) };
    if (auto) {
      const later = local > 1 / 60;
      const first = upsertKeyframe([], 0, later ? c.transform : tr, undefined, later ? (c.crop ?? { l: 0, t: 0, r: 0, b: 0 }) : crop);
      return { ...c, transform: tr, crop, keyframes: later ? upsertKeyframe(first, local, tr, undefined, crop) : first };
    }
    return { ...c, transform: tr, crop };
  });
}

/** Corte efetivo (nós aplicados) no instante da timeline. */
export function effectiveCrop(c: VisualClip, t: number): Crop | undefined {
  const base = c.type === 'video' || c.type === 'image' ? c.crop : undefined;
  return cropAt(base, c.keyframes, Math.max(0, t - c.start));
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
    const base = c.type === 'video' || c.type === 'image' ? c.crop : undefined;
    const curCrop = base || c.keyframes.some((k) => k.crop) ? cropAt(base, c.keyframes, local) : undefined;
    const existing = c.keyframes.find((k) => Math.abs(k.t - local) < 1 / 60);
    if (existing) {
      const rest = c.keyframes.filter((k) => k !== existing);
      return { ...c, keyframes: rest, transform: rest.length ? c.transform : cur };
    }
    return { ...c, keyframes: upsertKeyframe(c.keyframes, local, cur, undefined, curCrop) };
  });
}

export function clearKeyframes(p: Project, id: string, t: number): Project {
  return updateClip<VisualClip>(p, id, (c) => {
    if (!isVisual(c)) return c;
    const crop = effectiveCrop(c, t);
    return { ...c, transform: effectiveTransform(c, t), keyframes: [], ...(c.type === 'video' || c.type === 'image' ? { crop } : {}) } as VisualClip;
  });
}
