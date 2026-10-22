/**
 * Desenho dos presets de manchete. Origem (0,0) = canto superior esquerdo da
 * caixa do elemento; `p` ∈ [0,1] é a presença (entrada/saída encenadas).
 *
 * Cores são SEMPRE as da marca. A logo Primeiras Notícias fica INCRUSTADA em
 * cada placa (ver incrust.ts): atrás do texto, em mesclagem de luz, presa à placa.
 */
import type { TextClip } from '../core/model';
import { clamp, ease, seg } from '../core/animation';
import { FONTS, PN } from '../core/brand';
import { getPreset } from '../core/presets';
import { applyFont, drawLines, fitText, lineX, type FontSpec } from './text';
import { brandImage, drawInstagramGlyph, LOGO_RATIO } from './brandAssets';
import { incrust } from './incrust';
import { edicao } from './edicao';
import { drawCaption } from './captions';

type C = CanvasRenderingContext2D;

export interface HeadlineArgs {
  w: number;
  h: number;
  /** presença encenada 0..1 */
  p: number;
  /** tempo local em segundos (letreiro, pulsos, reflexo da marca) */
  t: number;
}

const COND: FontSpec = { family: FONTS.condensed, weight: 800 };
const COND_SEMI: FontSpec = { family: FONTS.condensed, weight: 600, tracking: 0.04 };
const SANS_BLACK: FontSpec = { family: FONTS.sans, weight: 800 };
const SANS_BOLD: FontSpec = { family: FONTS.sans, weight: 700 };
const SANS_MED: FontSpec = { family: FONTS.sans, weight: 500 };
const SANS_SITE: FontSpec = { family: FONTS.sans, weight: 600, tracking: 0.12 };
const SERIF_BLACK: FontSpec = { family: FONTS.serif, weight: 900 };
const SERIF_ITALIC: FontSpec = { family: FONTS.serif, weight: 600, style: 'italic' };
const IMPACT: FontSpec = { family: FONTS.impact, weight: 400 };


const eo = ease['ease-out'];
const eio = ease['ease-in-out'];

