import { expect, test, type Page } from '@playwright/test';
import { uniqueTestVideo } from './fixtures';

type C = { id: string; type: string; start: number; duration: number; trackId: string; group?: string };
type St = { getState(): { project: { clips: C[]; tracks: { id: string; kind: string }[] }; select(i: string[]): void; apply(fn: (p: unknown) => unknown): void } };
const state = (page: Page) => page.evaluate(() => (window as unknown as { __editor: St }).__editor.getState().project);
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 5 });
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
}
const centro = async (page: Page, id: string) => {
  const b = (await page.locator(`[data-clip="${id}"]`).boundingBox())!;
  return { x: b.x + Math.min(40, b.width / 2), y: b.y + b.height / 2 };
};

test('linha do tempo estilo CapCut: trocar de lugar, faixa nova, grupo e juntar trechos', async ({ page }) => {
  await page.goto('/?local=1');
  await page.getByTestId('new-reel').click();
  const { file, name } = uniqueTestVideo();
  await page.getByTestId('file-input').setInputFiles(file);
  const item = page.getByTestId('media-item').filter({ hasText: name });
  await expect(item).toHaveClass(/ready/, { timeout: 60_000 });
  await item.click(); // A na faixa principal
  await page.waitForTimeout(800);
  await item.click(); // B: a principal está ocupada → vai para uma camada
  await expect(page.getByTestId('clip-video')).toHaveCount(2);
  let p = await state(page);
  const [A, B] = p.clips.filter((c) => c.type === 'video').sort((a) => (a.trackId === p.tracks[0]!.id ? -1 : 1));
  expect(A!.trackId).not.toBe(B!.trackId);

  // 1) soltar B em cima de A (outra faixa, ocupada por 1 item) → trocam de lugar
  const a1 = await centro(page, A!.id);
  await page.locator(`[data-clip="${B!.id}"]`).click();
  await drag(page, await centro(page, B!.id), { x: a1.x, y: a1.y });
  p = await state(page);
  expect(p.clips.find((c) => c.id === B!.id)!.trackId).toBe(A!.trackId);
  expect(p.clips.find((c) => c.id === A!.id)!.trackId).toBe(B!.trackId);

  // 2) arrastar acima de todas as faixas → abre UMA faixa nova só para ele
  const nTracks = p.tracks.length;
  const topLane = (await page.locator('.tl-lane[data-track]').first().boundingBox())!;
  const b1 = await centro(page, B!.id);
  await page.locator(`[data-clip="${B!.id}"]`).click();
  await drag(page, b1, { x: b1.x, y: topLane.y - 6 });
  p = await state(page);
  expect(p.tracks.length).toBe(nTracks + 1);
  expect(p.tracks.filter((t) => t.kind === 'visual').pop()!.id).toBe(p.clips.find((c) => c.id === B!.id)!.trackId);

  // 3) agrupar e arrastar: andam juntos
  await page.evaluate(([a, b]) => (window as unknown as { __editor: St }).__editor.getState().select([a!, b!]), [A!.id, B!.id]);
  await page.getByTestId('tl-group').click();
  p = await state(page);
  const g = p.clips.find((c) => c.id === A!.id)!.group;
  expect(g).toBeTruthy();
  expect(p.clips.find((c) => c.id === B!.id)!.group).toBe(g);
  const antesB = p.clips.find((c) => c.id === B!.id)!.start;
  const a2 = await centro(page, A!.id);
  await page.evaluate((a) => (window as unknown as { __editor: St }).__editor.getState().select([a]), A!.id);
  await drag(page, a2, { x: a2.x + 120, y: a2.y });
  p = await state(page);
  const dA = p.clips.find((c) => c.id === A!.id)!.start;
  expect(dA).toBeGreaterThan(0.5);
  expect(p.clips.find((c) => c.id === B!.id)!.start - antesB).toBeCloseTo(dA, 1);

  // 4) juntar trechos: tira o vácuo do começo
  await page.getByTestId('tl-gaps').click();
  p = await state(page);
  expect(Math.min(...p.clips.filter((c) => c.type === 'video').map((c) => c.start))).toBeCloseTo(0, 2);
});

test('faixa de áudio: silenciar e volume', async ({ page }) => {
  await page.goto('/?local=1');
  await page.getByTestId('new-reel').click();
  await page.getByTestId('tl-vol').first().click();
  await expect(page.getByTestId('tl-vol-pop')).toBeVisible();
  await page.getByTestId('tl-vol-pop').locator('input').fill('0.5');
  const vol = await page.evaluate(() => ((window as unknown as { __editor: { getState(): { project: { tracks: { volume?: number }[] } } } }).__editor.getState().project.tracks.find((t) => t.volume !== undefined)?.volume));
  expect(vol).toBeCloseTo(0.5, 2);
  await page.getByTestId('tl-mute').first().click();
  const muted = await page.evaluate(() => (window as unknown as { __editor: { getState(): { project: { tracks: { muted: boolean }[] } } } }).__editor.getState().project.tracks.some((t) => t.muted));
  expect(muted).toBe(true);
});
