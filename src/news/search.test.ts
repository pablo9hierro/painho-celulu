import { describe, expect, it } from 'vitest';
import { articleFromUrl, type Http } from './search';

const page = (html: string, status = 200): Http => ({ async getText(url) { return { status, text: html, url }; } });

describe('articleFromUrl: link colado vira uma notícia pra inspirar a IA', () => {
  it('lê título, fonte e data das meta tags', async () => {
    const a = await articleFromUrl(
      'https://portal.test/n/1',
      page('<html><head><meta property="og:title" content="Prefeitura anuncia obra"><meta property="og:site_name" content="Portal Teste"><meta property="article:published_time" content="2026-10-20T10:00:00-03:00"><meta property="og:description" content="Resumo da notícia."></head></html>'),
    );
    expect(a).toMatchObject({ title: 'Prefeitura anuncia obra', source: 'Portal Teste', via: 'link', readable: true, snippet: 'Resumo da notícia.' });
    expect(a.date).toContain('2026-10-20');
  });

  it('sem og:site_name, usa o domínio; sem og:title, usa <title>', async () => {
    const a = await articleFromUrl('https://noticias.exemplo.com.br/x', page('<html><head><title>Matéria sem meta tags</title></head></html>'));
    expect(a.source).toBe('noticias.exemplo.com.br');
    expect(a.title).toBe('Matéria sem meta tags');
  });

  it('link inválido ou página que não abre dá erro claro', async () => {
    await expect(articleFromUrl('não é link', page(''))).rejects.toThrow(/inválido/);
    await expect(articleFromUrl('https://portal.test/off', page('', 404))).rejects.toThrow(/404/);
    await expect(articleFromUrl('https://portal.test/vazia', page('<html></html>'))).rejects.toThrow(/título/);
  });
});
