import { expect, test, type Page } from '@playwright/test';
import { probe, uniqueTestVideo } from './fixtures';

type Clip = { id: string; type: string; start: number; duration: number; frame?: string; transform?: { x: number; y: number; width: number; height: number } };
type Snapshot = { clips: Clip[]; selection: string[]; time: number };

async function state(page: Page): Promise<Snapshot> {
  return page.evaluate(() => {
    const s = (window as unknown as { __editor: { getState(): { project: { clips: Clip[] }; selection: string[]; time: number } } }).__editor.getState();
    return { clips: s.project.clips, selection: s.selection, time: s.time };
  });
}

async function newReelWithVideo(page: Page) {
  await page.goto('/');
  await page.getByTestId('new-reel').click();
  await expect(page.getByTestId('stage')).toBeVisible();
  const { file, name } = uniqueTestVideo();
  await page.getByTestId('file-input').setInputFiles(file);
  const item = page.getByTestId('media-item').filter({ hasText: name });
  await expect(item).toHaveClass(/ready/, { timeout: 60_000 });
  await item.click();
  await expect(page.getByTestId('clip-video')).toHaveCount(1);
}

test('fluxo completo: importar, manchete, manipular, desfocar, cortar e exportar', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await newReelWithVideo(page);
  let s = await state(page);
  expect(s.clips[0]!.duration).toBeCloseTo(6, 0);

  // manchete
  await page.getByTestId('rail-text').click();
  await page.getByTestId('preset-pn-faixa').click();
  await expect(page.getByTestId('clip-text')).toHaveCount(1);
  s = await state(page);
  const text = s.clips.find((c) => c.type === 'text')!;
  expect(s.selection).toEqual([text.id]);

  // arrastar a manchete no canvas (manipulação direta)
  await page.evaluate(() => (window as unknown as { __editor: { getState(): { setTime(t: number): void } } }).__editor.getState().setTime(2));
  const stage = page.getByTestId('stage-overlay');
  const box = (await stage.boundingBox())!;
  const scale = box.width / 1080;
  const cx = box.x + text.transform!.x * scale;
  const cy = box.y + text.transform!.y * scale;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx, cy - 60, { steps: 8 });
  await page.mouse.up();
  s = await state(page);
  const moved = s.clips.find((c) => c.id === text.id)!;
  expect(moved.transform!.y).toBeLessThan(text.transform!.y - 40);

  // redimensionar pela alça lateral: muda só a largura
  const handle = page.locator('[data-handle="e"]');
  const hb = (await handle.boundingBox())!;
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x - 80, hb.y + hb.height / 2, { steps: 6 });
  await page.mouse.up();
  s = await state(page);
  const resized = s.clips.find((c) => c.id === text.id)!;
  expect(resized.transform!.width).toBeLessThan(moved.transform!.width - 50);
  expect(resized.transform!.height).toBeCloseTo(moved.transform!.height, 0);

  // desfazer volta a largura
  await page.keyboard.press('Control+z');
  s = await state(page);
  expect(s.clips.find((c) => c.id === text.id)!.transform!.width).toBeCloseTo(moved.transform!.width, 0);

  // desfoque desenhado no canvas
  await page.getByTestId('rail-blur').click();
  await page.getByTestId('blur-rect').click();
  await page.mouse.move(box.x + 60, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + 200, box.y + 300, { steps: 6 });
  await page.mouse.up();
  await expect(page.getByTestId('clip-blur')).toHaveCount(1);

  // dividir o vídeo na agulha (2 s)
  await page.getByTestId('clip-video').click({ position: { x: 20, y: 20 } });
  await page.evaluate(() => (window as unknown as { __editor: { getState(): { setTime(t: number): void } } }).__editor.getState().setTime(2));
  await page.keyboard.press('s');
  await expect(page.getByTestId('clip-video')).toHaveCount(2);

  // aparar a borda direita do último trecho de vídeo pela timeline
  const last = page.getByTestId('clip-video').nth(1);
  await last.click({ position: { x: 30, y: 20 } });
  const lb = (await last.boundingBox())!;
  await page.mouse.move(lb.x + lb.width - 3, lb.y + lb.height / 2);
  await page.mouse.down();
  await page.mouse.move(lb.x + lb.width - 60, lb.y + lb.height / 2, { steps: 6 });
  await page.mouse.up();
  s = await state(page);
  const vids = s.clips.filter((c) => c.type === 'video').sort((a, b) => a.start - b.start);
  expect(vids[1]!.duration).toBeLessThan(4 - 0.2);

  // salvamento automático
  await expect(page.locator('.save-state')).toHaveText('Salvo', { timeout: 10_000 });

  await page.screenshot({ path: 'test-results/editor-desktop.png' });

  // exportação real com FFmpeg
  await page.getByTestId('open-export').click();
  const downloadPromise = page.waitForEvent('download', { timeout: 150_000 });
  await page.getByTestId('start-export').click();
  const download = await downloadPromise;
  await expect(page.getByTestId('export-done')).toBeVisible({ timeout: 30_000 });
  const saved = `test-results/${download.suggestedFilename()}`;
  await download.saveAs(saved);
  // a cópia interna do app foi apagada após a entrega ao dispositivo
  const exportsList = (await page.evaluate(async () => (await fetch('/api/exports')).json())) as { status: string; filePath: string | null }[];
  expect(exportsList[0]!.status).toBe('delivered');
  expect(exportsList[0]!.filePath).toBeNull();
  const info = probe(saved);
  expect(info.streams).toContain('video');
  expect(info.streams).toContain('audio');
  expect(info.width).toBe(1080);
  expect(info.height).toBe(1920);
  const total = vids[0]!.duration + vids[1]!.duration;
  // + 3,5 s do encerramento automático no fim
  expect(Math.abs(info.duration - Math.max(total, s.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0)) - 3.5)).toBeLessThan(0.25);

  expect(errors).toEqual([]);
});

