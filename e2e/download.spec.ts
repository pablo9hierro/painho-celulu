import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { uniqueTestVideo } from './fixtures';

/** Baixar vídeo pela tela inicial (download simulado para não depender do Instagram). */
test('baixar vídeo: link → confere → Editar este vídeo abre o projeto com o vídeo', async ({ page }) => {
  const { file } = uniqueTestVideo();
  const bytes = readFileSync(file);
  await page.route('**/api/download?*', (r) => r.fulfill({ status: 200, body: bytes, headers: { 'Content-Type': 'video/mp4', 'X-File-Name': 'reels-teste.mp4', 'X-Via': 'instagram' } }));
  await page.goto('/');
  await page.getByTestId('hub-download').click();
  await page.getByTestId('dl-link').fill('https://www.instagram.com/reel/ABC123xyz/');
  await page.getByTestId('dl-go').click();
  await expect(page.getByTestId('dl-done')).toContainText('não está corrompido');
  await page.getByTestId('dl-edit').click();
  await expect(page.getByTestId('clip-video')).toHaveCount(1, { timeout: 60_000 });
});

test('baixar vídeo: falha (Instagram limitando) mostra o motivo; arquivo corrompido é recusado; importar arquivo funciona', async ({ page }) => {
  let call = 0;
  await page.route('**/api/download?*', (r) => {
    call++;
    if (call === 1) return r.fulfill({ status: 422, json: { error: 'O Instagram está limitando os downloads agora (muitos pedidos).', steps: ['consulta: HTTP 401 (limite)'] } });
    // 2ª vez: "vídeo" quebrado (só lixo) → precisa ser recusado
    return r.fulfill({ status: 200, body: Buffer.alloc(200_000, 7), headers: { 'Content-Type': 'video/mp4' } });
  });
  await page.goto('/?local=1');
  await page.getByTestId('hub-download').click();
  await page.getByTestId('dl-link').fill('https://www.instagram.com/reel/ABC123xyz/');
  await page.getByTestId('dl-go').click();
  await expect(page.getByTestId('dl-error')).toContainText('limitando');
  await page.getByTestId('dl-go').click();
  await expect(page.getByTestId('dl-error')).toContainText(/corrompido|não é um vídeo/);
  await expect(page.getByTestId('dl-done')).toHaveCount(0);
  // reserva: importar o arquivo do aparelho
  const { file } = uniqueTestVideo();
  await page.getByTestId('download-dialog').locator('input[type=file]').setInputFiles(file);
  await expect(page.getByTestId('dl-done')).toBeVisible();
  await page.getByTestId('dl-edit').click();
  await expect(page.getByTestId('clip-video')).toHaveCount(1, { timeout: 60_000 });
});
