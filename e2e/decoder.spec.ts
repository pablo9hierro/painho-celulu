import { expect, test } from '@playwright/test';
import { uniqueTestVideo } from './fixtures';

/**
 * O decodificador sequencial precisa entregar exatamente o mesmo quadro que o
 * <video> mostra no mesmo instante (garantia de que a otimização não muda nada).
 */
test('decodificador sequencial = mesmo quadro do <video>', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/?local=1');
  await page.getByTestId('new-reel').click();
  const { file, name } = uniqueTestVideo();
  await page.getByTestId('file-input').setInputFiles(file);
  await expect(page.getByTestId('media-item').filter({ hasText: name })).toHaveClass(/ready/, { timeout: 60_000 });

  const result = await page.evaluate(async (fileName) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const load = (m: string) => import(/* @vite-ignore */ m) as Promise<any>;
    const { SequentialDecoder } = await load('/src/engine/sequentialDecoder.ts');
    const ed = (window as unknown as { __editor: { getState(): { media: Record<string, { id: string; name: string; url: string }> } } }).__editor;
    const m = Object.values(ed.getState().media).find((x) => x.name.startsWith(fileName))!;
    const dec = await SequentialDecoder.create(m);
    if (!dec) return { ok: false, diffs: [] as number[], timing: 0 };
    const v = document.createElement('video');
    v.muted = true;
    v.src = m.url;
    await new Promise((r) => (v.onloadeddata = r));
    const W = 160;
    const H = 90;
    const ca = document.createElement('canvas');
    const cb = document.createElement('canvas');
    ca.width = cb.width = W;
    ca.height = cb.height = H;
    const a = ca.getContext('2d', { willReadFrequently: true })!;
    const b = cb.getContext('2d', { willReadFrequently: true })!;
    const diffs: number[] = [];
    for (const t of [0, 0.5, 1.03, 2.5, 3.33, 4.0, 5.2]) {
      const f = await dec.frameAt(t);
      a.drawImage(f, 0, 0, W, H);
      v.currentTime = t;
      await new Promise((r) => v.addEventListener('seeked', r, { once: true }));
      b.drawImage(v, 0, 0, W, H);
      const pa = a.getImageData(0, 0, W, H).data;
      const pb = b.getImageData(0, 0, W, H).data;
      let sum = 0;
      for (let i = 0; i < pa.length; i += 4) sum += Math.abs(pa[i]! - pb[i]!) + Math.abs(pa[i + 1]! - pb[i + 1]!) + Math.abs(pa[i + 2]! - pb[i + 2]!);
      diffs.push(sum / (W * H * 3));
    }
    dec.dispose();
    // tempo para decodificar 6 s em sequência (30 fps)
    const dec2 = await SequentialDecoder.create(m);
    const t0 = performance.now();
    for (let i = 0; i < 180; i++) await dec2.frameAt(i / 30);
    const timing = performance.now() - t0;
    dec2.dispose();
    return { ok: true, diffs, timing };
  }, name);

  console.log(`DIFFS=${result.diffs.map((d) => d.toFixed(2)).join(',')} DECODE_180_FRAMES_MS=${result.timing.toFixed(0)}`);
  expect(result.ok).toBe(true);
  // diferença média por canal (0–255): quadros iguais ficam perto de 0
  for (const d of result.diffs) expect(d).toBeLessThan(2);
});
