import { test } from '@playwright/test';

/** Capturas de referência para revisão visual (não fazem asserções de layout). */
test('tela de projetos', async ({ page }) => {
  await page.goto('/');
  await page.waitForTimeout(800);
  await page.screenshot({ path: 'test-results/screens/home.png' });
});

test('painel de manchetes', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('new-reel').click();
  await page.getByTestId('rail-text').click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'test-results/screens/manchetes.png' });
});

test('galeria de manchetes em tamanho real', async ({ page }) => {
  await page.goto('/');
  await page.waitForTimeout(500);
  await page.evaluate(async () => {
    // módulos servidos pelo Vite no navegador
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const load = (m: string) => import(/* @vite-ignore */ m) as Promise<any>;
    const { HEADLINE_PRESETS: ALL } = await load('/src/core/presets.ts');
    const HEADLINE_PRESETS = (ALL as { id: string; hidden?: boolean }[]).filter((p) => !p.hidden);
    const { createProject, createTextClip } = await load('/src/core/factory.ts');
    const { drawHeadline } = await load('/src/render/headlines.ts');
    const { ensureFonts } = await load('/src/render/fonts.ts');
    const { ensureBrandAssets } = await load('/src/render/brandAssets.ts');
    await ensureFonts();
    await ensureBrandAssets();
    const p = createProject('g', 'reel');
    const cols = 2;
    const cellW = 1080;
    const cellH = 560;
    const rows = Math.ceil(HEADLINE_PRESETS.length / cols);
    const c = document.createElement('canvas');
    c.width = cols * cellW;
    c.height = rows * cellH;
    const ctx = c.getContext('2d')!;
    const drawAll = () => HEADLINE_PRESETS.forEach((pr: { id: string }, i: number) => {
      const x = (i % cols) * cellW;
      const y = Math.floor(i / cols) * cellH;
      // "vídeo" de fundo: degradê quente para checar contraste
      const g = ctx.createLinearGradient(x, y, x + cellW, y + cellH);
      g.addColorStop(0, '#6b4a3a');
      g.addColorStop(1, '#2c3a2a');
      ctx.fillStyle = g;
      ctx.fillRect(x, y, cellW, cellH);
      const clip = createTextClip(p, pr.id, 0);
      const s = Math.min((cellW * 0.94) / clip.transform.width, (cellH * 0.86) / clip.transform.height);
      ctx.save();
      ctx.translate(x + (cellW - clip.transform.width * s) / 2, y + (cellH - clip.transform.height * s) / 2);
      ctx.scale(s, s);
      drawHeadline(ctx, clip, { w: clip.transform.width, h: clip.transform.height, p: 1, t: 3 });
      ctx.restore();
    });
    // 1ª passada dispara o carregamento das logos na instância usada pelas manchetes
    drawAll();
    await new Promise((r) => setTimeout(r, 2500));
    drawAll();
    document.body.innerHTML = '';
    c.style.width = '100%';
    document.body.appendChild(c);
    document.body.style.background = '#000';
  });
  await page.setViewportSize({ width: 1400, height: 3400 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'test-results/screens/galeria.png', fullPage: true });
});
