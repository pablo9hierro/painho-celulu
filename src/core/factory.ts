/** Criação de projetos e elementos com padrões coerentes. */
import type {
  Adjust,
  AudioClip,
  BlurClip,
  FormatId,
  ImageClip,
  MediaAsset,
  Project,
  ShapeClip,
  SponsorsClip,
  TextClip,
  Transform,
  VideoClip,
} from './model';
import { FORMATS } from './model';
import { uid } from './id';
import { newTrack, projectDuration } from './timeline';
import { getPreset } from './presets';
import { PN } from './brand';

export const NEUTRAL_ADJUST: Adjust = { brightness: 1, contrast: 1, saturation: 1 };

export function createProject(name: string, format: FormatId, fps: Project['fps'] = 30): Project {
  const f = FORMATS[format];
  return {
    schemaVersion: 1,
    id: uid(),
    name,
    format,
    width: f.width,
    height: f.height,
    fps,
    background: PN.navy,
    tracks: [newTrack('visual', 'Principal'), newTrack('visual', 'Camada 2'), newTrack('audio', 'Áudio 1')],
    clips: [],
  };
}

/** Encaixe "contain": o maior retângulo com a proporção da mídia que cabe no quadro. */
export function fitContain(mw: number, mh: number, W: number, H: number): Transform {
  const s = Math.min(W / mw, H / mh);
  return { x: W / 2, y: H / 2, width: mw * s, height: mh * s, rotation: 0, opacity: 1 };
}

/** Encaixe "cover": cobre todo o quadro, cortando o excedente. */
export function fitCover(mw: number, mh: number, W: number, H: number): Transform {
  const s = Math.max(W / mw, H / mh);
  return { x: W / 2, y: H / 2, width: mw * s, height: mh * s, rotation: 0, opacity: 1 };
}

const noAnim = { type: 'none' as const, duration: 0.5 };

/** Duração máxima de um elemento recém-inserido; para estender, arraste a borda na timeline. */
export const MAX_SPAWN_SECONDS = 15;

/**
 * Duração padrão de um elemento inserido na agulha: no máximo 15 s (ou a
 * duração própria do preset) e nunca além do fim do vídeo — inserir um
 * elemento não pode aumentar o vídeo exportado.
 */
export function graphicDuration(p: Project, start: number, preferred: number | null): number {
  const cap = Math.min(preferred ?? MAX_SPAWN_SECONDS, MAX_SPAWN_SECONDS);
  const until = projectDuration(p) - start;
  return until > 0.5 ? Math.min(cap, until) : cap;
}

export function createVideoClip(p: Project, m: MediaAsset, start: number): VideoClip {
  return {
    type: 'video',
    id: uid(),
    trackId: '',
    name: m.name,
    start,
    duration: Math.max(0.1, m.duration || 5),
    transform: fitContain(m.width || p.width, m.height || p.height, p.width, p.height),
    keyframes: [],
    animIn: { ...noAnim },
    animOut: { ...noAnim },
    mediaId: m.id,
    hasAudio: m.hasAudio,
    sourceIn: 0,
    sourceDuration: m.duration,
    speed: 1,
    volume: 1,
    muted: false,
    fadeIn: 0,
    fadeOut: 0,
    adjust: { ...NEUTRAL_ADJUST },
    flipH: false,
    backdrop: 'none',
    backdropColor: PN.navy,
  };
}

/**
 * Imagens de marca (logos/selos) e imagens pequenas entram no canto superior
 * direito, durante todo o vídeo — o uso típico é cobrir marcas d'água de terceiros.
 */
export function createImageClip(p: Project, m: MediaAsset, start: number): ImageClip {
  const mw = m.width || p.width;
  const mh = m.height || p.height;
  const isLogoLike = m.brand || (mw < p.width * 0.6 && mh < p.height * 0.4);
  let tr: Transform;
  if (isLogoLike) {
    const box = fitContain(mw, mh, p.width * 0.3, p.height * 0.14);
    const margin = p.width * 0.05;
    tr = { ...box, x: p.width - margin - box.width / 2, y: margin * (p.height > p.width ? 2.4 : 1) + box.height / 2 };
  } else {
    tr = fitContain(mw, mh, p.width, p.height);
  }
  return {
    type: 'image',
    id: uid(),
    trackId: '',
    name: m.name,
    start,
    duration: graphicDuration(p, start, isLogoLike ? null : 5),
    transform: tr,
    keyframes: [],
    animIn: { ...noAnim },
    animOut: { ...noAnim },
    mediaId: m.id,
    adjust: { ...NEUTRAL_ADJUST },
    flipH: false,
  };
}

