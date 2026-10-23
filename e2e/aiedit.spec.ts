import { expect, test } from '@playwright/test';
import { uniqueTestVideo } from './fixtures';

test('edição por IA: comando vira ação e corta de verdade na timeline', async ({ page }) => {
  let sent: { model?: string } | null = null;
  await page.route('https://openrouter.ai/**', async (route) => {
    sent = route.request().postDataJSON();
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ acoes: [{ tipo: 'cortar', inicio: 1, fim: 3 }] }) } }],
        usage: { cost: 0.0002 },
      }),
    });
  });
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('pn-ai-key', 'sk-or-teste'));
  await page.getByTestId('new-reel').click();
  const { file, name } = uniqueTestVideo();
  await page.getByTestId('file-input').setInputFiles(file);
  const item = page.getByTestId('media-item').filter({ hasText: name });
  await expect(item).toHaveClass(/ready/, { timeout: 60_000 });
  await item.click();
  await page.getByTestId('rail-ia').click();
  await expect(page.getByTestId('ai-edit-panel')).toBeVisible();
  await page.getByTestId('ai-edit-text').fill('corta de 1 a 3 segundos');
  await page.getByTestId('ai-edit-add').click();
  await expect(page.getByTestId('ai-edit-cmd')).toContainText('na fila');
  const before = await page.evaluate(() => (window as unknown as { __editor: { getState(): { project: { clips: { type: string; duration: number }[] } } } }).__editor.getState().project.clips.filter((c) => c.type === 'video').reduce((s, c) => s + c.duration, 0));
  await page.getByTestId('ai-edit-run').click();
  await expect(page.getByTestId('ai-edit-cmd')).toContainText('cortar 1.0s–3.0s', { timeout: 30_000 });
  expect(sent!.model).toBe('google/gemini-2.5-flash-lite');
  const after = await page.evaluate(() => (window as unknown as { __editor: { getState(): { project: { clips: { type: string; duration: number }[] } } } }).__editor.getState().project.clips.filter((c) => c.type === 'video').reduce((s, c) => s + c.duration, 0));
  expect(before - after).toBeCloseTo(2, 1);
  // o gasto com IA apareceu
  await expect(page.getByTestId('ai-spend')).toBeVisible();
});
