/**
 * Renderizador único da cena. O preview e a exportação chamam `renderFrame`
 * com o mesmo projeto e o mesmo tempo — o que se vê é o que se exporta.
 */
import type { Adjust, BlurClip, Crop, FrameClip, ImageClip, Project, ShapeClip, SponsorsClip, VideoClip } from '../core/model';
import { evaluateScene, type SceneItem } from '../core/scene';
import { getFrame, frameWindow, type FrameDef, frameLogoRect } from '../core/frames';
import { drawHandle, drawHeadline, drawTicker } from './headlines';
import { brandImage, brandVersion, drawLogo, LOGO_RATIO } from './brandAssets';
import { applyFont } from './text';
import { FONTS, PN } from '../core/brand';
import { cropAt } from '../core/animation';

type C = CanvasRenderingContext2D;

export interface MediaSources {
  /** quadro atual do vídeo (já posicionado em `mediaTime`) */
  video(clip: VideoClip, mediaTime: number): CanvasImageSource | null;
  image(mediaId: string): CanvasImageSource | null;
  /** dimensões naturais (para encaixe "contain" dos patrocinadores) */
  size(mediaId: string): { w: number; h: number } | null;
}

export interface RenderOptions {
  /** desenha marcadores de edição (slots vazios etc.). Desligado na exportação. */
  editorHints: boolean;
  /** ids ocultados temporariamente (ex.: texto em edição inline) */
  hidden?: Set<string>;
}

let scratch: HTMLCanvasElement | null = null;
let tiny: HTMLCanvasElement | null = null;

function scratchCanvas(w: number, h: number): CanvasRenderingContext2D {
  if (!scratch) scratch = document.createElement('canvas');
  if (scratch.width < w) scratch.width = w;
  if (scratch.height < h) scratch.height = h;
  const c = scratch.getContext('2d')!;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, w, h);
  return c;
}

function adjustFilter(a: Adjust): string {
  if (a.brightness === 1 && a.contrast === 1 && a.saturation === 1) return 'none';
  return `brightness(${a.brightness}) contrast(${a.contrast}) saturate(${a.saturation})`;
}

/**
 * Desenha o quadro completo em `ctx`. O canvas pode ter qualquer resolução:
 * `scale` = pixels do canvas por pixel do projeto.
 */
