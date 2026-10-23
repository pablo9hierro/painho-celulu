/**
 * Molduras da marca. Cada moldura é UM clipe na timeline: desenha o fundo
 * Primeiras Notícias fora da janela do vídeo, a logo, o @perfil e, se tiver,
 * o letreiro. Ao aplicar, os vídeos são enquadrados na janela.
 */
import type { Clip, FrameClip, Project, Transform } from './model';
import { fitCover } from './factory';
import { uid } from './id';
import { newTrack } from './timeline';
import { graphicDuration } from './factory';

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FrameDef {
  id: string;
  name: string;
  description: string;
  /** janela do vídeo em frações do quadro */
  window: Rect;
  /** logo horizontal: centro e largura em frações do quadro */
  logo: { cx: number; cy: number; w: number };
  /** a logo preenche todo o cabeçalho (área acima da janela do vídeo) */
  logoFill?: boolean;
  /** @perfil: centro vertical em fração, ou null */
  handle: number | null;
  ticker: boolean;
  /** só para o post automático (não aparece na lista do editor) */
  hidden?: boolean;
}

export const FRAMES: FrameDef[] = [
  {
    // post de matéria no Reels: foto e manchete dentro do recorte 3:4 da grade do
    // perfil (12,5% a 87,5% da altura) e acima dos botões/legenda do Instagram
    id: 'reels-post',
    name: 'Post do Reels',
    description: 'Foto e manchete no alto: aparecem inteiras na miniatura do perfil e longe dos botões do Instagram.',
    window: { x: 0, y: 0.13, w: 1, h: 0.34 },
    logo: { cx: 0.5, cy: 0.065, w: 0.44 },
    logoFill: true,
    handle: 0.958,
    ticker: false,
    hidden: true,
  },
  {
    id: 'topo',
    name: 'Vídeo no topo',
    description: 'Logo no cabeçalho, vídeo em cima e espaço para a manchete embaixo.',
    window: { x: 0, y: 0.16, w: 1, h: 0.44 },
    logo: { cx: 0.5, cy: 0.08, w: 0.46 },
    logoFill: true,
    handle: 0.958,
    ticker: false,
  },
  {
    id: 'central',
    name: 'Vídeo central',
    description: 'Vídeo no meio, logo em cima e manchete embaixo.',
    window: { x: 0, y: 0.22, w: 1, h: 0.4 },
    logo: { cx: 0.5, cy: 0.11, w: 0.56 },
    logoFill: true,
    handle: 0.958,
    ticker: false,
  },
  {
    id: 'editorial',
    name: 'Janela editorial',
    description: 'Vídeo com margens, como uma página de jornal.',
    window: { x: 0.05, y: 0.16, w: 0.9, h: 0.48 },
    logo: { cx: 0.5, cy: 0.08, w: 0.5 },
    logoFill: true,
    handle: 0.958,
    ticker: false,
  },
  {
    id: 'cheia',
    name: 'Tela cheia',
    description: 'Vídeo ocupando tudo, logo no canto e @perfil.',
    window: { x: 0, y: 0, w: 1, h: 1 },
    logo: { cx: 0.8, cy: 0.075, w: 0.34 },
    handle: 0.958,
    ticker: false,
  },
  {
    id: 'letreiro',
    name: 'Tela cheia com letreiro',
    description: 'Vídeo em tela cheia com letreiro correndo no rodapé.',
    window: { x: 0, y: 0, w: 1, h: 1 },
    logo: { cx: 0.8, cy: 0.075, w: 0.34 },
    handle: null,
    ticker: true,
  },
];

export const DEFAULT_TICKER = 'Acompanhe as principais notícias da Paraíba e do Brasil em primeirasnoticias.com.br';

export function getFrame(id: string): FrameDef {
  return FRAMES.find((f) => f.id === id) ?? FRAMES.find((f) => !f.hidden)!;
}

export function frameWindow(def: FrameDef, W: number, H: number) {
  return { x: def.window.x * W, y: def.window.y * H, w: def.window.w * W, h: def.window.h * H };
}

export interface FrameLogoState {
  hidden: boolean;
  dx: number;
  dy: number;
  opacity: number;
}
export const FRAME_LOGO_DEFAULT: FrameLogoState = { hidden: false, dx: 0, dy: 0, opacity: 1 };
/** logo horizontal no cabeçalho das molduras (desligada a pedido: só o fundo) */
export const FRAME_HEADER_LOGO = false;

/** Retângulo padrão da logo do cabeçalho (`ratio` = largura/altura da logo horizontal). */
export function frameLogoBox(def: FrameDef, W: number, H: number, ratio: number) {
  const win = frameWindow(def, W, H);
  if (def.logoFill && win.y > 0) {
    // logo grande preenchendo todo o cabeçalho acima da janela do vídeo
    const h = Math.min(win.y * 0.86, (W * 0.94) / ratio);
    const w = h * ratio;
    return { x: (W - w) / 2, y: (win.y - h) / 2, w, h };
  }
  const w = def.logo.w * W;
  const h = w / ratio;
  return { x: def.logo.cx * W - w / 2, y: def.logo.cy * H - h / 2, w, h };
}

