import { expect, test } from '@playwright/test';

/** Manchetes no layout anterior (pedido): sem o painel de ajuste do carimbo. */
test('manchete sem painel de carimbo e desenhando no palco', async ({ page }) => {
  await page.goto('/?local=1');
  await page.getByTestId('new-reel').click();
  await page.getByTestId('rail-text').click();
  await page.getByTestId('preset-pn-faixa').click();
  await expect(page.getByTestId('clip-text')).toHaveCount(1);
  await expect(page.getByTestId('stamp-controls')).toHaveCount(0);
  await expect(page.getByTestId('insp-title')).toBeVisible();
});