export function renderFrame(ctx: C, project: Project, t: number, src: MediaSources, opts: RenderOptions) {
  const scale = ctx.canvas.width / project.width;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.filter = 'none';
  ctx.fillStyle = project.background;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const items = evaluateScene(project, t);
  for (const it of items) {
    if (opts.hidden?.has(it.clip.id)) continue;
    drawItem(ctx, project, it, src, opts, scale);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.filter = 'none';
}

function drawItem(ctx: C, project: Project, it: SceneItem, src: MediaSources, opts: RenderOptions, scale: number) {
  const { clip, transform: tr, anim } = it;
  const alpha = tr.opacity * anim.opacity;
  if (alpha <= 0.001 || anim.scale <= 0.001) return;

  // fundo do vídeo é desenhado no espaço do quadro, antes da transformação
  if (clip.type === 'video' && clip.backdrop !== 'none') {
    ctx.save();
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.globalAlpha = alpha;
    if (clip.backdrop === 'color') {
      ctx.fillStyle = clip.backdropColor;
      ctx.fillRect(0, 0, project.width, project.height);
    } else {
      const frame = src.video(clip, it.mediaTime);
      if (frame) {
        const s = Math.max(project.width / tr.width, project.height / tr.height) * 1.08;
        const bw = tr.width * s;
        const bh = tr.height * s;
        ctx.filter = `blur(${Math.round(project.width * 0.035 * scale)}px) brightness(0.7) saturate(1.15)`;
        ctx.drawImage(frame, (project.width - bw) / 2, (project.height - bh) / 2, bw, bh);
        ctx.filter = 'none';
      }
    }
    ctx.restore();
  }

  ctx.save();
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.translate(tr.x + anim.dx, tr.y + anim.dy);
  ctx.rotate((tr.rotation * Math.PI) / 180);
  if (anim.scale !== 1) ctx.scale(anim.scale, anim.scale);
  ctx.globalAlpha = alpha;
  const w = tr.width;
  const h = tr.height;
  if (anim.reveal < 1) {
    ctx.beginPath();
    ctx.rect(-w / 2, -h / 2 - h, w * anim.reveal, h * 3);
    ctx.clip();
  }
  switch (clip.type) {
    case 'video': {
      const frame = src.video(clip, it.mediaTime);
      if (frame) drawMedia(ctx, frame, w, h, clip.adjust, clip.flipH, cropAt(clip.crop, clip.keyframes, it.localT), src.size(clip.mediaId));
      break;
    }
    case 'image': {
      const img = src.image(clip.mediaId);
      if (img) drawMedia(ctx, img, w, h, (clip as ImageClip).adjust, clip.flipH, cropAt((clip as ImageClip).crop, clip.keyframes, it.localT), src.size(clip.mediaId));
      break;
    }
    case 'text': {
      ctx.translate(-w / 2, -h / 2);
      const pIn = clip.animIn.type === 'preset' ? it.inP : 1;
      const pOut = clip.animOut.type === 'preset' ? it.outP : 1;
      drawHeadline(ctx, clip, { w, h, p: Math.min(pIn, pOut), t: it.localT });
      break;
    }
    case 'blur':
      drawBlur(ctx, clip, w, h, scale);
      break;
    case 'sponsors':
      drawSponsors(ctx, clip, w, h, src, opts);
      break;
    case 'shape':
      drawShape(ctx, clip, w, h);
      break;
    case 'frame':
      ctx.translate(-w / 2, -h / 2);
      drawFrame(ctx, clip, w, h, it.localT);
      break;
  }
  ctx.restore();
}

/**
 * A parte fixa da moldura (fundo, fios, logo, @perfil) é desenhada uma única vez
 * por tamanho e reaproveitada a cada quadro — mesmo resultado, muito menos trabalho.
 * Só o letreiro (que se move) é desenhado ao vivo.
 */
const frameCache = new Map<string, HTMLCanvasElement>();

/** Camada da moldura guardada em memória (fixa); recriada se a logo/escala mudar. */
function frameLayer(ctx: C, def: FrameDef, W: number, H: number, layer: 'bg' | 'fg'): HTMLCanvasElement {
  const m = ctx.getTransform();
  const k = Math.hypot(m.a, m.b); // pixels do canvas por pixel do projeto
  const key = `${def.id}:${layer}:${W}x${H}@${k.toFixed(4)}:v${brandVersion()}`;
  const hit = frameCache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(W * k));
  c.height = Math.max(1, Math.round(H * k));
  const cctx = c.getContext('2d')!;
  cctx.scale(c.width / W, c.height / H);
  if (layer === 'bg') drawFrameBackground(cctx, def, W, H);
  else drawFrameForeground(cctx, def, W, H);
  // só guarda depois que logos e fontes carregaram (senão ficariam faltando)
  if (brandImage('horizontal') && brandImage('round') && document.fonts.status === 'loaded') {
    if (frameCache.size > 16) frameCache.clear();
    frameCache.set(key, c);
  }
  return c;
}

function drawFrame(ctx: C, clip: FrameClip, W: number, H: number, t: number) {
  const def = getFrame(clip.frame);
  const win = frameWindow(def, W, H);
  const full = win.w >= W - 0.5 && win.h >= H - 0.5;
  ctx.drawImage(frameLayer(ctx, def, W, H, 'bg'), 0, 0, W, H);
  if (!full) drawFrameWatermark(ctx, win, W, H, t);
  ctx.drawImage(frameLayer(ctx, def, W, H, 'fg'), 0, 0, W, H);
  // logo do cabeçalho: ao vivo, com posição/opacidade ajustadas no preview
  const lr = frameLogoRect(clip, W, H, LOGO_RATIO.horizontal);
  const lo = clip.logo?.opacity ?? 1;
  if (lr && lo > 0) {
    ctx.save();
    ctx.globalAlpha *= lo;
    drawLogo(ctx, lr.x, lr.y, lr.h);
    ctx.restore();
  }
  if (def.ticker) {
    const th = W * 0.075;
    ctx.save();
    ctx.translate(0, H - th - H * 0.05);
    drawTicker(ctx, W, th, clip.text, t);
    ctx.restore();
  }
}

/**
 * Logo redonda grande e "vazada" no fundo azul da moldura, atravessando o quadro
 * devagar durante o tempo em que a moldura está no ar (só fora da janela do vídeo).
 */
/**
 * Posição do símbolo gigante no fundo da moldura no instante t (segundos desde
 * o início do item). Anda muito devagar, com a direção oscilando suavemente
 * (soma de senos lentos, sem viradas bruscas) e tendência geral para cima/esquerda.
 * Pode vazar pelas bordas; quando sai da tela por inteiro, reaparece do lado
 * oposto e continua. Determinístico: prévia e exportação mostram o mesmo.
 */
