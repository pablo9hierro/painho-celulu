import { expect, test, type Page } from '@playwright/test';
import { uniqueTestVideo } from './fixtures';

type Clip = { id: string; type: string; start: number; mode?: string; preset?: string; transform: { opacity: number }; keyframes?: { t: number }[] };
const clips = (page: Page) => page.evaluate(() => (window as unknown as { __editor: { getState(): { project: { clips: Clip[] } } } }).__editor.getState().project.clips);
const setTime = (page: Page, t: number) => page.evaluate((v) => (window as unknown as { __editor: { getState(): { setTime(t: number): void } } }).__editor.getState().setTime(v), t);

async function reel(page: Page, local = true) {
  await page.goto(local ? '/?local=1' : '/');
  await page.getByTestId('new-reel').click();
  const { file, name } = uniqueTestVideo();
  await page.getByTestId('file-input').setInputFiles(file);
  const item = page.getByTestId('media-item').filter({ hasText: name });
  await expect(item).toHaveClass(/ready/, { timeout: 60_000 });
  await item.click();
  await expect(page.getByTestId('clip-video')).toHaveCount(1);
}

/** cor média de um ponto do canvas do palco */
const stagePixel = (page: Page, fx: number, fy: number) =>
  page.evaluate(
    ([x, y]) => {
      const c = document.querySelector('[data-testid="stage"] canvas') as HTMLCanvasElement;
      const d = c.getContext('2d')!.getImageData(Math.round(c.width * x!), Math.round(c.height * y!), 1, 1).data;
      return [d[0]!, d[1]!, d[2]!];
    },
    [fx, fy],
  );

test('Postagem: busca notícias, mostra cards e escreve a legenda (back-end simulado)', async ({ page }) => {
  await page.route('**/api/news?*', (r) =>
    r.fulfill({
      json: {
        articles: [
          { title: 'Polícia prende suspeito em Santa Rita', url: 'https://g1.globo.com/a', source: 'G1', date: '2026-10-19T10:00:00Z', snippet: 'Homem de 32 anos foi preso.', via: 'bing', readable: true },
          { title: 'Suspeito é detido na Grande João Pessoa', url: 'https://news.google.com/x', source: 'Portal Correio', date: '2026-10-19T09:00:00Z', snippet: '', via: 'google', readable: false },
        ],
        plan: { queries: ['preso Santa Rita'], recency: '3d', used: '3d', note: '', names: [], costUsd: 0.0002, missing: [] },
      },
    }),
  );
  await page.route('**/api/news/config', (r) => r.fulfill({ json: { ai: true } }));
  await page.route('**/api/fx', (r) => r.fulfill({ json: { rate: 5, at: '2026-10-20', approx: false } }));
  let sent: { articles: unknown[]; prompt: string } | null = null;
  await page.route('**/api/news/write', (r) => {
    sent = r.request().postDataJSON();
    return r.fulfill({
      json: {
        text: 'POLÍCIA PRENDE SUSPEITO EM SANTA RITA\n\nA PM prendeu um homem de 32 anos em Santa Rita.\n\nFonte: G1\n\n#SantaRita',
        unverified: ['Carlos'],
        style: [],
        model: 'google/gemini-2.5-flash-lite',
        steps: ['Escrita: google/gemini-2.5-flash-lite'],
        sources: [{ url: 'https://g1.globo.com/a', title: 'x', source: 'G1', chars: 900 }],
        costUsd: 0.0018,
      },
    });
  });
  await reel(page, false);
  await page.getByTestId('open-post').click();
  await page.getByTestId('post-query').fill('preso Santa Rita');
  await page.getByTestId('post-search').click();
  await expect(page.getByTestId('post-card')).toHaveCount(2);
  await page.getByTestId('post-prompt').fill('foque na ação da polícia');
  await page.getByTestId('post-write').click();
  // título em negrito Unicode por padrão; desligando, volta ao texto normal
  await expect(page.getByTestId('post-text')).not.toHaveValue(/POLÍCIA PRENDE/);
  await expect(page.getByTestId('post-text')).toHaveValue(/Santa Rita./);
  await page.getByTestId('post-bold').uncheck();
  await expect(page.getByTestId('post-text')).toHaveValue(/^POLÍCIA PRENDE SUSPEITO EM SANTA RITA/);
  await expect(page.getByTestId('post-count')).toContainText('/ 2200');
  await expect(page.getByTestId('post-info')).toContainText('Confira nas fontes');
  expect(sent!.prompt).toBe('foque na ação da polícia');
  // custo da IA em reais: busca R$ 0,0010 + matéria R$ 0,0090 = R$ 0,0100
  await expect(page.getByTestId('ai-cost')).toContainText('total: R$ 0,01');
  await expect(page.getByTestId('ai-cost')).toContainText('Gasto total com IA neste aparelho');
  expect(sent!.articles.length).toBe(1); // só a que dá para ler veio marcada
  await page.screenshot({ path: 'test-results/postagem.png' });
});

