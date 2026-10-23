/**
 * Legendas automáticas (não é manchete!): texto limpo, letra média (não
 * grossa, não gigante), em caixa normal — maiúsculas só se o usuário pedir.
 * Três visuais:
 *  - limpa: sem fundo, branco com contorno fino escuro e sombra suave;
 *  - caixa: fundo navy translúcido arredondado atrás das linhas;
 *  - destaque: a palavra que está sendo falada ganha a pílula azul da marca,
 *    com um leve "pulo"; as já ditas ficam brancas, as próximas mais claras.
 * Cada pessoa que fala tem uma cor (1: branco, 2: azul-claro PN, 3: amarelo...).
 */
import type { TextClip } from '../core/model';
import { clamp, ease } from '../core/animation';
import { FONTS, PN } from '../core/brand';
import { applyFont, type FontSpec } from './text';
import { wordTimes } from '../news/transcribe';

type C = CanvasRenderingContext2D;

const FONT: FontSpec = { family: FONTS.sans, weight: 700 };
/** cor do texto de cada pessoa */
export const SPEAKER_COLORS = [PN.white, PN.sky, PN.yellow, '#9BE7A0', '#FFB4C8'];
const eo = ease['ease-out'];

interface Laid {
  text: string;
  w: number;
  i: number;
}

export function drawCaption(ctx: C, c: TextClip, { w, h, t }: { w: number; h: number; t: number }) {
  const cap = c.caption;
  // texto editado à mão: refaz o tempo das palavras pela duração do item
  const typed = c.fields.title.trim().split(/\s+/).filter(Boolean).join(' ');
  const words = cap?.words.length && cap.words.map((x) => x.w).join(' ') === typed ? cap.words : wordTimes(typed, c.duration * 0.92);
  if (!words.length) return;
  const look = cap?.look ?? 'limpa';
  const boxed = look === 'caixa' || look === 'caixa-destaque';
  const karaoke = look === 'destaque' || look === 'caixa-destaque';
  const color = SPEAKER_COLORS[((cap?.speaker ?? 1) - 1) % SPEAKER_COLORS.length]!;
  const upper = c.style.uppercase;
  // a ALTURA da caixa define o tamanho da letra (esticar em cima/embaixo ou pelo canto
  // aumenta/diminui); a LARGURA define onde a linha quebra. Se o texto não couber no
  // número de linhas escolhido (1, 2 ou 3), a letra diminui até caber.
  const maxLines = cap?.linhas ?? 2;
  const base = Math.min(h * 0.27, w * 0.09) * (c.style.fontScale || 1);
  const maxW = w * 0.96;
  const wrap = (sz: number) => {
    applyFont(ctx, FONT, sz);
    const sp = ctx.measureText(' ').width;
    const out: Laid[][] = [[]];
    let lw = 0;
    words.forEach((x, i) => {
      const text = upper ? x.w.toLocaleUpperCase('pt-BR') : x.w;
      const ww = ctx.measureText(text).width;
      const last = out[out.length - 1]!;
      if (last.length && lw + sp + ww > maxW) {
        out.push([{ text, w: ww, i }]);
        lw = ww;
      } else {
        lw += (last.length ? sp : 0) + ww;
        last.push({ text, w: ww, i });
      }
    });
    return { lines: out, space: sp };
  };
  let size = base;
  let laid = wrap(size);
  while (laid.lines.length > maxLines && size > base * 0.4) {
    size *= 0.92;
    laid = wrap(size);
  }
  const { lines, space } = laid;
  const lh = size * 1.28;
  const blockH = lines.length * lh;
  const y0 = (h - blockH) / 2;
  const align = c.style.align;
  // entrada curta (sobe 6% e aparece)
  const inF = eo(clamp(t / 0.15, 0, 1));
  ctx.save();
  ctx.globalAlpha *= inF;
  ctx.translate(0, (1 - inF) * size * 0.3);
  // palavra atual (pela fala)
  let cur = -1;
  for (let i = 0; i < words.length; i++) if (t >= words[i]!.t) cur = i;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  lines.forEach((line, li) => {
    const width = line.reduce((s, x) => s + x.w, 0) + space * (line.length - 1);
    let x = align === 'left' ? w * 0.02 : align === 'right' ? w * 0.98 - width : (w - width) / 2;
    const yc = y0 + li * lh + lh / 2;
    if (boxed) {
      const padX = size * 0.45;
      const padY = size * 0.18;
      ctx.save();
      ctx.fillStyle = 'rgba(6,20,51,0.78)';
      ctx.beginPath();
      const rx = x - padX;
      const ry = yc - lh / 2 + padY * 0.2;
      const rw = width + padX * 2;
      const rh = lh - padY * 0.4;
      const r = size * 0.28;
      ctx.moveTo(rx + r, ry);
      ctx.arcTo(rx + rw, ry, rx + rw, ry + rh, r);
      ctx.arcTo(rx + rw, ry + rh, rx, ry + rh, r);
      ctx.arcTo(rx, ry + rh, rx, ry, r);
      ctx.arcTo(rx, ry, rx + rw, ry, r);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    for (const word of line) {
      const active = karaoke && word.i === cur;
      const said = word.i <= cur;
      if (active) {
        // pílula azul da marca atrás da palavra falada, com um leve pulo
        const since = t - words[word.i]!.t;
        const pop = 1 + 0.08 * Math.max(0, 1 - since / 0.18);
        const padX = size * 0.16;
        ctx.save();
        ctx.translate(x + word.w / 2, yc);
        ctx.scale(pop, pop);
        ctx.fillStyle = PN.bright;
        const rw = word.w + padX * 2;
        const rh = size * 1.12;
        const r = size * 0.22;
        ctx.beginPath();
        ctx.moveTo(-rw / 2 + r, -rh / 2);
        ctx.arcTo(rw / 2, -rh / 2, rw / 2, rh / 2, r);
        ctx.arcTo(rw / 2, rh / 2, -rw / 2, rh / 2, r);
        ctx.arcTo(-rw / 2, rh / 2, -rw / 2, -rh / 2, r);
        ctx.arcTo(-rw / 2, -rh / 2, rw / 2, -rh / 2, r);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = PN.white;
        ctx.fillText(word.text, -word.w / 2, size * 0.04);
        ctx.restore();
      } else {
        ctx.save();
        if (!boxed) {
          // contorno fino + sombra suave: lê sobre qualquer imagem sem ficar "grosso"
          ctx.lineJoin = 'round';
          // contorno desenhado POR BAIXO do preenchimento: aparece ~7% do corpo em volta de cada letra
          ctx.lineWidth = Math.max(2, size * 0.15);
          ctx.strokeStyle = 'rgba(4,12,30,0.95)';
          ctx.shadowColor = 'rgba(0,0,0,0.55)';
          ctx.shadowBlur = size * 0.22;
          ctx.shadowOffsetY = size * 0.04;
          ctx.strokeText(word.text, x, yc + size * 0.04);
          ctx.shadowColor = 'transparent';
          ctx.shadowOffsetY = 0;
        }
        ctx.fillStyle = color;
        if (karaoke && !said) ctx.globalAlpha *= 0.72;
        ctx.fillText(word.text, x, yc + size * 0.04);
        ctx.restore();
      }
      x += word.w + space;
    }
  });
  ctx.restore();
}