function watermarkPose(t: number, W: number, H: number, lw: number, lh: number) {
  const speed = W * 0.022; // px/s — muito lento
  const base = Math.atan2(-H, -W); // em direção ao canto superior esquerdo
  let x = W * 0.72;
  let y = H * 0.66;
  const dt = 1 / 15;
  const steps = Math.min(Math.ceil(Math.max(0, t) / dt), 20_000);
  for (let i = 0; i < steps; i++) {
    const s = Math.min(dt, t - i * dt);
    const u = i * dt;
    const ang = base + 1.15 * Math.sin(u * 0.11 + 1.3) + 0.65 * Math.sin(u * 0.27 + 4.1) + 0.3 * Math.sin(u * 0.53 + 0.7);
    const v = speed * (0.75 + 0.25 * Math.sin(u * 0.19 + 2.2));
    x += Math.cos(ang) * v * s;
    y += Math.sin(ang) * v * s;
    // saiu por inteiro: volta pelo lado oposto, ainda fora da tela, e entra andando
    if (x < -lw / 2) x += W + lw;
    else if (x > W + lw / 2) x -= W + lw;
    if (y < -lh / 2) y += H + lh;
    else if (y > H + lh / 2) y -= H + lh;
  }
  const rot = (3 * Math.PI / 180) * Math.sin(t * 0.17 + 0.5);
  return { x, y, rot };
}

/** Símbolo PN gigante e vazado passeando devagar no fundo da moldura (fora da janela do vídeo). */
function drawFrameWatermark(ctx: C, win: { x: number; y: number; w: number; h: number }, W: number, H: number, elapsed: number) {
  const img = brandImage('round');
  if (!img) return;
  const lw = W * 1.9;
  const lh = lw / LOGO_RATIO.round;
  const pose = watermarkPose(elapsed, W, H, lw, lh);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, W, H);
  ctx.rect(win.x, win.y, win.w, win.h);
  ctx.clip('evenodd');
  ctx.globalCompositeOperation = 'screen';
  ctx.globalAlpha *= 0.18;
  ctx.translate(pose.x, pose.y);
  ctx.rotate(pose.rot);
  ctx.drawImage(img, -lw / 2, -lh / 2, lw, lh);
  ctx.restore();
}