test('filtro preto e branco, marca d’água @ com opacidade e nós do Pan/Crop', async ({ page }) => {
  await reel(page);
  // ---- filtro P&B: vídeo fica cinza (a barra de cor do teste vira cinza)
  await page.getByTestId('rail-text').click();
  const before = await stagePixel(page, 0.5, 0.5);
  await page.getByTestId('add-bw').click();
  await page.waitForTimeout(500);
  const after = await stagePixel(page, 0.5, 0.5);
  const sat = (c: number[]) => Math.max(...c) - Math.min(...c);
  expect(sat(before)).toBeGreaterThan(30);
  expect(sat(after)).toBeLessThan(6);
  expect((await clips(page)).find((c) => c.type === 'blur')!.mode).toBe('bw');

  // ---- marca d'água @: entra semitransparente; opacidade ajustável
  await page.getByTestId('preset-pn-marca-dagua').click();
  let wm = (await clips(page)).find((c) => c.preset === 'pn-marca-dagua')!;
  expect(wm.transform.opacity).toBeCloseTo(0.35, 2);
  const slider = page.locator('.slider').filter({ hasText: 'Opacidade' }).locator('input[type=range]');
  await slider.fill('0.6');
  wm = (await clips(page)).find((c) => c.preset === 'pn-marca-dagua')!;
  expect(wm.transform.opacity).toBeCloseTo(0.6, 2);
  await page.getByTestId('rail-text').click();

  // ---- Pan/Crop: cria 3 nós, seleciona um, edita, apaga só o nó
  await page.getByTestId('tl-pancrop').click();
  const text = page.getByTestId('clip-text').filter({ hasText: "Marca d'água" });
  await text.click();
  const drag = async (dx: number) => {
    await page.waitForTimeout(300);
    const g = (await page.locator('.gizmo').first().boundingBox())!;
    await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
    await page.mouse.down();
    await page.mouse.move(g.x + g.width / 2 + dx, g.y + g.height / 2, { steps: 5 });
    await page.mouse.up();
  };
  await setTime(page, 2);
  await drag(-50);
  await setTime(page, 4);
  await drag(60);
  const kf = () => clips(page).then((cs) => cs.find((c) => c.preset === 'pn-marca-dagua')!.keyframes!.length);
  expect(await kf()).toBe(3);
  // toca no nó de 4 s (a agulha está em 4 s → toca no de 2 s)
  await text.getByTestId('kf-dot').nth(1).click();
  await expect(page.getByTestId('kf-selected')).toContainText('2.00 s');
  await expect(text.getByTestId('kf-dot').nth(1)).toHaveClass(/on/);
  await page.getByTestId('kf-delete').click();
  expect(await kf()).toBe(2);
  // lixeira da timeline com nó selecionado apaga só o nó, não o item
  await text.getByTestId('kf-dot').nth(1).click();
  await page.getByTestId('tl-delete').click();
  expect(await kf()).toBe(1);
  expect((await clips(page)).some((c) => c.preset === 'pn-marca-dagua')).toBe(true);
  await page.screenshot({ path: 'test-results/filtro-marca-nos.png' });
});

test('logo do encerramento escolhida é obedecida (mesmo depois de reabrir)', async ({ page }) => {
  await reel(page);
  await page.getByTestId('rail-text').click();
  await page.locator('[data-testid="outro-logos"] [title="PN 3D sirene"]').click();
  await page.reload();
  await expect(page.getByTestId('clip-video')).toHaveCount(1, { timeout: 20_000 });
  await page.getByTestId('rail-text').click();
  await page.getByTestId('add-outro').click();
  await setTime(page, 6 + 2.6);
  await page.waitForTimeout(800);
  // a logo "sirene" tem vermelho forte; a padrão é só azul
  const reds = await page.evaluate(() => {
    const c = document.querySelector('[data-testid="stage"] canvas') as HTMLCanvasElement;
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, Math.round(c.height * 0.62)).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i]! > 170 && d[i + 1]! < 90 && d[i + 2]! < 110) n++;
    return n;
  });
  expect(reds).toBeGreaterThan(200);
});