function shade(hex: string, amt: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1]!, 16);
  const f = (v: number) => clamp(Math.round(amt < 0 ? v * (1 + amt) : v + (255 - v) * amt), 0, 255);
  const r = f((n >> 16) & 255);
  const g = f((n >> 8) & 255);
  const b = f(n & 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

function withAlpha(hex: string, a: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1]!, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function textShadow(ctx: C, size: number, alpha = 0.45) {
  ctx.shadowColor = `rgba(0,0,0,${alpha})`;
  ctx.shadowBlur = size * 0.12;
  ctx.shadowOffsetY = size * 0.04;
}

function noShadow(ctx: C) {
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
}

function clipReveal(ctx: C, x: number, y: number, w: number, h: number, f: number, from: 'left' | 'center' | 'bottom' = 'left') {
  ctx.beginPath();
  if (from === 'left') ctx.rect(x, y, w * f, h);
  else if (from === 'center') ctx.rect(x + (w * (1 - f)) / 2, y, w * f, h);
  else ctx.rect(x, y + h * (1 - f), w, h * f);
  ctx.clip();
}

/**
 * Acabamento de TV nas placas: reflexo de luz no topo e fio de luz azul na base.
 * Não altera a opacidade da placa (continua cobrindo o que estiver atrás).
 */
function sheen(ctx: C, x: number, y: number, w: number, h: number) {
  if (w <= 0 || h <= 0) return;
  ctx.save();
  const g = ctx.createLinearGradient(0, y, 0, y + h * 0.5);
  g.addColorStop(0, 'rgba(255,255,255,0.16)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h * 0.5);
  const lh = Math.max(2, h * 0.035);
  const lg = ctx.createLinearGradient(x, 0, x + w, 0);
  lg.addColorStop(0, 'rgba(56,182,255,0)');
  lg.addColorStop(0.5, 'rgba(56,182,255,0.95)');
  lg.addColorStop(1, 'rgba(56,182,255,0)');
  ctx.fillStyle = lg;
  ctx.fillRect(x, y + h - lh, w, lh);
  ctx.restore();
}

function stagger(p: number, start: number, span: number, step: number) {
  return (i: number) => eo(seg(p, start + i * step, start + i * step + span));
}

// ---------------------------------------------------------------------------

function faixa(ctx: C, c: TextClip, { w, h, p, t }: HeadlineArgs) {
  const s = c.style;
  const fs = s.fontScale;
  const grow = eo(seg(p, 0, 0.45));
  const top = h * (1 - grow);
  const g = ctx.createLinearGradient(0, top, 0, h);
  g.addColorStop(0, shade(s.primary, 0.12));
  g.addColorStop(1, shade(s.primary, -0.45));
  ctx.fillStyle = g;
  ctx.fillRect(0, top, w, h - top);
  const rule = eio(seg(p, 0.2, 0.6));
  const r1 = Math.max(2, h * 0.012);
  const r2 = Math.max(3, h * 0.022);
  // marca incrustada no centro da faixa, atrás da manchete
  incrust(ctx, { x: 0, y: top + r1 + r2, w, h: h - top - r1 - r2 }, { anchor: 'center', scale: 0.72, alpha: 0.2, p: seg(p, 0.15, 1), t });
  sheen(ctx, 0, top, w, h - top);
  ctx.fillStyle = shade(s.primary, -0.5);
  ctx.fillRect(0, top, w, r1);
  ctx.fillStyle = s.accent;
  ctx.fillRect((w * (1 - rule)) / 2, top + r1, w * rule, r2);
  if (p <= 0.25) return;
  const padX = w * 0.08;
  const areaTop = h * 0.12;
  const areaH = h * 0.6;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, top + r1 + r2, w, h);
  ctx.clip();
  const fit = fitText(ctx, c.fields.title, COND, { maxW: w - padX * 2, maxH: areaH, maxSize: h * 0.2 * fs, lineHeight: 1.04, upper: s.uppercase });
  const lineIn = stagger(p, 0.35, 0.35, 0.08);
  textShadow(ctx, fit.size, 0.4);
  drawLines(ctx, fit, padX, areaTop + (areaH - fit.height) / 2, w - padX * 2, s.align, { text: s.text, highlight: s.highlight }, {
    alpha: lineIn,
    dy: (i) => (1 - lineIn(i)) * fit.lineHeight * 0.6,
  });
  noShadow(ctx);
  // assinatura editorial: fio vermelho + endereço do portal
  const fp = eo(seg(p, 0.6, 1));
  const lw = w * 0.1 * fp;
  ctx.fillStyle = PN.red;
  ctx.fillRect((w - lw) / 2, h * 0.79, lw, Math.max(2, h * 0.012));
  ctx.globalAlpha *= fp;
  applyFont(ctx, SANS_SITE, h * 0.052);
  ctx.fillStyle = withAlpha(PN.sky, 0.85);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(PN.site.toLocaleUpperCase('pt-BR'), w / 2, h * 0.88);
  ctx.restore();
}

function urgente(ctx: C, c: TextClip, { w, h, p, t }: HeadlineArgs) {
  // cor da marca (azul-claro do brilho da logo) no lugar do amarelo antigo
  const s = c.style.highlight.toUpperCase() === PN.yellow ? { ...c.style, highlight: PN.sky } : c.style;
  const fs = s.fontScale;
  const barW = Math.max(3, w * 0.008);
  const gap = w * 0.022;
  const tagH = c.fields.kicker ? h * 0.24 : 0;
  const boxX = barW + gap;
  const boxY = tagH;
  const boxW = w - boxX;
  const boxH = h - tagH;
  const bar = eo(seg(p, 0, 0.3));
  ctx.fillStyle = s.highlight;
  ctx.fillRect(0, h * (1 - bar), barW, h * bar);
  if (c.fields.kicker) {
    const tp = eo(seg(p, 0.1, 0.45));
    applyFont(ctx, COND, tagH * 0.72 * fs);
    const label = c.fields.kicker.toLocaleUpperCase('pt-BR');
    const tw = ctx.measureText(label).width + tagH * 0.5;
    ctx.save();
    clipReveal(ctx, boxX, 0, tw, tagH, tp);
    ctx.fillStyle = s.highlight;
    ctx.fillRect(boxX, 0, tw, tagH);
    ctx.fillStyle = PN.navy;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(label, boxX + tagH * 0.25, tagH * 0.54);
    ctx.restore();
  }
  const bp = eio(seg(p, 0.2, 0.6));
  if (bp <= 0) return;
  ctx.save();
  clipReveal(ctx, boxX, boxY, boxW, boxH, bp);
  const g = ctx.createLinearGradient(boxX, 0, boxX + boxW, 0);
  g.addColorStop(0, s.primary);
  g.addColorStop(1, shade(s.primary, 0.08));
  ctx.fillStyle = g;
  ctx.fillRect(boxX, boxY, boxW, boxH);
  incrust(ctx, { x: boxX, y: boxY, w: boxW, h: boxH }, { anchor: 'right', scale: 0.84, alpha: 0.24, p: seg(p, 0.3, 1), t });
  sheen(ctx, boxX, boxY, boxW, boxH);
  const pad = boxH * 0.1;
  const fit = fitText(ctx, c.fields.title, SANS_BLACK, { maxW: boxW - pad * 2.2, maxH: boxH - pad * 2, maxSize: boxH * 0.3 * fs, lineHeight: 1.05, upper: s.uppercase });
  const lineIn = stagger(p, 0.4, 0.3, 0.07);
  textShadow(ctx, fit.size, 0.3);
  drawLines(ctx, fit, boxX + pad * 1.1, boxY + (boxH - fit.height) / 2, boxW - pad * 2.2, s.align, { text: s.text, highlight: s.highlight }, {
    alpha: lineIn,
    dx: (i) => (1 - lineIn(i)) * -fit.size,
  });
  ctx.restore();
}

function tarja(ctx: C, c: TextClip, { w, h, p, t }: HeadlineArgs) {
  const s = c.style;
  const fs = s.fontScale;
  const lineW = Math.max(2, w * 0.006);
  const boxX = w * 0.05;
  ctx.fillStyle = s.text;
  ctx.fillRect(0, -h * 0.25, lineW, h * 1.5 * eo(seg(p, 0, 0.35)));
  const bp = eio(seg(p, 0.15, 0.55));
  if (bp <= 0) return;
  ctx.save();
  clipReveal(ctx, boxX, 0, w - boxX, h, bp);
  const g = ctx.createLinearGradient(boxX, 0, w, 0);
  g.addColorStop(0, shade(s.primary, -0.1));
  g.addColorStop(1, shade(s.primary, 0.12));
  ctx.fillStyle = g;
  ctx.fillRect(boxX, 0, w - boxX, h);
  incrust(ctx, { x: boxX, y: 0, w: w - boxX, h }, { anchor: 'right', scale: 0.84, alpha: 0.24, p: seg(p, 0.3, 1), t });
  sheen(ctx, boxX, 0, w - boxX, h);
  const pad = h * 0.14;
  const areaW = w - boxX - pad * 2;
  const fit = fitText(ctx, c.fields.title, COND, { maxW: areaW, maxH: h - pad * 2, maxSize: h * 0.36 * fs, lineHeight: 1.06, upper: s.uppercase });
  const lineIn = stagger(p, 0.4, 0.3, 0.07);
  textShadow(ctx, fit.size, 0.3);
  drawLines(ctx, fit, boxX + pad, (h - fit.height) / 2, areaW, s.align, { text: s.text, highlight: s.highlight }, {
    alpha: lineIn,
    dy: (i) => (1 - lineIn(i)) * fit.size * 0.5,
  });
  ctx.restore();
}

function largo(ctx: C, c: TextClip, { w, h, p, t }: HeadlineArgs) {
  const s = c.style;
  const fs = s.fontScale;
  const open = eio(seg(p, 0, 0.45));
  const bandH = h * open;
  const y = (h - bandH) / 2;
  ctx.fillStyle = s.primary;
  ctx.fillRect(0, y, w, bandH);
  sheen(ctx, 0, y, w, bandH);
  incrust(ctx, { x: 0, y, w, h: bandH }, { anchor: 'right', scale: 0.8, alpha: 0.22, p: seg(p, 0.3, 1), t });
  const rl = Math.max(2, h * 0.025);
  ctx.fillStyle = s.accent;
  ctx.fillRect(0, y, w * eo(seg(p, 0.25, 0.7)), rl);
  ctx.fillRect(w * (1 - eo(seg(p, 0.25, 0.7))), y + bandH - rl, w, rl);
  if (p < 0.3) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, y, w, bandH);
  ctx.clip();
  const padX = w * 0.045;
  const fit = fitText(ctx, c.fields.title, COND, { maxW: w - padX * 2, maxH: h * 0.8, maxSize: h * 0.3 * fs, lineHeight: 1.05, upper: s.uppercase });
  const lineIn = stagger(p, 0.4, 0.35, 0.06);
  textShadow(ctx, fit.size, 0.3);
  drawLines(ctx, fit, padX, (h - fit.height) / 2, w - padX * 2, s.align, { text: s.text, highlight: s.highlight }, {
    alpha: lineIn,
    dx: (i) => (1 - lineIn(i)) * w * 0.06,
  });
  ctx.restore();
}

