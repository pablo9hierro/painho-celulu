/**
 * "Edição" — placa de manchete do post em vídeo.
 *
 * Feita para ficar ABAIXO da janela da foto na moldura (não cobre a imagem):
 * - placa opaca navy que abre do centro (como as manchetes do editor), com
 *   brilho no topo;
 * - a logo redonda Primeiras Notícias (anel + "pn") IMPREGNADA atrás das
 *   letras, andando e girando devagar como a do fundo da moldura;
 * - chapéu numa aba azul que sobe de dentro da placa, com ponto pulsante;
 * - manchete subindo palavra por palavra; UMA palavra-chave (a primeira entre
 *   *asteriscos*) ganha a caixa azul-clara da marca;
 * - linha fina, fio e site no rodapé da placa;
 * - o fio do topo da placa é a barra de tempo do vídeo (azul-claro correndo).
 *
 * Só cores da marca. O post não "sai" no fim: o último quadro fica como capa.
 */
import type { TextClip } from '../core/model';
import { clamp, ease, seg } from '../core/animation';
import { FONTS, PN } from '../core/brand';
import { applyFont, fitText, type FontSpec } from './text';
import { brandImage, LOGO_RATIO } from './brandAssets';

type C = CanvasRenderingContext2D;

const HEAD: FontSpec = { family: FONTS.condensed, weight: 700 };
const DECK: FontSpec = { family: FONTS.sans, weight: 500 };
const TAB: FontSpec = { family: FONTS.condensed, weight: 700, tracking: 0.08 };
const SITE: FontSpec = { family: FONTS.condensed, weight: 600, tracking: 0.16 };

const eo = ease['ease-out'];
const eio = ease['ease-in-out'];

/** tempo (s) em que a manchete começa a subir */
const T_HEAD = 0.5;
/** intervalo entre palavras */
const WORD_STEP = 0.055;

/** Deixa só UM destaque: o primeiro trecho entre *asteriscos*; os outros viram texto normal. */
export function singleHighlight(title: string): string {
  let seen = false;
  return title.replace(/\*([^*]*)\*/g, (_m, x: string) => {
    if (seen || !x.trim()) return x;
    seen = true;
    return `*${x}*`;
  });
}

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * Marca na manchete UMA palavra-chave (a primeira da lista que aparece no
 * título, sem ligar para acento ou maiúscula). Nenhuma aparece: sem destaque.
 */
export function markKeyword(title: string, keywords: string[]): string {
  const clean = title.replace(/\*/g, '');
  // posição de cada letra do texto "dobrado" (sem acento) no texto original
  const map: number[] = [];
  let f = '';
  for (let i = 0; i < clean.length; i++) {
    const ch = fold(clean[i]!);
    f += ch;
    for (let j = 0; j < ch.length; j++) map.push(i);
  }
  for (const k of keywords) {
    const kk = fold(k.trim());
    if (kk.length < 3) continue;
    const re = new RegExp(`(^|[^a-z0-9])(${kk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?=$|[^a-z0-9])`);
    const m = re.exec(f);
    if (!m) continue;
    const at = m.index + m[1]!.length;
    const s = map[at];
    const e = map[at + kk.length - 1];
    if (s === undefined || e === undefined) continue;
    return `${clean.slice(0, s)}*${clean.slice(s, e + 1)}*${clean.slice(e + 1)}`;
  }
  return clean;
}

