/**
 * Logos oficiais embutidas no app (não dependem da pasta brand/). São usadas
 * pelas manchetes e molduras — ficam "impregnadas" no gráfico.
 */
import horizontalUrl from '../assets/pn-logo-horizontal.png';
import normalUrl from '../assets/pn-logo-normal.png';
import watermarkUrl from '../assets/pn-logo-watermark.jpg';
import symbolUrl from '../assets/pn-symbol-watermark.jpg';
// redonda com borda fina (o halo grande da original foi cortado; a original continua em pn-logo-round.png)
import roundUrl from '../assets/pn-logo-round-fina.png';
import stampUrl from '../assets/logos/pn-3d-azul.webp';

/**
 * `watermark` = logo horizontal sobre fundo preto; `symbol` = só o símbolo "pn"
 * sobre fundo preto (carimbo das manchetes, mesclagem "screen").
 */
export type BrandLogo = 'horizontal' | 'normal' | 'watermark' | 'symbol' | 'round' | 'outro' | 'stamp';
/** Logos que o usuário pode trocar (molduras e encerramento). */
export type CustomLogo = 'horizontal' | 'round' | 'outro';

export const LOGO_RATIO: Record<BrandLogo, number> = { horizontal: 1572 / 516, normal: 1214 / 1058, watermark: 1564 / 508, symbol: 612 / 508, round: 1134 / 886, outro: 1214 / 1058, stamp: 1 };

const urls: Record<BrandLogo, string> = { horizontal: horizontalUrl, normal: normalUrl, watermark: watermarkUrl, symbol: symbolUrl, round: roundUrl, outro: normalUrl, stamp: stampUrl };
const imgs: Partial<Record<BrandLogo, HTMLImageElement>> = {};
const listeners = new Set<() => void>();
let ready: Promise<void> | null = null;
/** logo pedida por último para cada tipo trocável (escolha do usuário ou a embutida) */
const wanted: Partial<Record<CustomLogo, string>> = {};

function load(k: BrandLogo): Promise<void> {
  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      // a logo embutida chegou DEPOIS da escolhida pelo usuário: não sobrescreve
      // (era o que fazia o encerramento/cabeçalho voltar para a padrão, e esticada)
      const want = (wanted as Partial<Record<BrandLogo, string>>)[k];
      if (want && want !== img.src) return resolve();
      imgs[k] = img;
      if (img.naturalWidth && img.naturalHeight && k in wanted) LOGO_RATIO[k] = img.naturalWidth / img.naturalHeight;
      listeners.forEach((l) => l());
      resolve();
    };
    img.onerror = () => resolve();
    img.src = urls[k];
  });
}

export function ensureBrandAssets(): Promise<void> {
  if (!ready) ready = Promise.all([load('horizontal'), load('normal'), load('watermark'), load('symbol'), load('round'), load('outro'), load('stamp')]).then(() => undefined);
  return ready;
}

export function brandImage(k: BrandLogo): HTMLImageElement | null {
  if (!ready && typeof document !== 'undefined') void ensureBrandAssets();
  return imgs[k] ?? null;
}

/**
 * Logos escolhidas pelo usuário (moldura horizontal, redonda e encerramento). `null` volta
 * para a logo embutida. A proporção é atualizada pela imagem carregada.
 */
let version = 0;
export function brandVersion() {
  return version;
}
export function setLogoOverride(kind: CustomLogo, url: string | null): Promise<void> {
  const src = url ?? urls[kind];
  const abs = new URL(src, location.href).href;
  wanted[kind] = abs;
  if (imgs[kind]?.src === abs) return Promise.resolve();
  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      // uma escolha mais nova já foi pedida: ignora esta (carregou atrasada)
      if (wanted[kind] !== abs) return resolve();
      imgs[kind] = img;
      if (img.naturalWidth && img.naturalHeight) LOGO_RATIO[kind] = img.naturalWidth / img.naturalHeight;
      version++;
      listeners.forEach((l) => l());
      resolve();
    };
    img.onerror = () => resolve();
    img.src = src;
  });
}

export function onBrandLoaded(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

type C = CanvasRenderingContext2D;

/**
 * Desenha a logo com altura `h` a partir de (x, y), exatamente como a imagem é
 * (sem sombra, brilho ou contorno). Retorna a largura ocupada.
 */
export function drawLogo(ctx: C, x: number, y: number, h: number, kind: BrandLogo = 'horizontal'): number {
  const w = h * LOGO_RATIO[kind];
  const img = brandImage(kind);
  if (!img) return w;
  ctx.drawImage(img, x, y, w, h);
  return w;
}

/** Símbolo do Instagram (contorno arredondado + lente + ponto) com o degradê característico. */
export function drawInstagramGlyph(ctx: C, x: number, y: number, s: number) {
  ctx.save();
  const g = ctx.createLinearGradient(x, y + s, x + s, y);
  g.addColorStop(0, '#FEDA75');
  g.addColorStop(0.3, '#FA7E1E');
  g.addColorStop(0.55, '#D62976');
  g.addColorStop(0.8, '#962FBF');
  g.addColorStop(1, '#4F5BD5');
  const lw = s * 0.1;
  ctx.strokeStyle = g;
  ctx.fillStyle = g;
  ctx.lineWidth = lw;
  ctx.beginPath();
  ctx.roundRect(x + lw / 2, y + lw / 2, s - lw, s - lw, s * 0.28);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x + s / 2, y + s / 2, s * 0.22, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x + s * 0.76, y + s * 0.24, s * 0.065, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}