function serif(ctx: C, c: TextClip, { w, h, p, t }: HeadlineArgs) {
  const s = c.style;
  const fs = s.fontScale;
  const a = eo(seg(p, 0, 0.4));
  const barH = h * 0.06;
  ctx.save();
  ctx.globalAlpha *= a;
  ctx.translate(0, (1 - a) * h * 0.15);
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, shade(s.primary, 0.08));
  g.addColorStop(1, shade(s.primary, -0.4));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h - barH);
  incrust(ctx, { x: 0, y: 0, w, h: h - barH }, { anchor: 'center', scale: 0.82, alpha: 0.18, p: seg(p, 0.2, 1), t });
  sheen(ctx, 0, 0, w, h - barH);
  ctx.restore();
  const segs = [shade(s.primary, -0.3), s.primary, PN.blue, s.accent, PN.white];
  const sw = w / segs.length;
  segs.forEach((col, i) => {
    ctx.fillStyle = col;
    ctx.fillRect(i * sw, h - barH, sw * eo(seg(p, 0.2 + i * 0.07, 0.45 + i * 0.07)), barH);
  });
  if (p < 0.3) return;
  const padX = w * 0.06;
  const fit = fitText(ctx, c.fields.title, SERIF_BLACK, { maxW: w - padX * 2, maxH: (h - barH) * 0.84, maxSize: h * 0.22 * fs, lineHeight: 1.02, upper: s.uppercase });
  textShadow(ctx, fit.size, 0.4);
  drawLines(ctx, fit, padX, (h - barH - fit.height) / 2, w - padX * 2, s.align, { text: s.text, highlight: s.highlight }, {
    alpha: stagger(p, 0.35, 0.35, 0.08),
  });
  noShadow(ctx);
}

function marcador(ctx: C, c: TextClip, { w, h, p, t }: HeadlineArgs) {
  const s = c.style;
  const fs = s.fontScale;
  const padX = h * 0.06;
  const fit = fitText(ctx, c.fields.title, COND, { maxW: w - padX * 2, maxH: h, maxSize: h * 0.3 * fs, lineHeight: 1.18, upper: s.uppercase });
  const y0 = (h - fit.height) / 2;
  const n = fit.lines.length;
  const blocks = fit.lines.map((line, i) => {
    const lx = lineX(line, padX, w - padX * 2, s.align);
    return {
      x: lx - padX,
      y: y0 + i * fit.lineHeight,
      w: line.width + padX * 2,
      h: fit.lineHeight * 0.98,
      f: eio(seg(p, i * (0.5 / n), i * (0.5 / n) + 0.35)),
    };
  });
  // 1) blocos
  ctx.fillStyle = s.primary;
  for (const b of blocks) ctx.fillRect(b.x, b.y, b.w * b.f, b.h);
  // 2) carimbo no canto inferior direito do bloco da última linha
  const lastB = blocks[blocks.length - 1]!;
  incrust(ctx, { x: lastB.x, y: lastB.y, w: lastB.w * lastB.f, h: lastB.h }, {
    anchor: 'center',
    scale: 0.95,
    alpha: 0.3,
    p: seg(p, 0.3, 1),
    t,
    clip: (cx) => blocks.forEach((b) => cx.rect(b.x, b.y, b.w * b.f, b.h)),
  });
  // 3) texto
  fit.lines.forEach((line, i) => {
    const b = blocks[i]!;
    const tf = eo(seg(p, 0.2 + i * (0.5 / n), 0.55 + i * (0.5 / n)));
    ctx.save();
    ctx.beginPath();
    ctx.rect(b.x, b.y, b.w * b.f, b.h);
    ctx.clip();
    ctx.globalAlpha *= tf;
    let x = b.x + padX;
    const ty = b.y + (b.h - fit.size) / 2 + fit.size * 0.82;
    for (const r of line.runs) {
      ctx.fillStyle = r.hl ? s.highlight : s.text;
      if (r.text !== ' ') ctx.fillText(r.text, x, ty);
      x += r.w;
    }
    ctx.restore();
  });
}

