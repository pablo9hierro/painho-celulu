import { expect, test, type Page } from '@playwright/test';
import { uniqueTestVideo } from './fixtures';

type Clip = { id: string; type: string; start: number; duration: number; keyframes?: { t: number; x: number }[]; logo?: { hidden: boolean; dx: number; dy: number; opacity: number } };
const state = (page: Page) =>
  page.evaluate(() => {
    const s = (window as unknown as { __editor: { getState(): { project: { clips: Clip[] }; selection: string[]; frameLogoId: string | null } } }).__editor.getState();
    return { clips: s.project.clips, selection: s.selection, frameLogoId: s.frameLogoId };
  });
const setTime = (page: Page, t: number) =>
  page.evaluate((v) => (window as unknown as { __editor: { getState(): { setTime(t: number): void } } }).__editor.getState().setTime(v), t);

async function reelWithVideo(page: Page) {
  await page.goto('/?local=1');
  await page.getByTestId('new-reel').click();
  const { file, name } = uniqueTestVideo();
  await page.getByTestId('file-input').setInputFiles(file);
  const item = page.getByTestId('media-item').filter({ hasText: name });
  await expect(item).toHaveClass(/ready/, { timeout: 60_000 });
  await item.click();
  await expect(page.getByTestId('clip-video')).toHaveCount(1);
}

test('logo da moldura: selecionar no preview, arrastar, opacidade e tirar (sem item novo na timeline)', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await reelWithVideo(page);
  await page.getByTestId('rail-text').click();
  await page.getByTestId('frame-topo').click();
  await page.getByTestId('rail-text').click(); // fecha o painel
  const before = (await state(page)).clips.length;

  // toca na logo do cabeçalho (topo do quadro, no centro)
  const stage = (await page.getByTestId('stage-overlay').boundingBox())!;
  const lx = stage.x + stage.width / 2;
  const ly = stage.y + stage.height * 0.07;
  await page.mouse.click(lx, ly);
  await expect(page.getByTestId('frame-logo-gizmo')).toBeVisible();
  let s = await state(page);
  expect(s.frameLogoId).not.toBeNull();

  // arrasta a logo
  await page.mouse.move(lx, ly);
  await page.mouse.down();
  await page.mouse.move(lx + 40, ly + 30, { steps: 6 });
  await page.mouse.up();
  s = await state(page);
  const frame = s.clips.find((c) => c.type === 'frame')!;
  expect(frame.logo!.dx).toBeGreaterThan(20);
  expect(frame.logo!.dy).toBeGreaterThan(10);
  expect(s.clips.length).toBe(before); // nada novo na timeline

  // opacidade nos Ajustes
  await expect(page.getByTestId('frame-logo-controls')).toBeVisible();
  const slider = page.getByTestId('frame-logo-controls').locator('input[type=range]');
  await slider.fill('0.4');
  s = await state(page);
  expect(s.clips.find((c) => c.type === 'frame')!.logo!.opacity).toBeCloseTo(0.4, 1);
  await page.screenshot({ path: 'test-results/logo-moldura-movida.png' });

  // tirar com a lixeira: some só a logo, a moldura fica
  await page.mouse.click(lx + 40, ly + 30);
  await page.getByTestId('frame-logo-del').click();
  s = await state(page);
  const f2 = s.clips.find((c) => c.type === 'frame');
  expect(f2).toBeTruthy();
  expect(f2!.logo!.hidden).toBe(true);
  await expect(page.getByTestId('frame-logo-gizmo')).toHaveCount(0);

  // a lixeira da timeline com a logo selecionada também só tira a logo
  await page.getByTestId('clip-frame').click();
  await page.getByTestId('frame-logo-toggle').click(); // mostrar de novo
  s = await state(page);
  expect(s.clips.find((c) => c.type === 'frame')!.logo!.hidden).toBe(false);
  await page.mouse.click(lx + 40, ly + 30);
  await page.getByTestId('tl-delete').click();
  s = await state(page);
  expect(s.clips.filter((c) => c.type === 'frame')).toHaveLength(1);
  expect(s.clips.find((c) => c.type === 'frame')!.logo!.hidden).toBe(true);
  expect(errors).toEqual([]);
});

test('Movimento (Pan/Crop do Vegas): mexer o item em pontos da agulha cria nós e o item se move', async ({ page }) => {
  await reelWithVideo(page);
  await page.getByTestId('rail-text').click();
  await page.getByTestId('preset-pn-faixa').click();
  await page.getByTestId('rail-text').click();
  await page.getByTestId('tl-pancrop').click(); // botão Pan/Crop da timeline
  await expect(page.getByTestId('tl-pancrop')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('pancrop-badge')).toBeVisible();

  const text = page.getByTestId('clip-text');
  const id = (await state(page)).clips.find((c) => c.type === 'text')!.id;
  const drag = async (dx: number) => {
    const s = (await state(page)).clips.find((c) => c.id === id)!;
    void s;
    await page.waitForTimeout(300);
    const g = (await page.locator('.gizmo').first().boundingBox())!;
    const cx = g.x + g.width / 2;
    const cy = g.y + g.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + dx, cy, { steps: 6 });
    await page.mouse.up();
  };
  await text.click();
  const start = (await state(page)).clips.find((c) => c.id === id)!.start;
  await setTime(page, start + 2);
  await drag(-60);
  let c = (await state(page)).clips.find((x) => x.id === id)!;
  expect(c.keyframes!.map((k) => Math.round(k.t * 10) / 10)).toEqual([0, 2]);
  await setTime(page, start + 1);
  await drag(80);
  c = (await state(page)).clips.find((x) => x.id === id)!;
  expect(c.keyframes!.length).toBe(3);
  await expect(text.getByTestId('kf-dot')).toHaveCount(3);
  await expect(text.locator('.kf-line')).toHaveCount(1);
  // tocar no nó leva a agulha até ele
  await text.getByTestId('kf-dot').nth(2).click(); // nó em 2 s (a agulha está no de 1 s)
  const t = await page.evaluate(() => (window as unknown as { __editor: { getState(): { time: number } } }).__editor.getState().time);
  expect(t).toBeCloseTo(start + 2, 1);
  await page.screenshot({ path: 'test-results/movimento-nos.png' });
});
