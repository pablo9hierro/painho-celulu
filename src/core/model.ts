/**
 * Modelo de projeto — fonte única da verdade compartilhada por UI, preview,
 * exportação e backend. Código puro: sem DOM, sem Node.
 */
import { z } from 'zod';

export const FORMATS = {
  reel: { label: 'Reels 9:16', short: '9:16', width: 1080, height: 1920 },
  feed45: { label: 'Feed 4:5', short: '4:5', width: 1080, height: 1350 },
  feed11: { label: 'Feed 1:1', short: '1:1', width: 1080, height: 1080 },
  wide: { label: 'Paisagem 16:9', short: '16:9', width: 1920, height: 1080 },
} as const;
export type FormatId = keyof typeof FORMATS;

export const ANIM_TYPES = [
  'none',
  'preset',
  'fade',
  'slide-up',
  'slide-down',
  'slide-left',
  'slide-right',
  'zoom-in',
  'zoom-out',
  'wipe',
  'pop',
] as const;
export type AnimType = (typeof ANIM_TYPES)[number];

export const EASINGS = ['linear', 'ease-in-out', 'ease-out', 'ease-in'] as const;

const num = z.number().finite();

export const TransformSchema = z.object({
  /** centro do elemento em pixels do quadro */
  x: num,
  y: num,
  width: num.min(1),
  height: num.min(1),
  /** graus */
  rotation: num,
  opacity: num.min(0).max(1),
});
export type Transform = z.infer<typeof TransformSchema>;

export const KeyframeSchema = TransformSchema.extend({
  /** segundos relativos ao início do clipe */
  t: num.min(0),
  easing: z.enum(EASINGS),
});
export type Keyframe = z.infer<typeof KeyframeSchema>;

export const AnimationSchema = z.object({
  type: z.enum(ANIM_TYPES),
  duration: num.min(0).max(10),
});
export type Animation = z.infer<typeof AnimationSchema>;

export const AdjustSchema = z.object({
  brightness: num.min(0).max(3),
  contrast: num.min(0).max(3),
  saturation: num.min(0).max(3),
});
export type Adjust = z.infer<typeof AdjustSchema>;

const ClipBase = {
  id: z.string(),
  trackId: z.string(),
  name: z.string(),
  /** início na timeline (s) */
  start: num.min(0),
  /** duração na timeline (s) */
  duration: num.min(0.05),
};

const VisualBase = {
  ...ClipBase,
  transform: TransformSchema,
  keyframes: z.array(KeyframeSchema),
  animIn: AnimationSchema,
  animOut: AnimationSchema,
};

const AudioProps = {
  /** posição de início no arquivo de origem (s) */
  sourceIn: num.min(0),
  /** duração total do arquivo de origem (s) — limita o recorte */
  sourceDuration: num.min(0),
  speed: num.min(0.25).max(4),
  volume: num.min(0).max(2),
  muted: z.boolean(),
  fadeIn: num.min(0),
  fadeOut: num.min(0),
  /** disfarce de voz: aguda/grave (troca o tom sem mudar a velocidade) */
  voice: z.enum(['normal', 'high', 'low']).optional(),
};

/** Corte das bordas da mídia, em frações (0 = sem corte) */
export const CropSchema = z.object({
  l: num.min(0).max(0.95),
  t: num.min(0).max(0.95),
  r: num.min(0).max(0.95),
  b: num.min(0).max(0.95),
});
export type Crop = z.infer<typeof CropSchema>;

export const VideoClipSchema = z.object({
  type: z.literal('video'),
  ...VisualBase,
  ...AudioProps,
  mediaId: z.string(),
  hasAudio: z.boolean(),
  adjust: AdjustSchema,
  flipH: z.boolean(),
  crop: CropSchema.optional(),
  /** preenche o quadro por trás do vídeo com o próprio vídeo desfocado */
  backdrop: z.enum(['none', 'blur', 'color']),
  backdropColor: z.string(),
});

export const ImageClipSchema = z.object({
  type: z.literal('image'),
  ...VisualBase,
  mediaId: z.string(),
  adjust: AdjustSchema,
  flipH: z.boolean(),
  crop: CropSchema.optional(),
});

export const AudioClipSchema = z.object({
  type: z.literal('audio'),
  ...ClipBase,
  ...AudioProps,
  mediaId: z.string(),
});

export const TextStyleSchema = z.object({
  primary: z.string(),
  accent: z.string(),
  text: z.string(),
  highlight: z.string(),
  fontScale: num.min(0.2).max(5),
  align: z.enum(['left', 'center', 'right']),
  uppercase: z.boolean(),
});
export type TextStyle = z.infer<typeof TextStyleSchema>;