function chapeu(ctx: C, c: TextClip, { w, h, p, t }: HeadlineArgs) {
  const s = c.style;
  const fs = s.fontScale;
  const hasK = !!c.fields.kicker;
  const hasS = !!c.fields.subtitle;
  const kH = hasK ? h * 0.27 : 0;
  const sH = hasS ? h * 0.27 : 0;
  const mH = h - kH - sH;
  const mp = eio(seg(p, 0, 0.45));
  ctx.save();
  clipReveal(ctx, 0, kH, w, mH, mp);
  ctx.fillStyle = s.primary;
  ctx.fillRect(0, kH, w, mH);
  // placa clara: marca em cinza, bem sutil
  incrust(ctx, { x: 0, y: kH, w, h: mH }, { anchor: 'right', scale: 0.84, alpha: 0.13, p: seg(p, 0.3, 1), t, light: true });
  ctx.fillStyle = s.accent;
  ctx.fillRect(0, kH, Math.max(4, w * 0.012), mH);
  const pad = mH * 0.16;
  const fit = fitText(ctx, c.fields.title, SANS_BOLD, { maxW: w - pad * 3, maxH: mH - pad * 1.4, maxSize: mH * 0.58 * fs, lineHeight: 1.08, upper: s.uppercase });
  ctx.globalAlpha *= eo(seg(p, 0.35, 0.75));
  drawLines(ctx, fit, pad * 1.8, kH + (mH - fit.height) / 2, w - pad * 3, s.align, { text: s.text, highlight: s.accent });
  ctx.restore();
  if (hasK) {
    applyFont(ctx, COND, kH * 0.62 * fs);
    const label = c.fields.kicker.toLocaleUpperCase('pt-BR');
    const kw = ctx.measureText(label).width + kH * 0.8;
    ctx.save();
    clipReveal(ctx, 0, 0, kw, kH, eo(seg(p, 0.2, 0.55)), 'bottom');
    ctx.fillStyle = s.accent;
    ctx.fillRect(0, 0, kw, kH);
    ctx.fillStyle = PN.white;
    ctx.textBaseline = 'middle';
    ctx.fillText(label, kH * 0.4, kH * 0.55);
    ctx.restore();
  }
  if (hasS) {
    ctx.save();
    clipReveal(ctx, 0, kH + mH, w * 0.92, sH, eio(seg(p, 0.4, 0.8)));
    ctx.fillStyle = PN.navy;
    ctx.fillRect(0, kH + mH, w * 0.92, sH);
    incrust(ctx, { x: 0, y: kH + mH, w: w * 0.92, h: sH }, { anchor: 'right', scale: 0.86, alpha: 0.3, p: seg(p, 0.45, 1), t });
    applyFont(ctx, SANS_MED, sH * 0.52 * fs);
    ctx.fillStyle = PN.white;
    ctx.textBaseline = 'middle';
    ctx.fillText(c.fields.subtitle, sH * 0.5 + w * 0.012, kH + mH + sH * 0.53, w * 0.92 - sH);
    ctx.restore();
  }
}

function nome(ctx: C, c: TextClip, { w, h, p, t }: HeadlineArgs) {
  const s = c.style;
  const fs = s.fontScale;
  const barW = Math.max(4, w * 0.018);
  ctx.fillStyle = s.accent;
  ctx.fillRect(0, h * (1 - eo(seg(p, 0, 0.3))), barW, h * eo(seg(p, 0, 0.3)));
  ctx.save();
  clipReveal(ctx, barW, 0, w - barW, h, eio(seg(p, 0.15, 0.55)));
  const g = ctx.createLinearGradient(barW, 0, w, 0);
  g.addColorStop(0, s.primary);
  g.addColorStop(1, shade(s.primary, 0.1));
  ctx.fillStyle = g;
  ctx.fillRect(barW, 0, w - barW, h);
  // GC: logo horizontal inteira incrustada à direita (aprovada assim)
  incrust(ctx, { x: barW, y: 0, w: w - barW, h }, { anchor: 'right', scale: 0.84, alpha: 0.24, p: seg(p, 0.3, 1), t, mode: 'banner' });
  sheen(ctx, barW, 0, w - barW, h);
  const pad = h * 0.18;
  ctx.globalAlpha *= eo(seg(p, 0.4, 0.8));
  ctx.textBaseline = 'middle';
  applyFont(ctx, SANS_BOLD, h * (c.fields.subtitle ? 0.36 : 0.48) * fs);
  ctx.fillStyle = s.text;
  ctx.fillText(c.fields.title, barW + pad, h * (c.fields.subtitle ? 0.36 : 0.52), w - barW - pad * 2);
  if (c.fields.subtitle) {
    applyFont(ctx, SANS_MED, h * 0.24 * fs);
    ctx.fillStyle = s.accent;
    ctx.fillText(c.fields.subtitle, barW + pad, h * 0.72, w - barW - pad * 2);
  }
  ctx.restore();
}