/** Fundo da moldura: azul da marca fora da janela, luz atrás da logo e feixes diagonais. */
function drawFrameBackground(ctx: C, def: FrameDef, W: number, H: number) {
  const win = frameWindow(def, W, H);
  const full = win.w >= W - 0.5 && win.h >= H - 0.5;
  if (full) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, W, H);
  ctx.rect(win.x, win.y, win.w, win.h);
  ctx.clip('evenodd');
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, PN.deep);
  g.addColorStop(0.5, PN.navy);
  g.addColorStop(1, '#07142a');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // luz atrás da logo do cabeçalho
  const lcy = def.logoFill ? win.y / 2 : def.logo.cy * H;
  const lg = ctx.createRadialGradient(W / 2, lcy, 0, W / 2, lcy, W * 0.6);
  lg.addColorStop(0, 'rgba(56,182,255,0.34)');
  lg.addColorStop(1, 'rgba(56,182,255,0)');
  ctx.fillStyle = lg;
  ctx.fillRect(0, 0, W, H);
  // feixes de luz diagonais (brilho "de estúdio")
  ctx.globalCompositeOperation = 'screen';
  for (const [x0, wBeam, a] of [
    [W * 0.12, W * 0.16, 0.07],
    [W * 0.62, W * 0.1, 0.05],
  ] as const) {
    const bg = ctx.createLinearGradient(x0, 0, x0 + wBeam, 0);
    bg.addColorStop(0, 'rgba(120,200,255,0)');
    bg.addColorStop(0.5, `rgba(120,200,255,${a})`);
    bg.addColorStop(1, 'rgba(120,200,255,0)');
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.moveTo(x0, 0);
    ctx.lineTo(x0 + wBeam, 0);
    ctx.lineTo(x0 + wBeam - H * 0.35, H);
    ctx.lineTo(x0 - H * 0.35, H);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

/** Frente da moldura: fios de acabamento e @perfil (a logo é desenhada ao vivo em drawFrame). */
function drawFrameForeground(ctx: C, def: FrameDef, W: number, H: number) {
  const win = frameWindow(def, W, H);
  const full = win.w >= W - 0.5 && win.h >= H - 0.5;
  if (!full) {
    const t1 = Math.max(3, H * 0.003);
    const t2 = Math.max(5, H * 0.005);
    ctx.save();
    ctx.shadowColor = 'rgba(56,182,255,0.85)';
    ctx.shadowBlur = H * 0.012;
    ctx.fillStyle = PN.sky;
    ctx.fillRect(win.x, win.y - t2, win.w, t2);
    ctx.fillRect(win.x, win.y + win.h, win.w, t2);
    ctx.restore();
    ctx.fillStyle = '#04101f';
    ctx.fillRect(win.x, win.y - t2 - t1, win.w, t1);
    ctx.fillRect(win.x, win.y + win.h + t2, win.w, t1);
  }
  if (def.handle !== null) {
    const hh = W * 0.075;
    ctx.save();
    ctx.translate(0, def.handle * H - hh / 2);
    drawHandle(ctx, W, hh, 'center');
    ctx.restore();
  }
}

/** Tamanho natural da fonte de imagem (vídeo, quadro decodificado, imagem ou canvas). */
function sourceSize(img: CanvasImageSource): { w: number; h: number } {
  if (img instanceof HTMLVideoElement) return { w: img.videoWidth, h: img.videoHeight };
  if (img instanceof HTMLImageElement) return { w: img.naturalWidth, h: img.naturalHeight };
  if (typeof VideoFrame !== 'undefined' && img instanceof VideoFrame) return { w: img.displayWidth, h: img.displayHeight };
  const anyImg = img as { width: number; height: number };
  return { w: anyImg.width, h: anyImg.height };
}

/**
 * Desenha a mídia na caixa do item SEM distorcer: mantém a proporção real
 * (`display` = tamanho de exibição da mídia, com rotação/pixel já aplicados) e
 * preenche a caixa cortando o excesso, como o TikTok. Com a caixa na proporção
 * da mídia (o normal), o resultado é a mídia inteira.
 */
function drawMedia(ctx: C, img: CanvasImageSource, w: number, h: number, adjust: Adjust, flip: boolean, crop?: Crop, display?: { w: number; h: number } | null) {
  const f = adjustFilter(adjust);
  if (f !== 'none') ctx.filter = f;
  if (flip) ctx.scale(-1, 1);
  const s = sourceSize(img);
  if (s.w > 0 && s.h > 0 && w > 0 && h > 0) {
    const d = display && display.w > 0 && display.h > 0 ? display : s;
    // pixels da fonte por unidade de exibição (corrige pixel não quadrado)
    const fx = s.w / d.w;
    const fy = s.h / d.h;
    const c = crop ?? { l: 0, t: 0, r: 0, b: 0 };
    let cx = c.l * d.w;
    let cy = c.t * d.h;
    let cw = Math.max(1e-3, (1 - c.l - c.r) * d.w);
    let ch = Math.max(1e-3, (1 - c.t - c.b) * d.h);
    const box = w / h;
    const reg = cw / ch;
    if (Math.abs(reg - box) / box > 0.002) {
      if (reg > box) {
        const nw = ch * box;
        cx += (cw - nw) / 2;
        cw = nw;
      } else {
        const nh = cw / box;
        cy += (ch - nh) / 2;
        ch = nh;
      }
    }
    ctx.drawImage(img, cx * fx, cy * fy, Math.max(1, cw * fx), Math.max(1, ch * fy), -w / 2, -h / 2, w, h);
  }
  ctx.filter = 'none';
}

/**
 * Desfoque/pixelização da região: copia o que já foi composto por baixo,
 * processa e devolve recortado pela máscara (retângulo ou elipse).
 */
function drawBlur(ctx: C, clip: BlurClip, w: number, h: number, scale: number) {
  if (clip.intensity <= 0) return;
  // caixa delimitadora em pixels do canvas
  const m = ctx.getTransform();
  const pts = [
    [-w / 2, -h / 2],
    [w / 2, -h / 2],
    [w / 2, h / 2],
    [-w / 2, h / 2],
  ].map(([x, y]) => ({ x: m.a * x! + m.c * y! + m.e, y: m.b * x! + m.d * y! + m.f }));
  const cw = ctx.canvas.width;
  const ch = ctx.canvas.height;
  const radius = (clip.intensity / 100) * 60 * scale;
  const pad = clip.mode === 'blur' ? Math.ceil(radius * 2) : 0;
  const x0 = Math.max(0, Math.floor(Math.min(...pts.map((p) => p.x)) - pad));
  const y0 = Math.max(0, Math.floor(Math.min(...pts.map((p) => p.y)) - pad));
  const x1 = Math.min(cw, Math.ceil(Math.max(...pts.map((p) => p.x)) + pad));
  const y1 = Math.min(ch, Math.ceil(Math.max(...pts.map((p) => p.y)) + pad));
  const bw = x1 - x0;
  const bh = y1 - y0;
  if (bw <= 1 || bh <= 1) return;

  const sc = scratchCanvas(bw, bh);
  sc.drawImage(ctx.canvas, x0, y0, bw, bh, 0, 0, bw, bh);

  // máscara no espaço local do elemento
  ctx.beginPath();
  if (clip.shape === 'ellipse') ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
  else ctx.rect(-w / 2, -h / 2, w, h);
  ctx.clip();

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (clip.mode === 'blur') {
    // borda estendida: desenha a cópia esticada por baixo para evitar halo escuro
    ctx.filter = `blur(${radius.toFixed(1)}px)`;
    ctx.drawImage(scratch!, 0, 0, bw, bh, x0 - pad, y0 - pad, bw + pad * 2, bh + pad * 2);
    ctx.drawImage(scratch!, 0, 0, bw, bh, x0, y0, bw, bh);
    ctx.filter = 'none';
  } else {
    const block = Math.max(4, (clip.intensity / 100) * 48 * scale);
    const tw = Math.max(1, Math.round(bw / block));
    const th = Math.max(1, Math.round(bh / block));
    if (!tiny) tiny = document.createElement('canvas');
    tiny.width = tw;
    tiny.height = th;
    const tc = tiny.getContext('2d')!;
    tc.imageSmoothingEnabled = true;
    tc.drawImage(scratch!, 0, 0, bw, bh, 0, 0, tw, th);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tiny, 0, 0, tw, th, x0, y0, bw, bh);
    ctx.imageSmoothingEnabled = true;
  }
  ctx.restore();
}

