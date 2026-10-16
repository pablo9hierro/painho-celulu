import type { Animation, Crop, Keyframe, Transform } from './model';

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export const ease = {
  linear: (t: number) => t,
  'ease-in': (t: number) => t * t * t,
  'ease-out': (t: number) => 1 - Math.pow(1 - t, 3),
  'ease-in-out': (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  outBack: (t: number) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },
  outExpo: (t: number) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
};

/** Progresso normalizado de um subintervalo [a,b] dentro de p ∈ [0,1]. */
export function seg(p: number, a: number, b: number): number {
  if (b <= a) return p >= b ? 1 : 0;
  return clamp((p - a) / (b - a), 0, 1);
}

export interface AnimState {
  opacity: number;
  dx: number;
  dy: number;
  scale: number;
  /** fração revelada da esquerda para a direita (1 = completa) */
  reveal: number;
}

export const IDENTITY_ANIM: AnimState = { opacity: 1, dx: 0, dy: 0, scale: 1, reveal: 1 };

/**
 * Estado de animação genérico. `p` = 1 significa totalmente visível.
 * Para a entrada p cresce 0→1; para a saída usamos o mesmo cálculo com p decrescendo.
 */
export function animState(type: Animation['type'], p: number, size: { w: number; h: number }): AnimState {
  const e = ease['ease-out'](clamp(p, 0, 1));
  const s: AnimState = { ...IDENTITY_ANIM };
  switch (type) {
    case 'none':
    case 'preset':
      return s;
    case 'fade':
      s.opacity = e;
      return s;
    case 'slide-up':
      s.dy = (1 - e) * size.h * 0.6;
      s.opacity = clamp(p * 2, 0, 1);
      return s;
    case 'slide-down':
      s.dy = -(1 - e) * size.h * 0.6;
      s.opacity = clamp(p * 2, 0, 1);
      return s;
    case 'slide-left':
      s.dx = (1 - e) * size.w * 0.5;
      s.opacity = clamp(p * 2, 0, 1);
      return s;
    case 'slide-right':
      s.dx = -(1 - e) * size.w * 0.5;
      s.opacity = clamp(p * 2, 0, 1);
      return s;
    case 'zoom-in':
      s.scale = lerp(0.6, 1, e);
      s.opacity = e;
      return s;
    case 'zoom-out':
      s.scale = lerp(1.4, 1, e);
      s.opacity = e;
      return s;
    case 'wipe':
      s.reveal = ease['ease-in-out'](clamp(p, 0, 1));
      return s;
    case 'pop':
      s.scale = Math.max(0, ease.outBack(clamp(p, 0, 1)));
      s.opacity = clamp(p * 3, 0, 1);
      return s;
  }
}

export function combineAnim(a: AnimState, b: AnimState): AnimState {
  return {
    opacity: a.opacity * b.opacity,
    dx: a.dx + b.dx,
    dy: a.dy + b.dy,
    scale: a.scale * b.scale,
    reveal: Math.min(a.reveal, b.reveal),
  };
}

/** Progresso de entrada e saída de um clipe no tempo local. */
export function inOutProgress(
  localT: number,
  duration: number,
  animIn: Animation,
  animOut: Animation,
): { inP: number; outP: number } {
  // Entrada e saída não podem se sobrepor: cada uma ocupa no máximo metade.
  const inD = Math.min(animIn.duration, duration / 2);
  const outD = Math.min(animOut.duration, duration / 2);
  const inP = animIn.type === 'none' || inD <= 0 ? 1 : clamp(localT / inD, 0, 1);
  const outP = animOut.type === 'none' || outD <= 0 ? 1 : clamp((duration - localT) / outD, 0, 1);
  return { inP, outP };
}

const KF_FIELDS = ['x', 'y', 'width', 'height', 'rotation', 'opacity'] as const;

/** Interpola keyframes. Sem keyframes, devolve a transformação base. */
export function transformAt(base: Transform, keyframes: Keyframe[], localT: number): Transform {
  if (keyframes.length === 0) return base;
  const kfs = keyframes.length > 1 ? [...keyframes].sort((a, b) => a.t - b.t) : keyframes;
  const first = kfs[0]!;
  const last = kfs[kfs.length - 1]!;
  if (localT <= first.t) return pick(first);
  if (localT >= last.t) return pick(last);
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i]!;
    const b = kfs[i + 1]!;
    if (localT >= a.t && localT <= b.t) {
      const raw = b.t === a.t ? 1 : (localT - a.t) / (b.t - a.t);
      const t = ease[b.easing](raw);
      const out = {} as Transform;
      for (const f of KF_FIELDS) out[f] = lerp(a[f], b[f], t);
      return out;
    }
  }
  return pick(last);
}

function pick(k: Keyframe): Transform {
  return { x: k.x, y: k.y, width: k.width, height: k.height, rotation: k.rotation, opacity: k.opacity };
}

/** Insere ou substitui um keyframe no tempo local (tolerância de meio quadro). */
export function upsertKeyframe(
  keyframes: Keyframe[],
  t: number,
  tr: Transform,
  tolerance = 1 / 60,
  crop?: Crop,
): Keyframe[] {
  const next = keyframes.filter((k) => Math.abs(k.t - t) > tolerance);
  const node: Keyframe = { x: tr.x, y: tr.y, width: tr.width, height: tr.height, rotation: tr.rotation, opacity: tr.opacity, t, easing: 'ease-in-out' };
  if (crop) node.crop = { ...crop };
  next.push(node);
  return next.sort((a, b) => a.t - b.t);
}

const NO_CROP_VALUE: Crop = { l: 0, t: 0, r: 0, b: 0 };
const CROP_FIELDS = ['l', 't', 'r', 'b'] as const;

/** Corte efetivo no instante (nós com corte interpolam como o Pan/Crop do Vegas). */
export function cropAt(base: Crop | undefined, keyframes: Keyframe[], localT: number): Crop | undefined {
  if (!keyframes.some((k) => k.crop)) return base;
  const z = base ?? NO_CROP_VALUE;
  const kfs = [...keyframes].sort((a, b) => a.t - b.t);
  const get = (k: Keyframe) => k.crop ?? z;
  const first = kfs[0]!;
  const last = kfs[kfs.length - 1]!;
  if (localT <= first.t) return get(first);
  if (localT >= last.t) return get(last);
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i]!;
    const b = kfs[i + 1]!;
    if (localT >= a.t && localT <= b.t) {
      const raw = b.t === a.t ? 1 : (localT - a.t) / (b.t - a.t);
      const t = ease[b.easing](raw);
      const ca = get(a);
      const cb = get(b);
      const out = { ...NO_CROP_VALUE };
      for (const f of CROP_FIELDS) out[f] = lerp(ca[f], cb[f], t);
      return out;
    }
  }
  return get(last);
}
