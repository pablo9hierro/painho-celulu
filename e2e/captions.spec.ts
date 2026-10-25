import { expect, test } from '@playwright/test';
import { uniqueTestVideo } from './fixtures';

type Cap = { id: string; type: string; preset?: string; transform?: { x: number; y: number; width: number; height: number }; start: number; duration: number; trackId: string; fields?: { title: string }; caption?: { speaker: number; look: string; linhas?: number; words: { w: string; t: number; sp?: number }[] }; style?: { uppercase: boolean; align: string } };
const SHOTS = process.env.CAPTION_SHOTS;

test('legendas automáticas: transcreve a fala, separa quem fala e muda o estilo', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  let sent: { model?: string; messages?: { content: { type: string; input_audio?: { data: string; format: string } }[] }[] } | null = null;
  await page.route('https://openrouter.ai/**', async (route) => {
    sent = route.request().postDataJSON();
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          segmentos: [
            { falante: 1, inicio: 0.2, fim: 2.6, texto: 'Bom dia, aqui é o Primeiras Notícias.' },
            { falante: 2, inicio: 2.8, fim: 5.6, texto: 'Obrigado pelo convite, a situação está complicada.' },
          ],
          falantes: [{ id: 1, voz: 'mulher' }, { id: 2, voz: 'homem' }],
        }) } }],
        usage: { cost: 0.0001 },
      }),
    });
  });
  // sem internet para o ouvinte do aparelho (Whisper): testa o caminho reserva, pelas sílabas
  await page.route(/huggingface.co|cdn.jsdelivr.net/, (r) => r.abort());
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('pn-ai-key', 'sk-or-teste'));
  await page.getByTestId('new-reel').click();
  const { file, name } = uniqueTestVideo();
  await page.getByTestId('file-input').setInputFiles(file);
  const item = page.getByTestId('media-item').filter({ hasText: name });
  await expect(item).toHaveClass(/ready/, { timeout: 60_000 });
  await item.click();
  await page.getByTestId('rail-text').click();
  await expect(page.getByTestId('auto-captions')).toBeVisible();
  await page.getByTestId('caption-generate').click();
  await expect(page.getByTestId('caption-count')).toContainText('1 bloco', { timeout: 60_000 });
  // o áudio foi de verdade, como WAV
  expect(sent!.model).toBe('google/gemini-2.5-flash-lite');
  const audio = sent!.messages![0]!.content.find((c) => c.type === 'input_audio')!.input_audio!;
  expect(audio.format).toBe('wav');
  expect(audio.data.startsWith('UklGR')).toBe(true);
  expect(audio.data.length).toBeGreaterThan(100_000); // ~6 s a 16 kHz
  const caps = async () =>
    page.evaluate(() => (window as unknown as { __editor: { getState(): { project: { clips: Cap[]; tracks: { id: string; name: string }[] } } } }).__editor.getState().project);
  let p = await caps();
  let list = p.clips.filter((c) => c.preset === 'pn-legenda');
  // um bloco só (um vídeo), com as frases das duas pessoas
  expect(list).toHaveLength(1);
  expect([...new Set(list[0]!.caption!.words.map((w) => w.sp))]).toEqual([1, 2]);
  expect(p.tracks.find((t) => t.id === list[0]!.trackId)!.name).toBe('Legendas');
  // encostada no começo da voz (o tom de teste começa em 0 s)
  expect(list[0]!.start).toBeLessThan(0.3);
  expect(list[0]!.caption!.look).toBe('destaque');
  // estilos: sem fundo / com fundo / destaque e maiúsculas opcionais
  const shoot = async (tag: string, t: number) => {
    if (!SHOTS) return;
    await page.evaluate((x) => (window as unknown as { __editor: { getState(): { setTime(t: number): void; select(ids: string[]): void } } }).__editor.getState().setTime(x), t);
    await page.evaluate(() => (window as unknown as { __editor: { getState(): { select(ids: string[]): void } } }).__editor.getState().select([]));
    await page.waitForTimeout(400);
    await page.getByTestId('stage').screenshot({ path: `${SHOTS}/legenda-${tag}.png` });
  };
  await shoot('destaque', 1.4);
  await shoot('destaque-2', 4.2);
  await page.getByTestId('caption-bg-true').click(); // com fundo + palavra acesa
  await shoot('caixa', 1.4);
  await page.getByTestId('caption-bg-false').click();
  await page.getByTestId('caption-hl-false').click();
  await page.getByTestId('caption-upper-true').click();
  await shoot('limpa-maiusculas', 4.2);
  // 1 linha, à esquerda
  await page.getByTestId('caption-lines-1').click();
  await page.getByTestId('caption-align-left').click();
  await shoot('uma-linha-esquerda', 4.2);
  p = await caps();
  list = p.clips.filter((c) => c.preset === 'pn-legenda');
  expect(list.every((c) => c.caption!.look === 'limpa' && c.style!.uppercase && c.caption!.linhas === 1 && c.style!.align === 'left')).toBe(true);
  // arrastar uma legenda leva todas para a mesma caixa
  const t0 = list[0]!.transform!;
  await page.evaluate(() => {
    const ed = (window as unknown as { __editor: { getState(): { setTime(t: number): void; select(ids: string[]): void; project: { clips: Cap[] } } } }).__editor.getState();
    ed.setTime(1.4);
    ed.select([ed.project.clips.find((c) => c.preset === 'pn-legenda')!.id]);
  });
  const ov = (await page.getByTestId('stage-overlay').boundingBox())!;
  const scale = ov.width / 1080;
  const cx = ov.x + t0.x * scale;
  const cy = ov.y + t0.y * scale;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx, cy - 300 * scale, { steps: 6 });
  await page.mouse.up();
  p = await caps();
  list = p.clips.filter((c) => c.preset === 'pn-legenda');
  expect(list[0]!.transform!.y).toBeLessThan(t0.y - 200);
  await page.evaluate(() => (window as unknown as { __editor: { getState(): { select(ids: string[]): void } } }).__editor.getState().select([]));
  await shoot('arrastada', 4.2);
  // gerar de novo substitui (não duplica)
  await page.getByTestId('caption-generate').click();
  await expect(page.getByTestId('caption-generate')).toContainText('Gerar de novo', { timeout: 60_000 });
  p = await caps();
  expect(p.clips.filter((c) => c.preset === 'pn-legenda')).toHaveLength(1);
  expect(p.tracks.filter((t) => t.name === 'Legendas')).toHaveLength(1);
  // não aparece na lista de manchetes
  await expect(page.getByTestId('preset-pn-legenda')).toHaveCount(0);
  expect(errors).toEqual([]);
});