function aoVivo(ctx: C, c: TextClip, { h, p, t }: HeadlineArgs) {
  const s = c.style;
  const fs = s.fontScale;
  applyFont(ctx, COND, h * 0.6 * fs);
  const label = (c.fields.kicker || 'Exclusivo').toLocaleUpperCase('pt-BR');
  const dot = h * 0.22;
  const lw = h * 0.35 + dot * 2 + ctx.measureText(label).width + h * 0.35;
  ctx.save();
  clipReveal(ctx, 0, 0, lw, h, eo(seg(p, 0, 0.5)));
  ctx.fillStyle = s.primary;
  ctx.fillRect(0, 0, lw, h);
  const pulse = 0.55 + 0.45 * (0.5 + 0.5 * Math.cos(t * Math.PI * 2));
  ctx.fillStyle = `rgba(255,255,255,${pulse})`;
  ctx.beginPath();
  ctx.arc(h * 0.35 + dot, h / 2, dot, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = PN.white;
  ctx.textBaseline = 'middle';
  ctx.fillText(label, h * 0.35 + dot * 2 + h * 0.2, h * 0.54);
  ctx.restore();
  if (c.fields.title) {
    applyFont(ctx, COND_SEMI, h * 0.52 * fs);
    const loc = s.uppercase ? c.fields.title.toLocaleUpperCase('pt-BR') : c.fields.title;
    const locW = ctx.measureText(loc).width + h * 0.7;
    ctx.save();
    clipReveal(ctx, lw, 0, locW, h, eo(seg(p, 0.35, 0.85)));
    ctx.fillStyle = s.accent;
    ctx.fillRect(lw, 0, locW, h);
    incrust(ctx, { x: lw, y: 0, w: locW, h }, { anchor: 'right', scale: 0.88, alpha: 0.32, p: seg(p, 0.45, 1), t });
    ctx.fillStyle = PN.white;
    ctx.textBaseline = 'middle';
    ctx.fillText(loc, lw + h * 0.35, h * 0.54);
    ctx.restore();
  }
}

function letreiro(ctx: C, c: TextClip, { w, h, p, t }: HeadlineArgs) {
  const s = c.style;
  ctx.save();
  clipReveal(ctx, 0, 0, w, h, eio(seg(p, 0, 0.4)), 'bottom');
  drawTicker(ctx, w, h, c.fields.title, t, { kicker: c.fields.kicker, uppercase: s.uppercase, fontScale: s.fontScale });
  ctx.restore();
}

/** Letreiro com a marca incrustada na faixa — usado pelo preset e pela moldura. */
export function drawTicker(
  ctx: C,
  w: number,
  h: number,
  text: string,
  t: number,
  o: { kicker?: string; uppercase?: boolean; fontScale?: number } = {},
) {
  const fs = o.fontScale ?? 1;
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, shade(PN.deep, 0.06));
  g.addColorStop(1, PN.navy);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  let x0 = 0;
  if (o.kicker) {
    applyFont(ctx, COND, h * 0.56 * fs);
    const label = o.kicker.toLocaleUpperCase('pt-BR');
    const kw = ctx.measureText(label).width + h * 0.9;
    ctx.fillStyle = PN.bright;
    ctx.fillRect(0, 0, kw, h);
    ctx.fillStyle = PN.white;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(label, h * 0.45, h * 0.54);
    x0 = kw;
  }
  // marca fixa no centro da faixa; o texto corre por cima dela
  incrust(ctx, { x: x0, y: 0, w: w - x0, h }, { anchor: 'center', scale: 0.88, alpha: 0.24, p: 1, t });
  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, 0, w - x0, h);
  ctx.clip();
  applyFont(ctx, COND_SEMI, h * 0.52 * fs);
  const body = (o.uppercase === false ? text : text.toLocaleUpperCase('pt-BR')) + '   •   ';
  const bw = Math.max(1, ctx.measureText(body).width);
  const offset = (t * h * 2.6) % bw;
  ctx.fillStyle = PN.white;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  for (let x = x0 + h * 0.4 - offset; x < w; x += bw) ctx.fillText(body, x, h * 0.54);
  ctx.restore();
  ctx.fillStyle = PN.sky;
  ctx.fillRect(0, 0, w, Math.max(2, h * 0.05));
}

function citacao(ctx: C, c: TextClip, { w, h, p, t }: HeadlineArgs) {
  const s = c.style;
  const fs = s.fontScale;
  const a = eo(seg(p, 0, 0.4));
  ctx.save();
  ctx.globalAlpha *= a;
  ctx.fillStyle = s.primary;
  ctx.fillRect(0, 0, w, h);
  sheen(ctx, 0, 0, w, h);
  ctx.restore();
  incrust(ctx, { x: 0, y: 0, w, h }, { anchor: 'right', scale: 0.46, alpha: 0.2, p: seg(p, 0.2, 1), t });
  ctx.fillStyle = s.accent;
  ctx.fillRect(0, 0, Math.max(4, w * 0.012), h * eo(seg(p, 0.1, 0.5)));
  const pad = Math.min(w, h) * 0.12;
  const qs = h * 0.42;
  const qa = eo(seg(p, 0.2, 0.5));
  ctx.save();
  ctx.globalAlpha *= qa;
  applyFont(ctx, SERIF_BLACK, qs);
  ctx.fillStyle = s.accent;
  ctx.textBaseline = 'top';
  ctx.fillText('“', pad, pad * 0.2 + (1 - qa) * qs * 0.3);
  ctx.restore();
  const attrH = c.fields.subtitle ? h * 0.16 : 0;
  const tx = pad + qs * 0.5;
  const fit = fitText(ctx, c.fields.title, SERIF_ITALIC, { maxW: w - tx - pad, maxH: h - pad * 1.6 - attrH, maxSize: h * 0.2 * fs, lineHeight: 1.15, upper: s.uppercase });
  const lineIn = stagger(p, 0.3, 0.3, 0.07);
  drawLines(ctx, fit, tx, pad * 0.8 + (h - pad * 1.6 - attrH - fit.height) / 2, w - tx - pad, s.align, { text: s.text, highlight: s.highlight }, {
    alpha: lineIn,
    dy: (i) => (1 - lineIn(i)) * fit.size * 0.4,
  });
  if (c.fields.subtitle) {
    ctx.save();
    ctx.globalAlpha *= eo(seg(p, 0.6, 1));
    applyFont(ctx, COND_SEMI, attrH * 0.62 * fs);
    ctx.fillStyle = s.accent;
    ctx.textBaseline = 'middle';
    ctx.fillText(`— ${c.fields.subtitle}`.toLocaleUpperCase('pt-BR'), tx, h - pad * 0.6 - attrH / 2, w - tx - pad);
    ctx.restore();
  }
}