export function edicao(ctx: C, c: TextClip, { w, h, t }: { w: number; h: number; p: number; t: number }) {
  const u = w / 1080;
  const fs = c.style.fontScale || 1;
  const d = Math.max(1, c.duration);
  const pin = clamp(t / 0.9, 0, 1);
  const kicker = c.fields.kicker.trim().toLocaleUpperCase('pt-BR');
  const kH = kicker ? 56 * u : 0;
  const y0 = kH;
  const ph = h - y0;
  const padX = 56 * u;
  const maxW = w - padX * 2;

  // 1) placa abrindo do centro
  const open = eio(seg(pin, 0, 0.5));
  ctx.save();
  ctx.beginPath();
  ctx.rect((w * (1 - open)) / 2, y0, w * open, ph);
  ctx.clip();
  const g = ctx.createLinearGradient(0, y0, 0, h);
  g.addColorStop(0, PN.deep);
  g.addColorStop(0.55, PN.navy);
  g.addColorStop(1, '#06132B');
  ctx.fillStyle = g;
  ctx.fillRect(0, y0, w, ph);

  // 2) logo redonda (anel + "pn") impregnada atrás das letras: grande, à direita,
  //    andando e girando devagar como a do fundo da moldura, pulsando de leve
  const round = brandImage('round');
  const lf = eo(seg(pin, 0.35, 1));
  if (round && lf > 0) {
    const lh = ph * 1.15;
    const lw = lh * LOGO_RATIO.round;
    const cx = w - lw * 0.32 + Math.sin(t * 0.35) * 26 * u - t * 4 * u;
    const cy = y0 + ph * 0.55 + Math.sin(t * 0.27 + 1.1) * 14 * u;
    const pulse = 0.5 + 0.5 * Math.sin((t * 2 * Math.PI) / 2.6);
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = (0.2 + 0.1 * pulse) * lf;
    ctx.translate(cx, cy);
    ctx.rotate(((-8 + 3 * Math.sin(t * 0.2)) * Math.PI) / 180);
    ctx.drawImage(round, -lw / 2, -lh / 2, lw, lh);
    ctx.restore();
    // reflexo diagonal atravessando a placa a cada 4 s
    const cyc = (((t - 1) % 4) + 4) % 4;
    if (t > 1 && cyc < 1.2) {
      const sx = -200 * u + ((w + 400 * u) * cyc) / 1.2;
      const rg = ctx.createLinearGradient(sx - 110 * u, 0, sx + 110 * u, 0);
      rg.addColorStop(0, 'rgba(56,182,255,0)');
      rg.addColorStop(0.5, 'rgba(140,210,255,0.22)');
      rg.addColorStop(1, 'rgba(56,182,255,0)');
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      ctx.globalAlpha = lf;
      ctx.fillStyle = rg;
      ctx.beginPath();
      ctx.moveTo(sx - 40 * u, y0);
      ctx.lineTo(sx + 150 * u, y0);
      ctx.lineTo(sx + 40 * u, h);
      ctx.lineTo(sx - 150 * u, h);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }

  // brilho no topo da placa (mesma linguagem das manchetes do editor)
  const gl = ctx.createLinearGradient(0, y0, 0, y0 + ph * 0.35);
  gl.addColorStop(0, 'rgba(255,255,255,0.10)');
  gl.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gl;
  ctx.fillRect(0, y0, w, ph * 0.35);
  ctx.restore();

  // 3) fio do topo = barra de tempo
  const lwire = 7 * u;
  const wire = eo(seg(pin, 0.25, 0.75));
  ctx.fillStyle = PN.blue;
  ctx.fillRect((w * (1 - wire)) / 2, y0, w * wire, lwire);
  const prog = clamp(t / d, 0, 1) * wire;
  if (prog > 0) {
    ctx.save();
    ctx.fillStyle = PN.sky;
    ctx.fillRect(0, y0, w * prog, lwire);
    ctx.shadowColor = PN.sky;
    ctx.shadowBlur = 16 * u;
    ctx.fillStyle = PN.white;
    ctx.beginPath();
    ctx.arc(w * prog, y0 + lwire / 2, lwire * 0.85, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // 4) aba do chapéu subindo de dentro da placa
  if (kicker) {
    applyFont(ctx, TAB, 32 * u);
    const tabW = ctx.measureText(kicker).width + 84 * u;
    const rise = eo(seg(pin, 0.3, 0.65));
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, y0);
    ctx.clip();
    const ty = y0 - kH * rise;
    const k = 14 * u;
    const tx = padX - 16 * u;
    ctx.fillStyle = PN.blue;
    ctx.beginPath();
    ctx.moveTo(tx, ty + kH + 1);
    ctx.lineTo(tx, ty + k);
    ctx.lineTo(tx + k, ty);
    ctx.lineTo(tx + tabW, ty);
    ctx.lineTo(tx + tabW + k * 1.6, ty + kH + 1);
    ctx.closePath();
    ctx.fill();
    const pulse = 0.55 + 0.45 * Math.sin(t * 6);
    ctx.fillStyle = `rgba(255,255,255,${pulse.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(padX + 14 * u, ty + kH / 2, 7 * u, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = PN.white;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(kicker, padX + 34 * u, ty + kH / 2 + 2 * u);
    ctx.restore();
  }

  // 5) layout do texto: manchete + linha fina centralizadas na área útil
  const footH = 40 * u;
  const top = y0 + lwire + 30 * u;
  const bottom = h - footH - 26 * u;
  const deckText = c.fields.subtitle.trim();
  const deck = deckText ? fitText(ctx, deckText, DECK, { maxW, maxH: 84 * u, maxSize: 34 * u * fs, minSize: 22 * u, lineHeight: 1.18, upper: false, maxLines: 2 }) : null;
  const gap = deck ? 18 * u : 0;
  const head = fitText(ctx, singleHighlight(c.fields.title || ' '), HEAD, {
    maxW,
    maxH: Math.max(40 * u, bottom - top - gap - (deck?.height ?? 0)),
    maxSize: 96 * u * fs,
    minSize: 30 * u,
    lineHeight: 1.0,
    upper: c.style.uppercase,
    maxLines: 4,
  });
  const block = head.height + gap + (deck?.height ?? 0);
  const headY = top + Math.max(0, (bottom - top - block) / 2);
  const deckY = headY + head.height + gap;

  // 6) manchete palavra por palavra; a palavra-chave ganha a caixa azul-clara
  applyFont(ctx, HEAD, head.size);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  const ascent = head.size * 0.8;
  const pad = (head.lineHeight - head.size) / 2;
  let k = 0;
  head.lines.forEach((line, li) => {
    const ly = headY + li * head.lineHeight;
    const lineX = c.style.align === 'center' ? padX + (maxW - line.width) / 2 : padX;
    ctx.save();
    ctx.beginPath();
    ctx.rect(padX - 24 * u, ly - 8 * u, maxW + 48 * u, head.lineHeight + 16 * u);
    ctx.clip();
    let x = lineX;
    const words: { text: string; x: number; w: number; hl: boolean; f: number; start: number }[] = [];
    for (const r of line.runs) {
      if (r.text === ' ') {
        x += r.w;
        continue;
      }
      const start = T_HEAD + k * WORD_STEP;
      words.push({ text: r.text, x, w: r.w, hl: r.hl, f: eo(seg(t, start, start + 0.4)), start });
      x += r.w;
      k++;
    }
    const hl = words.filter((wd) => wd.hl);
    let litAt = Infinity;
    if (hl.length) {
      const x0 = hl[0]!.x;
      const x1 = hl[hl.length - 1]!.x + hl[hl.length - 1]!.w;
      const done = hl[hl.length - 1]!.start + 0.35;
      litAt = done + 0.12;
      const f = eio(seg(t, done, done + 0.3));
      if (f > 0) {
        const bp = head.size * 0.14;
        ctx.fillStyle = PN.sky;
        ctx.fillRect(x0 - bp, ly + pad + head.size * 0.04, (x1 - x0 + bp * 2) * f, head.size * 0.96);
      }
    }
    for (const wd of words) {
      if (wd.f <= 0) continue;
      const lit = wd.hl && t > litAt;
      ctx.globalAlpha = wd.f;
      const yy = ly + pad + ascent + (1 - wd.f) * head.lineHeight * 0.9;
      if (!lit) {
        ctx.shadowColor = 'rgba(0,0,0,0.45)';
        ctx.shadowBlur = head.size * 0.1;
        ctx.shadowOffsetY = head.size * 0.03;
      }
      ctx.fillStyle = lit ? PN.navy : PN.white;
      ctx.fillText(wd.text, wd.x, yy);
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  });
  const headEnd = T_HEAD + k * WORD_STEP + 0.25;

  // 7) linha fina
  if (deck) {
    applyFont(ctx, DECK, deck.size);
    const da = deck.size * 0.8;
    const dpad = (deck.lineHeight - deck.size) / 2;
    deck.lines.forEach((line, i) => {
      const f = eo(seg(t, headEnd + i * 0.12, headEnd + 0.45 + i * 0.12));
      if (f <= 0) return;
      ctx.globalAlpha = f;
      ctx.fillStyle = PN.ice;
      let x = (c.style.align === 'center' ? padX + (maxW - line.width) / 2 : padX) - (1 - f) * 24 * u;
      for (const r of line.runs) {
        if (r.text !== ' ') ctx.fillText(r.text, x, deckY + i * deck.lineHeight + dpad + da);
        x += r.w;
      }
    });
    ctx.globalAlpha = 1;
  }

  // 8) rodapé da placa: fio vermelho curto + site
  const foot = eo(seg(t, headEnd + 0.2, headEnd + 0.7));
  if (foot > 0) {
    const fy = h - footH / 2 - 14 * u;
    ctx.fillStyle = PN.red;
    const rw = 70 * u * foot;
    ctx.fillRect(w / 2 - rw / 2, fy - 26 * u, rw, 5 * u);
    ctx.globalAlpha = foot;
    applyFont(ctx, SITE, 26 * u);
    ctx.fillStyle = PN.sky;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(PN.site.toLocaleUpperCase('pt-BR'), w / 2, fy + 6 * u);
    ctx.globalAlpha = 1;
  }
}