export function createAudioClip(_p: Project, m: MediaAsset, start: number): AudioClip {
  return {
    type: 'audio',
    id: uid(),
    trackId: '',
    name: m.name,
    start,
    duration: Math.max(0.1, m.duration || 1),
    mediaId: m.id,
    sourceIn: 0,
    sourceDuration: m.duration,
    speed: 1,
    volume: 1,
    muted: false,
    fadeIn: 0,
    fadeOut: 0,
  };
}

export function createTextClip(p: Project, presetId: string, start: number): TextClip {
  const pr = getPreset(presetId);
  const W = p.width;
  const H = p.height;
  // A altura do preset é pensada para 1080×1920; em formatos baixos, preserva a
  // altura absoluta (proporcional à largura) limitada a 60% do quadro.
  const height = Math.min(H * 0.6, pr.size.h * 1920 * (W / 1080) * (W > H ? 0.6 : 1));
  return {
    type: 'text',
    id: uid(),
    trackId: '',
    name: pr.name,
    start,
    duration: graphicDuration(p, start, pr.defaultDuration),
    transform: {
      x: pr.pos.x * W,
      y: Math.min(H - height / 2, Math.max(height / 2, pr.pos.y * H)),
      width: pr.size.w * W,
      height,
      rotation: 0,
      opacity: pr.opacity ?? 1,
      // post animado: o quadro inteiro
      ...(pr.fullFrame ? { x: W / 2, y: H / 2, width: W, height: H } : {}),
    },
    keyframes: [],
    animIn: { ...pr.animIn },
    animOut: { ...pr.animOut },
    preset: pr.id,
    fields: { ...pr.fields },
    style: { ...pr.style },
  };
}

export function createBlurClip(
  p: Project,
  rect: { x: number; y: number; width: number; height: number },
  start: number,
  shape: BlurClip['shape'] = 'rect',
): BlurClip {
  return {
    type: 'blur',
    id: uid(),
    trackId: '',
    name: shape === 'ellipse' ? 'Desfoque oval' : 'Desfoque',
    start,
    // 5 s: as duas bordas ficam à vista na timeline para esticar/encolher (sanfona)
    duration: graphicDuration(p, start, 5),
    transform: { ...rect, rotation: 0, opacity: 1 },
    keyframes: [],
    animIn: { ...noAnim },
    animOut: { ...noAnim },
    shape,
    mode: 'blur',
    intensity: 60,
  };
}

export function createSponsorsClip(p: Project, mediaIds: string[], start: number): SponsorsClip {
  const W = p.width;
  return {
    type: 'sponsors',
    id: uid(),
    trackId: '',
    name: 'Oferecimento',
    start,
    duration: graphicDuration(p, start, null),
    transform: { x: W / 2, y: p.height * 0.9, width: W * 0.86, height: W * 0.15, rotation: 0, opacity: 1 },
    keyframes: [],
    animIn: { type: 'fade', duration: 0.5 },
    animOut: { type: 'fade', duration: 0.4 },
    label: 'Oferecimento',
    mediaIds,
    textColor: PN.white,
    lineColor: 'rgba(255,255,255,0.8)',
  };
}

export function createShapeClip(p: Project, shape: ShapeClip['shape'], start: number): ShapeClip {
  const W = p.width;
  const H = p.height;
  const isScrim = shape !== 'rect';
  const h = isScrim ? H * 0.4 : H * 0.12;
  return {
    type: 'shape',
    id: uid(),
    trackId: '',
    name: shape === 'rect' ? 'Retângulo' : shape === 'scrim-bottom' ? 'Sombra inferior' : 'Sombra superior',
    start,
    duration: graphicDuration(p, start, null),
    transform: {
      x: W / 2,
      y: shape === 'scrim-top' ? h / 2 : shape === 'scrim-bottom' ? H - h / 2 : H / 2,
      width: isScrim ? W : W * 0.8,
      height: h,
      rotation: 0,
      opacity: isScrim ? 0.85 : 1,
    },
    keyframes: [],
    animIn: { ...noAnim },
    animOut: { ...noAnim },
    shape,
    fill: isScrim ? PN.black : PN.navy,
    radius: 0,
  };
}