function numero(ctx: C, c: TextClip, { w, h, p, t }: HeadlineArgs) {
  const s = c.style;
  const fs = s.fontScale;
  const capH = c.fields.subtitle ? h * 0.26 : 0;
  const numH = h - capH;
  const raw = c.fields.title;
  const m = /^(\D*)([\d.,]+)(.*)$/.exec(raw);
  let shown = raw;
  if (m) {
    const digits = m[2]!;
    const value = parseFloat(digits.replace(/\./g, '').replace(',', '.'));
    if (Number.isFinite(value)) {
      const decimals = digits.includes(',') ? digits.split(',')[1]!.length : 0;
      const cur = value * eo(seg(p, 0.15, 0.85));
      shown = `${m[1]}${cur.toLocaleString('pt-BR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}${m[3]}`;
    }
  }
  const fit = fitText(ctx, raw, IMPACT, { maxW: w * 0.96, maxH: numH, maxSize: numH * 0.95 * fs, lineHeight: 1, upper: false, maxLines: 1 });
  const ax = s.align === 'left' ? 0 : s.align === 'right' ? w : w / 2;
  ctx.save();
  ctx.globalAlpha *= eo(seg(p, 0, 0.3));
  applyFont(ctx, IMPACT, fit.size);
  ctx.textBaseline = 'middle';
  ctx.textAlign = s.align;
  ctx.lineJoin = 'round';
  ctx.lineWidth = fit.size * 0.06;
  ctx.strokeStyle = s.primary;
  ctx.strokeText(shown, ax, numH * 0.52);
  ctx.fillStyle = s.accent;
  ctx.fillText(shown, ax, numH * 0.52);
  ctx.restore();
  if (capH) {
    applyFont(ctx, COND_SEMI, capH * 0.6 * fs);
    const cap = c.fields.subtitle.toLocaleUpperCase('pt-BR');
    const cw = Math.min(w, ctx.measureText(cap).width + capH * 0.8);
    const cx = s.align === 'left' ? 0 : s.align === 'right' ? w - cw : (w - cw) / 2;
    ctx.save();
    clipReveal(ctx, cx, numH, cw, capH, eio(seg(p, 0.4, 0.8)), 'center');
    ctx.fillStyle = s.primary;
    ctx.fillRect(cx, numH, cw, capH);
    incrust(ctx, { x: cx, y: numH, w: cw, h: capH }, { anchor: 'center', scale: 0.88, alpha: 0.3, p: seg(p, 0.45, 1), t });
    ctx.fillStyle = s.text;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillText(cap, cx + cw / 2, numH + capH * 0.54, cw - capH * 0.4);
    ctx.restore();
  }
}

/** Selo oficial: logo + símbolo do Instagram + @primeirasnoticias_ (também usado pelas molduras). */
export function drawHandle(ctx: C, w: number, h: number, align: 'left' | 'center' | 'right', f = 1) {
  const gs = h * 0.56;
  applyFont(ctx, SANS_BOLD, h * 0.5);
  const tw = ctx.measureText(PN.handle).width;
  const pad = h * 0.3;
  // só o símbolo do Instagram e o @perfil (sem a logo ao lado)
  const total = pad + gs + h * 0.22 + tw + pad;
  const x0 = align === 'left' ? 0 : align === 'right' ? w - total : (w - total) / 2;
  ctx.save();
  ctx.globalAlpha *= f;
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, PN.deep);
  g.addColorStop(1, PN.navy);
  ctx.fillStyle = g;
  ctx.fillRect(x0, 0, total, h);
  ctx.fillStyle = PN.sky;
  ctx.fillRect(x0, h - Math.max(2, h * 0.06), total, Math.max(2, h * 0.06));
  let x = x0 + pad;
  drawInstagramGlyph(ctx, x, (h - gs) / 2, gs);
  x += gs + h * 0.22;
  ctx.fillStyle = PN.white;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  applyFont(ctx, SANS_BOLD, h * 0.5);
  ctx.fillText(PN.handle, x, h * 0.53);
  ctx.restore();
}

function perfil(ctx: C, c: TextClip, { w, h, p }: HeadlineArgs) {
  drawHandle(ctx, w, h, c.style.align, eo(seg(p, 0, 1)));
}

/** Só o @primeirasnoticias_ (marca d'água): branco com contorno fino, sem placa. */
function marcaDagua(ctx: C, _c: TextClip, { w, h }: HeadlineArgs) {
  applyFont(ctx, SANS_BOLD, h * 0.82);
  const tw = ctx.measureText(PN.handle).width;
  const size = h * 0.82 * Math.min(1, (w * 0.96) / Math.max(1, tw));
  applyFont(ctx, SANS_BOLD, size);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(1, size * 0.08);
  ctx.strokeStyle = 'rgba(6,20,51,0.85)';
  ctx.strokeText(PN.handle, w / 2, h * 0.54);
  ctx.fillStyle = PN.white;
  ctx.fillText(PN.handle, w / 2, h * 0.54);
}

/**
 * Marca d'água central, simples: o símbolo da marca (anel + "pn") suave atrás
 * e o @primeirasnoticias_ na frente, em branco limpo (só uma sombra leve, sem
 * contorno grosso). A opacidade geral é a do item (ajustável no painel).
 */
