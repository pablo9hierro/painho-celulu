/** Logo do encerramento escolhida aparece no vídeo EXPORTADO (PC e app). */
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { uniqueTestVideo } from './fixtures';
import { ffmpegPaths } from '../server/config';
function reds(file: string, at: number) {
  const raw = execFileSync(ffmpegPaths().ffmpeg, ['-v', 'error', '-ss', String(at), '-i', file, '-frames:v', '1', '-vf', 'scale=270:480', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 26 });
  let n = 0;
  for (let i = 0; i < raw.length; i += 3) if (raw[i]! > 170 && raw[i + 1]! < 90 && raw[i + 2]! < 110) n++;
  return n;
}
for (const mode of ['servidor', 'local']) {
  test(`encerramento obedece logo escolhida no vídeo exportado (${mode})`, async ({ page }) => {
    test.setTimeout(240_000);
    await page.goto(mode === 'local' ? '/?local=1' : '/');
    await page.getByTestId('new-reel').click();
    const { file, name } = uniqueTestVideo();
    await page.getByTestId('file-input').setInputFiles(file);
    const item = page.getByTestId('media-item').filter({ hasText: name });
    await expect(item).toHaveClass(/ready/, { timeout: 60_000 });
    await item.click();
    await page.getByTestId('rail-text').click();
    const opt = page.locator('[data-testid="outro-logos"] [title="PN 3D vermelho"]');
    await opt.scrollIntoViewIfNeeded();
    await opt.click();
    await page.waitForTimeout(800);
    expect(await page.evaluate(() => localStorage.getItem('pn-frame-logo-outro'))).toBe('brand:pn-3d-vermelho');
    await page.getByTestId('open-export').click();
    const dl = page.waitForEvent('download', { timeout: 200_000 });
    await page.getByTestId('start-export').click();
    const d = await dl;
    const out = `test-results/outro-${mode}.mp4`;
    await d.saveAs(out);
    // a logo escolhida (com luzes vermelhas) aparece no encerramento do vídeo exportado
    for (const at of [7.6, 8.6]) expect(reds(out, at)).toBeGreaterThan(800);
  });
}

/** logo ENVIADA pelo usuário (não só as embutidas) também tem que valer no encerramento */
for (const mode of ['servidor', 'local']) {
test(`encerramento obedece logo enviada pelo usuário (${mode})`, async ({ page }) => {
  test.setTimeout(240_000);
  const tag = `logo-vermelha-teste-${Date.now().toString(36)}`;
  const logo = `e2e/.fixtures/${tag}.png`;
  execFileSync(ffmpegPaths().ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=white:s=600x300', '-vf', 'drawbox=x=60:y=40:w=480:h=220:color=red@1:t=fill', '-frames:v', '1', logo]);
  await page.goto(mode === 'local' ? '/?local=1' : '/');
  await page.getByTestId('new-reel').click();
  const { file, name } = uniqueTestVideo();
  await page.getByTestId('file-input').setInputFiles(file);
  const item = page.getByTestId('media-item').filter({ hasText: name });
  await expect(item).toHaveClass(/ready/, { timeout: 60_000 });
  await item.click();
  await page.getByTestId('rail-text').click();
  const box = page.getByTestId('outro-logos');
  await box.scrollIntoViewIfNeeded();
  const before = await box.locator('[data-testid="frame-logo-outro-custom"]').count();
  await box.locator('input[type=file]').setInputFiles(logo);
  await expect(box.locator('[data-testid="frame-logo-outro-custom"]')).toHaveCount(before + 1, { timeout: 30_000 });
  await box.locator(`[title*="${tag}"]`).first().click();
  await page.waitForTimeout(800);
  const chosen = await page.evaluate(() => localStorage.getItem('pn-frame-logo-outro'));
  expect(chosen && chosen !== 'builtin').toBeTruthy();
  // reabre o projeto (a escolha tem que continuar valendo depois de recarregar)
  await page.reload();
  await expect(page.getByTestId('clip-video')).toHaveCount(1, { timeout: 30_000 });
  await page.getByTestId('open-export').click();
  const dl = page.waitForEvent('download', { timeout: 200_000 });
  await page.getByTestId('start-export').click();
  const out = `test-results/outro-enviada-${mode}.mp4`;
  await (await dl).saveAs(out);
  for (const at of [7.6, 8.6]) expect(reds(out, at)).toBeGreaterThan(800);
});
}
