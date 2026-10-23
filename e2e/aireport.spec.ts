import { expect, test } from '@playwright/test';

test('relatório de IA: mostra o total, por função e por dia/semana', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    const now = Date.now();
    const log = [
      { at: new Date(now - 2 * 86_400_000).toISOString(), usd: 0.001, what: 'texto' },
      { at: new Date(now - 1 * 86_400_000).toISOString(), usd: 0.002, what: 'legendas' },
      { at: new Date(now).toISOString(), usd: 0.0005, what: 'post em vídeo' },
    ];
    localStorage.setItem('pn-ai-spend-log', JSON.stringify(log));
    localStorage.setItem('pn-ai-spend', JSON.stringify({ usd: 0.0035, uses: 3, by: { texto: 0.001, legendas: 0.002, 'post em vídeo': 0.0005 } }));
  });
  await page.getByTestId('open-settings').click();
  await page.getByTestId('open-ai-report').click();
  await expect(page.getByTestId('ai-report-dialog')).toBeVisible();
  await expect(page.getByTestId('ai-report-total')).toContainText('R$');
  await expect(page.getByTestId('ai-report-funcao')).toHaveCount(3);
  await expect(page.getByTestId('ai-report-recentes')).toContainText('Escrever matéria');
  await page.getByTestId('ai-report-semana').click();
  await expect(page.getByTestId('ai-report-periodo')).toBeVisible();
  await page.evaluate(() => ['pn-ai-spend-log', 'pn-ai-spend'].forEach((k) => localStorage.removeItem(k)));
});