function marcaCentro(ctx: C, c: TextClip, { w, h }: HeadlineArgs) {
  const round = brandImage('round');
  if (round) {
    const lh = h * 0.92;
    const lw = lh * LOGO_RATIO.round;
    ctx.save();
    ctx.globalAlpha *= 0.6;
    ctx.drawImage(round, (w - lw) / 2, (h - lh) / 2, lw, lh);
    ctx.restore();
  }
  const handle = c.fields.title.trim() || PN.handle;
  applyFont(ctx, SANS_BOLD, h * 0.2);
  const tw = ctx.measureText(handle).width;
  const size = h * 0.2 * Math.min(1, (w * 0.92) / Math.max(1, tw));
  applyFont(ctx, SANS_BOLD, size);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = size * 0.25;
  ctx.fillStyle = PN.white;
  ctx.fillText(handle, w / 2, h * 0.52);
  noShadow(ctx);
}

function credito(ctx: C, c: TextClip, { w, h }: HeadlineArgs) {
  const s = c.style;
  applyFont(ctx, COND_SEMI, h * 0.78 * s.fontScale);
  const label = c.fields.kicker ? `${c.fields.kicker}: ${c.fields.title}` : c.fields.title;
  const text = s.uppercase ? label.toLocaleUpperCase('pt-BR') : label;
  textShadow(ctx, h, 0.6);
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.textBaseline = 'middle';
  ctx.textAlign = s.align;
  const ax = s.align === 'left' ? 0 : s.align === 'right' ? w : w / 2;
  ctx.fillText(text, ax, h * 0.52, w);
  noShadow(ctx);
}

function plain(ctx: C, c: TextClip, { w, h }: HeadlineArgs) {
  const s = c.style;
  const fit = fitText(ctx, c.fields.title, SANS_BLACK, { maxW: w, maxH: h, maxSize: h * 0.9 * s.fontScale, lineHeight: 1.1, upper: s.uppercase });
  const y0 = (h - fit.height) / 2;
  ctx.lineJoin = 'round';
  ctx.lineWidth = fit.size * 0.14;
  ctx.strokeStyle = PN.navy;
  ctx.textBaseline = 'alphabetic';
  fit.lines.forEach((line, i) => {
    let x = lineX(line, 0, w, s.align);
    const y = y0 + i * fit.lineHeight + (fit.lineHeight - fit.size) / 2 + fit.size * 0.8;
    for (const r of line.runs) {
      if (r.text !== ' ') ctx.strokeText(r.text, x, y);
      x += r.w;
    }
  });
  textShadow(ctx, fit.size, 0.4);
  drawLines(ctx, fit, 0, y0, w, s.align, { text: PN.white, highlight: PN.yellow });
  noShadow(ctx);
}

/** Cópias da logo tingidas (ciano e vermelho do TikTok) para a separação RGB. */
const tintCache = new WeakMap<HTMLImageElement, { cyan: HTMLCanvasElement; red: HTMLCanvasElement }>();
function tinted(img: HTMLImageElement) {
  let v = tintCache.get(img);
  if (v) return v;
  const k = Math.min(1, 900 / Math.max(1, img.naturalWidth));
  const mk = (color: string) => {
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(img.naturalWidth * k));
    cv.height = Math.max(1, Math.round(img.naturalHeight * k));
    const g = cv.getContext('2d')!;
    g.drawImage(img, 0, 0, cv.width, cv.height);
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = color;
    g.fillRect(0, 0, cv.width, cv.height);
    return cv;
  };
  v = { cyan: mk('#25F4EE'), red: mk('#FE2C55') };
  tintCache.set(img, v);
  return v;
}

/** Aleatório determinístico (mesmo quadro = mesmo glitch na prévia e na exportação). */
const rnd = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

/** Intensidade do glitch: forte na entrada da logo e dois "soluços" depois. */
function glitchAt(t: number) {
  const bump = (a: number, b: number, k: number) => (t >= a && t <= b ? k * Math.sin(((t - a) / (b - a)) * Math.PI) : 0);
  return Math.max(bump(0.1, 0.85, 1), bump(1.5, 1.66, 0.7), bump(2.32, 2.44, 0.55));
}

/** Desenha a imagem em faixas horizontais deslocadas (efeito de sinal quebrado). */
function drawSliced(ctx: C, src: HTMLImageElement | HTMLCanvasElement, x: number, y: number, w: number, h: number, glitch: number, n: number, salt: number) {
  if (glitch < 0.04) {
    ctx.drawImage(src, x, y, w, h);
    return;
  }
  const sw = src instanceof HTMLImageElement ? src.naturalWidth : src.width;
  const sh = src instanceof HTMLImageElement ? src.naturalHeight : src.height;
  const strips = 9;
  let a = 0;
  for (let i = 0; i < strips; i++) {
    const b = i === strips - 1 ? 1 : Math.min(1, a + (0.4 + rnd(n * 3.1 + i) * 1.2) / strips);
    const big = rnd(n * 7.7 + i * 1.3 + salt) > 0.62;
    const dx = (rnd(n * 13 + i * 7 + salt) - 0.5) * 2 * glitch * w * (big ? 0.14 : 0.025);
    ctx.drawImage(src, 0, a * sh, sw, (b - a) * sh, x + dx, y + a * h, w, (b - a) * h);
    a = b;
    if (a >= 1) break;
  }
}

/**
 * Encerramento estilo TikTok, com a cara da Primeiras Notícias: fundo escuro,
 * logo entra com glitch (cópias ciano/vermelho, faixas deslocadas, tremida),
 * depois o @perfil aparece com o mesmo efeito. A logo é a escolhida pelo usuário.
 */
