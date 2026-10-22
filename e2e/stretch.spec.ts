import { expect, test, type Page } from '@playwright/test';
import { uniqueTestVideo } from './fixtures';

type Clip = { id: string; type: string; mode?: string; start: number; duration: number };
const clips = (page: Page) => page.evaluate(() => (window as unknown as { __editor: { getState(): { project: { clips: Clip[] } | null } } }).__editor.getState().project?.clips ?? []);

/** arrasta a borda direita do item (sanfona) e devolve a nova duração */
async function dragRightEdge(page: Page, id: string, dx: number) {
  const el = page.locator(`[data-clip="${id}"]`);
  await el.click();
  const edge = el.locator('.edge-r');
  const b = (await edge.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + dx, b.y + b.height / 2, { steps: 8 });
  await page.mouse.up();
  return (await clips(page)).find((c) => c.id === id)!.duration;
}

test('filtro P&B e desfoque esticam e encolhem na timeline (sanfona)', async ({ page }) => {
  await page.goto('/?local=1');
  await page.getByTestId('new-reel').click();
  const { file, name } = uniqueTestVideo();
  await page.getByTestId('file-input').setInputFiles(file);
  const item = page.getByTestId('media-item').filter({ hasText: name });
  await expect(item).toHaveClass(/ready/, { timeout: 60_000 });
  await item.click();
  // filtro preto e branco
  await page.getByTestId('rail-text').click();
  await page.getByTestId('add-bw').click();
  const bw = (await clips(page)).find((c) => c.type === 'blur' && c.mode === 'bw')!;
  const d0 = bw.duration;
  const shorter = await dragRightEdge(page, bw.id, -80);
  expect(shorter).toBeLessThan(d0 - 0.3);
  const longer = await dragRightEdge(page, bw.id, 160);
  expect(longer).toBeGreaterThan(shorter + 0.5);
  // o painel do filtro é só do filtro (sem forma nem modo de desfoque)
  await expect(page.getByText('Intensidade do filtro')).toBeVisible();
  await expect(page.getByText('Pixelizar')).toHaveCount(0);
});

test('desfoque e filtro deslizam (arrastar o corpo) e esticam pela borda esquerda', async ({ page }) => {
  await page.goto('/?local=1');
  await page.getByTestId('new-reel').click();
  const { file, name } = uniqueTestVideo();
  await page.getByTestId('file-input').setInputFiles(file);
  const item = page.getByTestId('media-item').filter({ hasText: name });
  await expect(item).toHaveClass(/ready/, { timeout: 60_000 });
  await item.click();
  // desfoque desenhado no palco
  await page.getByTestId('rail-blur').click();
  await page.getByTestId('blur-rect').click();
  const st = (await page.getByTestId('stage').boundingBox())!;
  await page.mouse.move(st.x + st.width * 0.4, st.y + st.height * 0.4);
  await page.mouse.down();
  await page.mouse.move(st.x + st.width * 0.6, st.y + st.height * 0.55, { steps: 6 });
  await page.mouse.up();
  const blur = (await clips(page)).find((c) => c.type === 'blur' && c.mode !== 'bw')!;
  expect(blur).toBeTruthy();
  const shorter = await dragRightEdge(page, blur.id, -100);
  expect(shorter).toBeLessThan(blur.duration - 0.3);
  // desliza o item inteiro para a direita
  const el = page.locator(`[data-clip="${blur.id}"]`);
  const b = (await el.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + 60, b.y + b.height / 2, { steps: 8 });
  await page.mouse.up();
  const moved = (await clips(page)).find((c) => c.id === blur.id)!;
  expect(moved.start).toBeGreaterThan(blur.start + 0.2);
  // borda esquerda: encolhe pelo começo
  const le = (await el.locator('.edge-l').boundingBox())!;
  await page.mouse.move(le.x + le.width / 2, le.y + le.height / 2);
  await page.mouse.down();
  await page.mouse.move(le.x + le.width / 2 + 40, le.y + le.height / 2, { steps: 6 });
  await page.mouse.up();
  const trimmed = (await clips(page)).find((c) => c.id === blur.id)!;
  expect(trimmed.start).toBeGreaterThan(moved.start + 0.1);
  await expect(page.getByText('Intensidade do desfoque')).toBeVisible();
});
