import { expect, test } from '@playwright/test';
import { uniqueTestVideo } from './fixtures';

/**
 * Ao fechar/recarregar logo depois de editar (como o Android encerrando o app
 * em segundo plano), a última edição não pode se perder.
 */
for (const mode of ['local', 'servidor'] as const) {
  test(`edição sobrevive a fechar o app na hora (${mode})`, async ({ page }) => {
    await page.goto(mode === 'local' ? '/?local=1' : '/');
    await page.getByTestId('new-reel').click();
    const { file, name } = uniqueTestVideo();
    await page.getByTestId('file-input').setInputFiles(file);
    const item = page.getByTestId('media-item').filter({ hasText: name });
    await expect(item).toHaveClass(/ready/, { timeout: 60_000 });
    await item.click();
    await expect(page.getByTestId('clip-video')).toHaveCount(1);
    await page.getByTestId('rail-text').click();
    await page.getByTestId('preset-pn-faixa').click();
    await expect(page.getByTestId('clip-text')).toHaveCount(1);
    // fecha/recarrega imediatamente (sem esperar o salvamento automático)
    await page.reload();
    await expect(page.getByTestId('clip-video')).toHaveCount(1, { timeout: 20_000 });
    await expect(page.getByTestId('clip-text')).toHaveCount(1);
    // e o salvamento normal termina depois de reabrir
    await expect(page.locator('.save-state')).toHaveText('Salvo', { timeout: 15_000 });
  });
}