function encerramento(ctx: C, c: TextClip, { w, h, t }: HeadlineArgs) {
  const n = Math.floor(t * 24);
  const glitch = glitchAt(t);
  // fundo quase preto com o azul da marca pulsando atrás da logo
  ctx.fillStyle = '#02060e';
  ctx.fillRect(0, 0, w, h);
  const cy = h * 0.4;
  const pulse = 0.8 + 0.2 * Math.sin(t * Math.PI * 1.4);
  const rg = ctx.createRadialGradient(w / 2, cy, 0, w / 2, cy, w * 0.85);
  rg.addColorStop(0, `rgba(20,90,200,${0.55 * pulse})`);
  rg.addColorStop(0.55, 'rgba(10,40,110,0.25)');
  rg.addColorStop(1, 'rgba(2,6,14,0)');
  ctx.fillStyle = rg;
  ctx.fillRect(0, 0, w, h);

  // barras de interferência no fundo durante o glitch
  if (glitch > 0.25) {
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    for (let i = 0; i < 5; i++) {
      const by = rnd(n * 5 + i) * h;
      const bh = h * (0.004 + rnd(n * 9 + i) * 0.03);
      ctx.fillStyle = i % 2 ? `rgba(37,244,238,${0.18 * glitch})` : `rgba(254,44,85,${0.18 * glitch})`;
      ctx.fillRect(0, by, w, bh);
    }
    ctx.restore();
  }

  // logo
  const img = brandImage('outro');
  const enter = clamp((t - 0.12) / 0.5, 0, 1);
  if (img && enter > 0) {
    const ratio = LOGO_RATIO.outro;
    let lw = w * 0.8;
    let lh = lw / ratio;
    if (lh > h * 0.42) {
      lh = h * 0.42;
      lw = lh * ratio;
    }
    const s = Math.max(0, ease.outBack(enter)) * (1 + 0.012 * Math.sin(t * Math.PI * 1.4));
    const shx = glitch * w * 0.016 * (rnd(n + 0.5) - 0.5) * 2;
    const shy = glitch * w * 0.01 * (rnd(n + 0.9) - 0.5) * 2;
    ctx.save();
    ctx.translate(w / 2 + shx, cy + shy);
    ctx.scale(s, s);
    // cópias ciano/vermelho só durante o glitch; parada, a logo fica exatamente
    // como a imagem é (sem contorno, sombra ou brilho em volta)
    if (glitch > 0.04) {
      const off = w * 0.028 * glitch;
      const tint = tinted(img);
      ctx.globalCompositeOperation = 'screen';
      ctx.globalAlpha = 0.9 * Math.min(1, glitch * 3);
      drawSliced(ctx, tint.cyan, -lw / 2 - off, -lh / 2 - off * 0.35, lw, lh, glitch, n, 1);
      drawSliced(ctx, tint.red, -lw / 2 + off, -lh / 2 + off * 0.35, lw, lh, glitch, n, 2);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
    }
    drawSliced(ctx, img, -lw / 2, -lh / 2, lw, lh, glitch, n, 3);
    ctx.restore();
  }

  // chamada + @perfil
  const tp = clamp((t - 0.95) / 0.35, 0, 1);
  if (tp > 0) {
    const tg = Math.max(glitch, t < 1.3 ? 1 - tp : 0);
    const baseY = h * 0.71 + (1 - eo(tp)) * h * 0.02;
    const jx = tg * w * 0.012 * (rnd(n + 3.3) - 0.5) * 2;
    ctx.save();
    ctx.globalAlpha *= eo(tp);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    applyFont(ctx, SANS_SITE, w * 0.034);
    ctx.fillStyle = 'rgba(200,225,255,0.9)';
    ctx.fillText((c.fields.kicker || 'Siga para mais notícias').toLocaleUpperCase('pt-BR'), w / 2, baseY - h * 0.052);

    applyFont(ctx, SANS_BLACK, w * 0.068);
    const handle = PN.handle;
    const tw = ctx.measureText(handle).width;
    const gs = w * 0.074;
    const gap = w * 0.022;
    const total = gs + gap + tw;
    const x0 = (w - total) / 2 + jx;
    drawInstagramGlyph(ctx, x0, baseY - gs / 2, gs);
    const tx = x0 + gs + gap;
    const ty = baseY + w * 0.004;
    const d = w * (0.0035 + 0.02 * tg);
    ctx.textAlign = 'left';
    ctx.globalCompositeOperation = 'screen';
    ctx.fillStyle = '#25F4EE';
    ctx.fillText(handle, tx - d, ty);
    ctx.fillStyle = '#FE2C55';
    ctx.fillText(handle, tx + d, ty);
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = PN.white;
    ctx.fillText(handle, tx, ty);
    ctx.restore();
  }
}

const DRAWERS: Record<string, (ctx: C, c: TextClip, a: HeadlineArgs) => void> = {
  'pn-encerramento': encerramento,
  'pn-edicao': edicao,
  'pn-legenda': (ctx, c, a) => drawCaption(ctx, c, a),
  'pn-marca-dagua': marcaDagua,
  'pn-marca-centro': marcaCentro,
  'pn-faixa': faixa,
  'pn-urgente': urgente,
  'pn-tarja': tarja,
  'pn-largo': largo,
  'pn-serif': serif,
  'pn-marcador': marcador,
  'pn-chapeu': chapeu,
  'pn-nome': nome,
  'pn-aovivo': aoVivo,
  'pn-letreiro': letreiro,
  'pn-citacao': citacao,
  'pn-numero': numero,
  'pn-perfil': perfil,
  'pn-credito': credito,
  plain,
};

export function drawHeadline(ctx: C, c: TextClip, a: HeadlineArgs) {
  const fn = DRAWERS[c.preset] ?? plain;
  // cores sempre as da marca; o usuário controla só alinhamento, caixa alta e corpo
  const pr = getPreset(c.preset);
  const style = { ...pr.style, align: c.style.align, uppercase: c.style.uppercase, fontScale: c.style.fontScale };
  ctx.save();
  fn(ctx, { ...c, style }, a);
  ctx.restore();
}