/** Onde a logo da moldura está (com o ajuste do usuário); null se escondida. */
export function frameLogoRect(clip: { frame: string; logo?: FrameLogoState }, W: number, H: number, ratio: number): { x: number; y: number; w: number; h: number } | null {
  // a logo do cabeçalho saiu das molduras (fica só o fundo com a logo passando atrás)
  if (!FRAME_HEADER_LOGO) return null;
  const st = clip.logo ?? FRAME_LOGO_DEFAULT;
  if (st.hidden) return null;
  const b = frameLogoBox(getFrame(clip.frame), W, H, ratio);
  return { x: b.x + st.dx, y: b.y + st.dy, w: b.w, h: b.h };
}

/** Enquadra uma mídia (proporção `ratio`) cobrindo a janela da moldura. */
export function coverWindow(def: FrameDef, W: number, H: number, ratio: number): Transform {
  const win = frameWindow(def, W, H);
  const tr = fitCover(ratio * 1000, 1000, win.w, win.h);
  return { ...tr, x: win.x + win.w / 2, y: win.y + win.h / 2 };
}

/** Moldura ativa no instante `t` (a de cima, se houver mais de uma). */
export function frameAt(p: Project, t: number): FrameClip | undefined {
  let found: FrameClip | undefined;
  for (const track of p.tracks) {
    for (const c of p.clips) {
      if (c.type === 'frame' && c.trackId === track.id && t >= c.start && t < c.start + c.duration) found = c;
    }
  }
  return found;
}

/** Enquadra na janela da moldura os vídeos que tocam durante o trecho [start, end). */
export function fitVideosToFrame(p: Project, def: FrameDef, start: number, end: number): Project {
  const W = p.width;
  const H = p.height;
  return {
    ...p,
    clips: p.clips.map((c): Clip => {
      if (c.type !== 'video' || c.start >= end || c.start + c.duration <= start) return c;
      const ratio = c.transform.width / c.transform.height;
      return { ...c, transform: { ...coverWindow(def, W, H, ratio), opacity: c.transform.opacity }, keyframes: [], backdrop: 'none' };
    }),
  };
}

/**
 * Insere uma moldura como item normal da timeline, na agulha (`start`), com a
 * mesma duração padrão dos outros itens. Pode haver várias: cada uma fica numa
 * trilha de molduras logo acima da principal (abaixo das manchetes) e enquadra
 * os vídeos do seu trecho.
 */
export function insertFrame(input: Project, frameId: string, start: number): { project: Project; clipId: string } {
  const def = getFrame(frameId);
  const W = input.width;
  const H = input.height;
  const duration = graphicDuration(input, start, null);
  const end = start + duration;
  let tracks = input.tracks;
  // trilhas de moldura: só contêm molduras (ou estão vazias e se chamam Moldura)
  const isFrameTrack = (id: string) => {
    const tr = tracks.find((x) => x.id === id)!;
    const own = input.clips.filter((c) => c.trackId === id);
    return tr.kind === 'visual' && (own.length ? own.every((c) => c.type === 'frame') : tr.name.startsWith('Moldura'));
  };
  const frameTracks = tracks.filter((x) => x.kind === 'visual' && isFrameTrack(x.id));
  let trackId = frameTracks.find((x) => !input.clips.some((c) => c.trackId === x.id && c.start < end - 1e-6 && c.start + c.duration > start + 1e-6))?.id;
  if (!trackId) {
    const n = frameTracks.length;
    const t = newTrack('visual', n ? `Moldura ${n + 1}` : 'Moldura');
    const mainIdx = tracks.findIndex((x) => x.kind === 'visual');
    const lastFrameIdx = frameTracks.length ? tracks.indexOf(frameTracks[frameTracks.length - 1]!) : mainIdx;
    tracks = [...tracks.slice(0, lastFrameIdx + 1), t, ...tracks.slice(lastFrameIdx + 1)];
    trackId = t.id;
  }
  const clip: FrameClip = {
    type: 'frame',
    id: uid(),
    trackId,
    name: `Moldura · ${def.name}`,
    start,
    duration,
    transform: { x: W / 2, y: H / 2, width: W, height: H, rotation: 0, opacity: 1 },
    keyframes: [],
    animIn: { type: 'none', duration: 1 },
    animOut: { type: 'none', duration: 1 },
    frame: def.id,
    text: DEFAULT_TICKER,
  };
  const fitted = fitVideosToFrame({ ...input, tracks }, def, start, end);
  return { project: { ...fitted, clips: [...fitted.clips, clip] }, clipId: clip.id };
}
