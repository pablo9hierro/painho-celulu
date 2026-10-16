import { expect, test } from '@playwright/test';
import { uniqueTestVideo } from './fixtures';

test('layout mobile: palco, timeline, barra inferior e toque', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('new-reel').click();
  await expect(page.getByTestId('stage')).toBeVisible();
  // a barra de ferramentas fica embaixo e abre painéis como folha
  await page.getByTestId('rail-media').tap();
  await expect(page.getByTestId('panel-media')).toBeVisible();
  const { file, name } = uniqueTestVideo();
  await page.getByTestId('file-input').setInputFiles(file);
  const item = page.getByTestId('media-item').filter({ hasText: name });
  await expect(item).toHaveClass(/ready/, { timeout: 60_000 });
  await item.tap();
  await expect(page.getByTestId('clip-video')).toHaveCount(1);
  await page.getByTestId('rail-text').tap();
  await page.getByTestId('preset-pn-urgente').tap();
  await page.getByTestId('rail-text').tap(); // fecha a folha
  await expect(page.getByTestId('clip-text')).toHaveCount(1);
  const stage = (await page.getByTestId('stage').boundingBox())!;
  const vp = page.viewportSize()!;
  expect(stage.width).toBeLessThanOrEqual(vp.width);
  expect(stage.height).toBeGreaterThan(200);
  // barra de rolagem da timeline grande o bastante para o dedo
  const sb = (await page.getByTestId('tl-scrollbar').boundingBox())!;
  expect(sb.height).toBeGreaterThanOrEqual(28);
  // segurar o dedo num botão mostra o nome dele, sem acionar
  const btn = page.getByTestId('fullscreen');
  const bb = (await btn.boundingBox())!;
  const cdp = await page.context().newCDPSession(page);
  const pt = { x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt] });
  await page.waitForTimeout(700);
  await expect(page.getByTestId('tooltip')).toHaveText(/tela cheia/i);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(200);
  await expect(page.locator('.stage-area.full')).toHaveCount(0);
  await page.waitForTimeout(1600);
  await page.screenshot({ path: 'test-results/editor-mobile.png' });
});

/** Botões essenciais inteiros dentro da tela em vários tamanhos de celular. */
for (const vp of [
  { width: 320, height: 640 },
  { width: 360, height: 740 },
  { width: 393, height: 852 },
  { width: 412, height: 915 },
]) {
  test(`responsivo ${vp.width}x${vp.height}: nenhum botão essencial fora da tela`, async ({ page }) => {
    await page.setViewportSize(vp);
    await page.goto('/');
    await page.getByTestId('new-reel').click();
    await expect(page.getByTestId('stage')).toBeVisible();
    // um item selecionado para habilitar Ajustes
    await page.getByTestId('rail-text').tap();
    await page.getByTestId('preset-pn-faixa').tap();
    await page.getByTestId('rail-text').tap();
    const must = [
      page.getByLabel('Projetos'),
      page.getByTestId('open-export'),
      page.getByTestId('play'),
      page.getByLabel('Ajustes do item'),
      page.getByTestId('fullscreen'),
      page.getByTestId('rail-media'),
      page.getByTestId('rail-audio'),
      page.getByTestId('tl-split'),
      page.getByTestId('tl-delete'),
    ];
    for (const el of must) {
      await expect(el).toBeVisible();
      const b = (await el.boundingBox())!;
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width).toBeLessThanOrEqual(vp.width + 0.5);
      expect(b.y + b.height).toBeLessThanOrEqual(vp.height + 0.5);
    }
    // Ajustes abre o inspector com o texto da manchete
    await page.getByLabel('Ajustes do item').tap();
    await expect(page.getByTestId('insp-title')).toBeVisible();
    await page.screenshot({ path: `test-results/responsivo-${vp.width}.png` });
  });
}

/** Recursos novos cabem num celular pequeno (320 px, como Xiaomi com "tela ampliada"). */
test('320px: velocidade, corte, voz e exportação sem estourar a tela', async ({ page }) => {
  test.setTimeout(120_000);
  const vp = { width: 320, height: 640 };
  await page.setViewportSize(vp);
  await page.goto('/?local=1');
  await page.getByTestId('new-reel').click();
  await page.getByTestId('rail-media').tap();
  const { file, name } = uniqueTestVideo();
  await page.getByTestId('file-input').setInputFiles(file);
  const item = page.getByTestId('media-item').filter({ hasText: name });
  await expect(item).toHaveClass(/ready/, { timeout: 60_000 });
  // lixeira da mídia visível no celular (sem precisar de mouse em cima)
  await expect(item.locator('.media-del')).toBeVisible();
  await item.tap();
  await page.getByTestId('rail-media').tap();
  await expect(page.getByTestId('clip-video')).toHaveCount(1);
  const inside = async (sel: ReturnType<typeof page.getByTestId>) => {
    await sel.scrollIntoViewIfNeeded();
    const b = (await sel.boundingBox())!;
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width).toBeLessThanOrEqual(vp.width + 0.5);
  };
  const noHScroll = async () => expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(vp.width);

  await page.getByLabel('Ajustes do item').tap();
  for (const v of ['0.25', '1', '4']) await inside(page.getByTestId(`speed-${v}`));
  await inside(page.getByTestId('crop-toggle'));
  await noHScroll();
  await page.screenshot({ path: 'test-results/mobile-320-ajustes.png' });
  await page.getByLabel('Fechar ajustes').tap();

  await page.getByTestId('rail-blur').tap();
  for (const v of ['normal', 'high', 'low']) await inside(page.getByTestId(`voice-${v}`));
  await noHScroll();
  await page.screenshot({ path: 'test-results/mobile-320-voz.png' });
  await page.getByTestId('rail-blur').tap();

  await page.getByTestId('open-export').tap();
  await inside(page.getByTestId('start-export'));
  await page.getByTestId('start-export').tap();
  await inside(page.getByTestId('cancel-export'));
  await page.getByTestId('cancel-export').tap();
  await expect(page.getByTestId('start-export')).toBeVisible({ timeout: 1500 });
  await noHScroll();
});