test('navegação: agulha arrastável com rolagem automática, esticar na borda, barra larga, dicas e tela cheia', async ({ page }) => {
  await newReelWithVideo(page);
  const ed = (fn: string, arg?: unknown) =>
    page.evaluate(
      ([f, a]) => {
        const s = (window as unknown as { __editor: { getState(): Record<string, (x: unknown) => void> } }).__editor.getState();
        s[f as string]!(a);
      },
      [fn, arg] as const,
    );
  const scrollLeft = () => page.getByTestId('timeline').evaluate((el) => el.scrollLeft);
  const tl = (await page.getByTestId('timeline').boundingBox())!;

  // 1) arrastar a agulha até a borda direita: a timeline anda sozinha
  await ed('setZoom', 400);
  await ed('setTime', 0.2);
  const ph = (await page.getByTestId('playhead').boundingBox())!;
  await page.mouse.move(ph.x + ph.width / 2, tl.y + 80);
  await page.mouse.down();
  await page.mouse.move(tl.x + tl.width - 8, tl.y + 80, { steps: 6 });
  await page.waitForTimeout(1200);
  await page.mouse.up();
  expect(await scrollLeft()).toBeGreaterThan(200);
  const t = (await state(page)).time;
  expect(t).toBeGreaterThan((tl.width - 132) / 400);

  // 2) barra de rolagem larga: arrastar o polegar de volta ao início
  const thumb = (await page.locator('.hsb-thumb').boundingBox())!;
  await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2);
  await page.mouse.down();
  await page.mouse.move(tl.x - 200, thumb.y + thumb.height / 2, { steps: 6 });
  await page.mouse.up();
  expect(await scrollLeft()).toBe(0);

  // 3) esticar um bloco até a borda: a timeline anda e o bloco continua crescendo
  await ed('setZoom', 100);
  await ed('setTime', 0);
  await page.getByTestId('rail-text').click();
  await page.getByTestId('preset-pn-faixa').click();
  const textClip = page.getByTestId('clip-text');
  const cb = (await textClip.boundingBox())!;
  await page.mouse.move(cb.x + cb.width - 3, cb.y + cb.height / 2);
  await page.mouse.down();
  await page.mouse.move(tl.x + tl.width - 6, cb.y + cb.height / 2, { steps: 6 });
  await page.waitForTimeout(1500);
  await page.mouse.up();
  const text = (await state(page)).clips.find((c) => c.type === 'text')!;
  expect(text.duration).toBeGreaterThan((tl.width - 132) / 100 + 1);

  // 4) dica ao passar o mouse
  await page.getByTestId('fullscreen').hover();
  await expect(page.getByTestId('tooltip')).toHaveText(/tela cheia/i);

  // 5) prévia em tela cheia e saída com Esc
  await page.getByTestId('fullscreen').click();
  await expect(page.locator('.stage-area.full')).toBeVisible();
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'test-results/tela-cheia.png' });
  await page.keyboard.press('Escape');
  await expect(page.locator('.stage-area.full')).toHaveCount(0);
});

