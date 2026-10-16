import { expect, test, type Page } from '@playwright/test';

/** As 5 logos 3D vêm dentro do app, transparentes, na Marca e nas escolhas de logo. */
const NAMES = ['PN 3D azul', 'PN 3D sirene', 'PN 3D luzes', 'PN 3D vermelho', 'PN horizontal luzes', 'PN horizontal azul'];

async function alpha(page: Page, url: string) {
  return page.evaluate(async (u) => {
    const i = new Image();
    i.src = u;
    await i.decode();
    const c = document.createElement('canvas');
    c.width = i.naturalWidth;
    c.height = i.naturalHeight;
    const g = c.getContext('2d')!;
    g.drawImage(i, 0, 0);
    return { corner: g.getImageData(3, 3, 1, 1).data[3], mid: g.getImageData(c.width / 2, c.height / 2, 1, 1).data[3] };
  }, url);
}

for (const mode of ['local', 'servidor'] as const) {
  test(`logos 3D embutidas e transparentes (${mode})`, async ({ page }) => {
    await page.goto(mode === 'local' ? '/?local=1' : '/');
    await page.getByTestId('new-reel').click();
    await page.getByTestId('rail-brand').click();
    const panel = page.getByTestId('panel-brand');
    for (const n of NAMES) {
      const item = panel.locator('.media-item').filter({ hasText: n });
      await expect(item).toHaveCount(1);
      await expect(item.getByTestId('brand-del')).toHaveCount(0); // embutida: sem lixeira
      const a = await alpha(page, (await item.locator('img').getAttribute('src'))!);
      expect(a.corner).toBe(0); // canto transparente
      expect(a.mid).toBeGreaterThan(200); // logo sólida no meio
    }
    // cópias antigas da pasta brand/ não aparecem em dobro
    await expect(panel.locator('.media-item').filter({ hasText: 'Imagem do ChatGPT' })).toHaveCount(0);
    await expect(panel.locator('.media-item').filter({ hasText: 'Logo 3D Primeiras' })).toHaveCount(0);
    // inserir no vídeo
    await panel.locator('.media-item').filter({ hasText: 'PN 3D sirene' }).click();
    await page.waitForTimeout(600);
    await page.getByTestId('stage').screenshot({ path: `test-results/logo-3d-${mode}.png` });
    // nas escolhas de logo da moldura e do encerramento
    await page.getByTestId('rail-text').click();
    await expect(page.locator('[data-testid="frame-logos"] [title="PN 3D azul"]')).toHaveCount(2); // horizontal e redonda
    await expect(page.locator('[data-testid="outro-logos"] [title="PN 3D vermelho"]')).toHaveCount(1);
  });
}