export const TextFieldsSchema = z.object({
  kicker: z.string(),
  title: z.string(),
  subtitle: z.string(),
});
export type TextFields = z.infer<typeof TextFieldsSchema>;

export const TextClipSchema = z.object({
  type: z.literal('text'),
  ...VisualBase,
  preset: z.string(),
  fields: TextFieldsSchema,
  style: TextStyleSchema,
});

export const BlurClipSchema = z.object({
  type: z.literal('blur'),
  ...VisualBase,
  shape: z.enum(['rect', 'ellipse']),
  mode: z.enum(['blur', 'pixelate']),
  /** 0–100 */
  intensity: num.min(0).max(100),
});

export const SponsorsClipSchema = z.object({
  type: z.literal('sponsors'),
  ...VisualBase,
  label: z.string(),
  mediaIds: z.array(z.string()),
  textColor: z.string(),
  lineColor: z.string(),
});

export const ShapeClipSchema = z.object({
  type: z.literal('shape'),
  ...VisualBase,
  shape: z.enum(['rect', 'scrim-bottom', 'scrim-top']),
  fill: z.string(),
  radius: num.min(0),
});

/**
 * Moldura: UMA camada que diagrama o quadro inteiro — fundo da marca fora da
 * janela do vídeo, logo, @perfil e (opcional) letreiro. Ocupa o quadro todo.
 */
export const FrameClipSchema = z.object({
  type: z.literal('frame'),
  ...VisualBase,
  frame: z.string(),
  /** texto do letreiro, quando a moldura tem letreiro */
  text: z.string(),
  /** ajustes da logo do cabeçalho feitos no preview (posição, opacidade, escondida) */
  logo: z
    .object({
      hidden: z.boolean(),
      dx: num,
      dy: num,
      opacity: num.min(0).max(1),
    })
    .optional(),
});

export const ClipSchema = z.discriminatedUnion('type', [
  FrameClipSchema,
  VideoClipSchema,
  ImageClipSchema,
  AudioClipSchema,
  TextClipSchema,
  BlurClipSchema,
  SponsorsClipSchema,
  ShapeClipSchema,
]);

export type VideoClip = z.infer<typeof VideoClipSchema>;
export type ImageClip = z.infer<typeof ImageClipSchema>;
export type AudioClip = z.infer<typeof AudioClipSchema>;
export type TextClip = z.infer<typeof TextClipSchema>;
export type BlurClip = z.infer<typeof BlurClipSchema>;
export type SponsorsClip = z.infer<typeof SponsorsClipSchema>;
export type ShapeClip = z.infer<typeof ShapeClipSchema>;
export type FrameClip = z.infer<typeof FrameClipSchema>;
export type Clip = z.infer<typeof ClipSchema>;
export type ClipType = Clip['type'];
export type VisualClip = Exclude<Clip, AudioClip>;
export type MediaClip = VideoClip | AudioClip;

export const TrackSchema = z.object({
  id: z.string(),
  kind: z.enum(['visual', 'audio']),
  name: z.string(),
  hidden: z.boolean(),
  muted: z.boolean(),
  locked: z.boolean(),
});
export type Track = z.infer<typeof TrackSchema>;

export const ProjectSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  name: z.string().min(1).max(200),
  format: z.enum(Object.keys(FORMATS) as [FormatId, ...FormatId[]]),
  width: z.number().int().min(16).max(4096),
  height: z.number().int().min(16).max(4096),
  fps: z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(60)]),
  background: z.string(),
  /** ordem = empilhamento: índice 0 é a camada mais ao fundo */
  tracks: z.array(TrackSchema),
  clips: z.array(ClipSchema),
});
export type Project = z.infer<typeof ProjectSchema>;

/** Metadados de mídia vindos do backend (não fazem parte do JSON do projeto). */
export interface MediaAsset {
  id: string;
  name: string;
  kind: 'video' | 'audio' | 'image';
  /** arquivo da pasta brand/ (logos, selos, molduras fornecidos pela redação) */
  brand?: boolean;
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  url: string;
  status: 'processing' | 'ready' | 'error';
  error?: string;
  thumbs: { url: string; count: number; interval: number; width: number; height: number } | null;
  waveform: string | null;
  size: number;
  createdAt: string;
}

export function isVisual(c: Clip): c is VisualClip {
  return c.type !== 'audio';
}

export function hasAudioProps(c: Clip): c is MediaClip {
  return c.type === 'video' || c.type === 'audio';
}

export function isTimeStretchable(c: Clip): boolean {
  return c.type === 'video' || c.type === 'audio';
}