test('confirmação estilizada ao excluir mídia', async ({ page }) => {
  await newReelWithVideo(page);
  const item = page.getByTestId('media-item').first();
  await item.hover();
  await item.locator('.media-del').click();
  const dlg = page.getByTestId('dialog');
  await expect(dlg).toBeVisible();
  await expect(dlg).toContainText('Excluir arquivo?');
  await page.waitForTimeout(200);
  await page.screenshot({ path: 'test-results/dialog.png' });
  await page.keyboard.press('Escape');
  await expect(dlg).toHaveCount(0);
});

test('moldura + manchete: cada escolha vira um único item, inserido na agulha', async ({ page }) => {
  await newReelWithVideo(page);
  await page.evaluate(() => (window as unknown as { __editor: { getState(): { setTime(t: number): void } } }).__editor.getState().setTime(1.5));
  await page.getByTestId('rail-text').click();
  await page.getByTestId('frame-topo').click();
  let s = await state(page);
  expect(s.clips).toHaveLength(2); // vídeo + 1 moldura
  expect(s.clips.filter((c) => c.type === 'frame')).toHaveLength(1);
  // com a moldura selecionada, tocar em outro modelo troca o modelo dela
  await page.getByTestId('frame-central').click();
  s = await state(page);
  expect(s.clips.filter((c) => c.type === 'frame')).toHaveLength(1);
  expect(s.clips.find((c) => c.type === 'frame')!.frame).toBe('central');
  await page.getByTestId('frame-topo').click();
  s = await state(page);
  expect(s.clips.find((c) => c.type === 'frame')!.frame).toBe('topo');
  // sem seleção, uma nova moldura entra como item normal (várias permitidas)
  await page.evaluate(() => (window as unknown as { __editor: { getState(): { select(ids: string[]): void } } }).__editor.getState().select([]));
  await page.getByTestId('frame-central').click();
  s = await state(page);
  expect(s.clips.filter((c) => c.type === 'frame')).toHaveLength(2);
  await page.keyboard.press('Delete');
  s = await state(page);
  expect(s.clips.filter((c) => c.type === 'frame')).toHaveLength(1);

  await page.getByTestId('preset-pn-faixa').click();
  s = await state(page);
  expect(s.clips).toHaveLength(3);
  const text = s.clips.find((c) => c.type === 'text')!;
  expect(text.start).toBeCloseTo(1.5, 1);
  expect(text.start + text.duration).toBeLessThanOrEqual(6.01); // não passa do fim do vídeo

  // restaurar padrão depois de mover
  const before = text.transform!;
  await page.evaluate((id) => {
    const ed = (window as unknown as { __editor: { getState(): { apply(fn: (p: { clips: { id: string; transform?: object }[] }) => unknown): void } } }).__editor;
    ed.getState().apply((p) => ({ ...p, clips: p.clips.map((c) => (c.id === id ? { ...c, transform: { ...c.transform, y: 100 } } : c)) }));
  }, text.id);
  await page.getByTestId('reset-clip').click();
  s = await state(page);
  expect(s.clips.find((c) => c.id === text.id)!.transform!.y).toBeCloseTo(before.y, 0);

  await page.evaluate(() => (window as unknown as { __editor: { getState(): { setTime(t: number): void } } }).__editor.getState().setTime(3));
  await page.waitForTimeout(900);
  await page.screenshot({ path: 'test-results/moldura-faixa.png' });
});