function drawSponsors(ctx: C, clip: SponsorsClip, w: number, h: number, src: MediaSources, opts: RenderOptions) {
  ctx.translate(-w / 2, -h / 2);
  const labelH = h * 0.26;
  if (clip.label) {
    applyFont(ctx, { family: FONTS.sans, weight: 600, tracking: 0.04 }, labelH * 0.8);
    const lw = ctx.measureText(clip.label).width;
    ctx.fillStyle = clip.textColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(clip.label, w / 2, labelH / 2);
    const gap = labelH * 0.8;
    ctx.fillStyle = clip.lineColor;
    const lineH = Math.max(1.5, labelH * 0.08);
    const side = (w - lw) / 2 - gap;
    if (side > 0) {
      ctx.fillRect(0, labelH / 2 - lineH / 2, side, lineH);
      ctx.fillRect(w - side, labelH / 2 - lineH / 2, side, lineH);
    }
  }
  const rowY = labelH * 1.35;
  const rowH = h - rowY;
  const n = Math.max(1, clip.mediaIds.length || (opts.editorHints ? 3 : 0));
  const slotW = w / n;
  const pad = slotW * 0.08;
  for (let i = 0; i < n; i++) {
    const id = clip.mediaIds[i];
    const sx = i * slotW + pad;
    const sw = slotW - pad * 2;
    if (!id) {
      if (!opts.editorHints) continue;
      ctx.save();
      ctx.setLineDash([8, 6]);
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 2;
      ctx.strokeRect(sx, rowY, sw, rowH);
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      applyFont(ctx, { family: FONTS.ui, weight: 500 }, rowH * 0.22);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('logo', sx + sw / 2, rowY + rowH / 2);
      ctx.restore();
      continue;
    }
    const img = src.image(id);
    const sz = src.size(id);
    if (!img || !sz) continue;
    const s = Math.min(sw / sz.w, rowH / sz.h);
    const dw = sz.w * s;
    const dh = sz.h * s;
    ctx.drawImage(img, sx + (sw - dw) / 2, rowY + (rowH - dh) / 2, dw, dh);
  }
}

function drawShape(ctx: C, clip: ShapeClip, w: number, h: number) {
  if (clip.shape === 'rect') {
    ctx.fillStyle = clip.fill;
    ctx.beginPath();
    const r = Math.min(clip.radius, w / 2, h / 2);
    if (r > 0) ctx.roundRect(-w / 2, -h / 2, w, h, r);
    else ctx.rect(-w / 2, -h / 2, w, h);
    ctx.fill();
    return;
  }
  const g =
    clip.shape === 'scrim-bottom'
      ? ctx.createLinearGradient(0, -h / 2, 0, h / 2)
      : ctx.createLinearGradient(0, h / 2, 0, -h / 2);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, clip.fill);
  ctx.fillStyle = g;
  ctx.fillRect(-w / 2, -h / 2, w, h);
}
