import { describe, expect, it } from 'vitest';
import { removeFlatBackground } from './cutout';

function image(w: number, h: number, pixel: (x: number, y: number) => [number, number, number, number]) {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px.set(pixel(x, y), (y * w + x) * 4);
  return px;
}
const alphaAt = (px: Uint8ClampedArray, w: number, x: number, y: number) => px[(y * w + x) * 4 + 3];

describe('remoção de fundo liso', () => {
  it('logo azul em fundo branco: fundo vira transparente, logo fica inteira', () => {
    const w = 80;
    const h = 60;
    const px = image(w, h, (x, y) => (Math.hypot(x - 40, y - 30) < 18 ? [20, 90, 230, 255] : [244, 244, 244, 255]));
    expect(removeFlatBackground(px, w, h)).toBe(true);
    expect(alphaAt(px, w, 0, 0)).toBe(0);
    expect(alphaAt(px, w, 79, 59)).toBe(0);
    expect(alphaAt(px, w, 40, 30)).toBe(255);
    expect(alphaAt(px, w, 40, 15)).toBe(255);
  });

  it('fundo preto também sai', () => {
    const w = 40;
    const h = 40;
    const px = image(w, h, (x, y) => (x > 12 && x < 28 && y > 12 && y < 28 ? [250, 250, 250, 255] : [0, 0, 0, 255]));
    expect(removeFlatBackground(px, w, h)).toBe(true);
    expect(alphaAt(px, w, 2, 2)).toBe(0);
    expect(alphaAt(px, w, 20, 20)).toBe(255);
  });

  it('foto (borda variada) não é alterada', () => {
    const w = 50;
    const h = 50;
    const px = image(w, h, (x, y) => [(x * 37 + y * 11) % 256, (x * 7 + y * 53) % 256, (x * 91) % 256, 255]);
    const before = px.slice();
    expect(removeFlatBackground(px, w, h)).toBe(false);
    expect(px).toEqual(before);
  });

  it('imagem que já tem transparência não é alterada', () => {
    const w = 30;
    const h = 30;
    const px = image(w, h, (x) => (x < 15 ? [255, 255, 255, 0] : [255, 255, 255, 255]));
    const before = px.slice();
    expect(removeFlatBackground(px, w, h)).toBe(false);
    expect(px).toEqual(before);
  });
});
