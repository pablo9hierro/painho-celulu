import { expect, test, type Page } from '@playwright/test';

/**
 * Logo PNG que virou JPG com fundo branco (WhatsApp/galeria): qualquer upload
 * do app tira o fundo e guarda um PNG transparente.
 */
async function alphaOf(page: Page, url: string) {
  return page.evaluate(async (u) => {
    const img = new Image();
    img.src = u;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const g = c.getContext('2d')!;
    g.drawImage(img, 0, 0);
    const a = (x: number, y: number) => g.getImageData(x, y, 1, 1).data[3]!;
    const w = c.width;
    const h = c.height;
    return { corner: a(2, 2), center: a(Math.round(w * 0.5), Math.round(h * 0.42)) };
  }, url);
}

test('upload de logo com fundo branco fica transparente (Mídia e Marca)', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?local=1');
  await page.getByTestId('new-reel').click();
  await expect(page.getByTestId('stage')).toBeVisible();

  // Mídia
  await page.getByTestId('file-input').setInputFiles('e2e/assets/logo-fundo-branco.jpg');
  const item = page.getByTestId('media-item').filter({ hasText: 'logo-fundo-branco' });
  await expect(item).toHaveClass(/ready/, { timeout: 30_000 });
  await expect(item).toContainText('.png');
  const url = await item.locator('img').getAttribute('src');
  const a = await alphaOf(page, url!);
  expect(a.corner).toBe(0);
  expect(a.center).toBe(255);

  // Marca
  await page.getByTestId('rail-brand').click();
  await page.locator('[data-testid="panel-brand"] input[type=file]').setInputFiles('e2e/assets/logo-horizontal-fundo-branco.jpg');
  const brand = page.locator('[data-testid="panel-brand"] .media-item').filter({ hasText: 'logo-horizontal-fundo-branco' });
  await expect(brand).toBeVisible({ timeout: 30_000 });
  const b = await alphaOf(page, (await brand.locator('img').getAttribute('src'))!);
  expect(b.corner).toBe(0);

  // no vídeo, sobre a moldura azul, sem retângulo branco
  await brand.click();
  await page.waitForTimeout(800);
  await page.getByTestId('stage').screenshot({ path: 'test-results/cutout-stage.png' });

  // excluir imagem enviada (lixeira visível) — logos oficiais não têm lixeira
  // (o painel Marca continua aberto)
  const del = brand.getByTestId('brand-del');
  await expect(del).toBeVisible();
  await del.click();
  await page.getByTestId('dialog-ok').click();
  await expect(brand).toHaveCount(0);
  await expect(page.locator('[data-testid="panel-brand"] .media-item').filter({ hasText: 'Logo horizontal' }).getByTestId('brand-del')).toHaveCount(0);
  expect(errors).toEqual([]);
});
