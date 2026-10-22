import { describe, expect, it } from 'vitest';
import { timeStretch } from './timeStretch';

/** frequência dominante por cruzamentos de zero */
function freq(x: Float32Array, sr: number) {
  let z = 0;
  const a = Math.floor(x.length * 0.1);
  const b = Math.floor(x.length * 0.9);
  for (let i = a + 1; i < b; i++) if (x[i - 1]! < 0 && x[i]! >= 0) z++;
  return z / ((b - a) / sr);
}

describe('velocidade sem mudar o tom (WSOLA)', () => {
  const sr = 48000;
  const tone = new Float32Array(sr * 2).map((_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / sr));

  for (const speed of [2, 0.5, 1.5]) {
    it(`${speed}x: duração muda, tom continua 440 Hz`, () => {
      const [out] = timeStretch([tone], speed, sr);
      expect(out!.length).toBe(Math.floor(tone.length / speed));
      expect(Math.abs(freq(out!, sr) - 440)).toBeLessThan(8);
      // sem buracos/estouros
      let peak = 0;
      for (let i = sr * 0.1; i < out!.length - sr * 0.1; i++) peak = Math.max(peak, Math.abs(out![i]!));
      expect(peak).toBeGreaterThan(0.4);
      expect(peak).toBeLessThan(0.7);
    });
  }

  it('44,1 kHz (comum em vídeo de celular/Instagram): 0,5x e 2x mantêm 440 Hz', () => {
    const sr2 = 44100;
    const t2 = new Float32Array(sr2 * 2).map((_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / sr2));
    for (const sp of [0.5, 2]) {
      const [o] = timeStretch([t2], sp, sr2);
      expect(Math.abs(freq(o!, sr2) - 440)).toBeLessThan(5);
    }
  });

  it('1x devolve o próprio áudio', () => {
    const r = timeStretch([tone], 1, sr);
    expect(r[0]).toBe(tone);
  });
});
