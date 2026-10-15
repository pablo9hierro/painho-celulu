import { expect, test } from '@playwright/test';
import { probe, uniqueTestVideo } from './fixtures';

/**
 * Modo LOCAL (o mesmo do app Android): nada passa pelo servidor.
 * Projetos e mídia no IndexedDB, exportação por WebCodecs, download ao aparelho.
 */
test('modo local: importar, editar e exportar MP4 sem servidor', async ({ page }) => {
  test.setTimeout(240_000);
  const apiCalls: string[] = [];
  page.on('request', (r) => {
    if (new URL(r.url()).pathname.startsWith('/api/')) apiCalls.push(r.url());
  });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/?local=1');
  await page.getByTestId('new-reel').click();
  await expect(page.getByTestId('stage')).toBeVisible();

  const { file, name } = uniqueTestVideo();
  await page.getByTestId('file-input').setInputFiles(file);
  const item = page.getByTestId('media-item').filter({ hasText: name });
  await expect(item).toHaveClass(/ready/, { timeout: 60_000 });
  await item.click();
  await expect(page.getByTestId('clip-video')).toHaveCount(1);

  await page.getByTestId('rail-text').click();
  await page.getByTestId('frame-topo').click();
  await page.getByTestId('preset-pn-faixa').click();
  await expect(page.getByTestId('clip-text')).toHaveCount(1);
  await expect(page.locator('.save-state')).toHaveText('Salvo', { timeout: 10_000 });

  // o projeto sobrevive a recarregar a página (memória local)
  await page.reload();
  await expect(page.getByTestId('clip-video')).toHaveCount(1, { timeout: 20_000 });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: 'test-results/local-editor.png' });

  await page.getByTestId('open-export').click();
  const dl = page.waitForEvent('download', { timeout: 200_000 });
  await page.getByTestId('start-export').click();
  const download = await dl;
  await expect(page.getByTestId('export-done')).toBeVisible({ timeout: 30_000 });
  const saved = `test-results/local-${download.suggestedFilename()}`;
  await download.saveAs(saved);
  const info = probe(saved);
  expect(info.streams).toContain('video');
  expect(info.streams).toContain('audio');
  expect(info.width).toBe(1080);
  expect(info.height).toBe(1920);
  expect(Math.abs(info.duration - 9.5)).toBeLessThan(0.3); // 6 s + encerramento automático (3,5 s)

  // o encerramento foi só para o vídeo: a timeline salva não mudou
  await page.getByTestId('export-dialog').getByLabel('Fechar').click();
  await expect(page.getByTestId('clip-text')).toHaveCount(1);

  expect(apiCalls).toEqual([]);
  expect(errors).toEqual([]);
});
