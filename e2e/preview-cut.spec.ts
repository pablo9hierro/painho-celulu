import { expect, test, type Page } from '@playwright/test';
import { uniqueTestVideo } from './fixtures';

type Ed = { getState(): { project: { clips: { id: string; type: string; start: number; duration: number }[] }; setTime(t: number): void; select(i: string[]): void; apply(fn: (p: unknown) => unknown): void } };
const ed = (page: Page) => page.evaluate(() => (window as unknown as { __editor: Ed }).__editor.getState().project.clips.filter((c) => c.type === 'video').map((c) => ({ start: c.start, duration: c.duration })));
/** brilho médio do centro do palco (0 = preto) */
const brilho = (page: Page) =>
  page.evaluate(() => {
    const c = document.querySelector('[data-testid="stage"] canvas') as HTMLCanvasElement;
    const d = c.getContext('2d')!.getImageData(Math.round(c.width * 0.3), Math.round(c.height * 0.45), Math.round(c.width * 0.4), 8).data;
    let s = 0;
    for (let i = 0; i < d.length; i += 4) s += d[i]! + d[i + 1]! + d[i + 2]!;
    return s / (d.length / 4) / 3;
  });

test('prévia: depois de cortar, o vídeo toca sem ficar preto no corte', async ({ page }) => {
  await page.goto('/?local=1');
  await page.getByTestId('new-reel').click();
  const { file, name } = uniqueTestVideo();
  await page.getByTestId('file-input').setInputFiles(file);
  const item = page.getByTestId('media-item').filter({ hasText: name });
  await expect(item).toHaveClass(/ready/, { timeout: 60_000 });
  await item.click();
  // corta de 2 s a 3,5 s (tira o meio) pelo mesmo código da edição por IA
  await page.evaluate(async () => {
    const load = (p: string) => import(/* @vite-ignore */ p);
    const m = (await load('/src/news/editAi.ts')) as { cutRange(p: unknown, a: number, b: number): unknown };
    (window as unknown as { __editor: Ed }).__editor.getState().apply((p) => m.cutRange(p, 2, 3.5));
  });
  expect((await ed(page)).length).toBe(2);
  await page.evaluate(() => (window as unknown as { __editor: Ed }).__editor.getState().select([]));
  await page.evaluate(() => (window as unknown as { __editor: Ed }).__editor.getState().setTime(1.2));
  await page.waitForTimeout(800);
  await page.getByTestId('play').click();
  // passa pelo corte (2 s): mede a tela várias vezes logo depois
  const medidas: number[] = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 2200) {
    medidas.push(await brilho(page));
    await page.waitForTimeout(60);
  }
  await page.getByTestId('play').click();
  const pretas = medidas.filter((b) => b < 8).length;
  console.log('amostras', medidas.length, 'pretas', pretas);
  expect(pretas).toBe(0);
});
