import { expect, test } from '@playwright/test';
import { uniqueTestVideo } from './fixtures';

// microfone falso do Chrome (toca um tom): testa gravar → parar → transcrever → texto editável
test.use({ launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] }, permissions: ['microphone'] });

test('microfone: só para quando eu desligo, transcreve e deixa editar o texto antes de adicionar', async ({ page }) => {
  let pedidos = 0;
  await page.route('https://openrouter.ai/**', async (route) => {
    pedidos++;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ segmentos: [{ falante: 1, inicio: 0, fim: 2, texto: 'corta do segundo um ao três' }], falantes: [] }) } }], usage: { cost: 0.0001 } }),
    });
  });
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('pn-ai-key', 'sk-or-teste'));
  await page.getByTestId('new-reel').click();
  const { file, name } = uniqueTestVideo();
  await page.getByTestId('file-input').setInputFiles(file);
  await expect(page.getByTestId('media-item').filter({ hasText: name })).toHaveClass(/ready/, { timeout: 60_000 });
  await page.getByTestId('rail-ia').click();
  const mic = page.getByTestId('mic-toggle');
  await mic.click();
  await expect(mic).toContainText('Gravando');
  // fica ligado sozinho, sem desligar em pausa
  await page.waitForTimeout(3500);
  await expect(mic).toContainText('Gravando 0:0');
  expect(pedidos).toBe(0); // não gasta IA enquanto grava
  await mic.click();
  const txt = page.getByTestId('ai-edit-text');
  await expect(txt).toHaveValue('corta do segundo um ao três', { timeout: 20_000 });
  expect(pedidos).toBe(1); // uma transcrição só, no fim
  // dá para corrigir o texto antes de adicionar
  await txt.fill('corta do segundo 1 ao 2');
  await page.getByTestId('ai-edit-add').click();
  const cmd = page.getByTestId('ai-edit-cmd-text');
  await expect(cmd).toHaveValue('corta do segundo 1 ao 2');
  // e editar de novo já na lista
  await cmd.fill('corta do segundo 1 ao 2,5');
  await expect(cmd).toHaveValue('corta do segundo 1 ao 2,5');
});
