import { describe, expect, it } from 'vitest';
import { pareceRelease, releases } from './release';

describe('release (babação)', () => {
  it('serviço da prefeitura é notícia', () => {
    expect(pareceRelease('Cemitérios de Campina Grande terão horário ampliado no Dia de Finados; veja funcionamento', 'A Prefeitura de Campina Grande promove ação...')).toBe(false);
    expect(pareceRelease('Prefeitura abre inscrições para curso gratuito de informática')).toBe(false);
    expect(pareceRelease('Trânsito na Epitácio Pessoa terá desvio a partir de segunda')).toBe(false);
  });
  it('babação é release', () => {
    expect(pareceRelease('Prefeito de Bayeux promove ação para melhorar o bem-estar dos servidores')).toBe(true);
    expect(pareceRelease('Gestão do prefeito Fulano é referência em saúde na Paraíba')).toBe(true);
    expect(pareceRelease('Câmara de Guarabira homenageia empresários com título de cidadão')).toBe(true);
  });
  it('a IA não tira notícia de serviço', async () => {
    const chat = async () => ({ content: '{"releases":["1","2"]}' });
    const r = await releases(chat as never, [
      { id: '1', titulo: 'Cemitérios de Campina Grande terão horário ampliado no Dia de Finados', texto: '' },
      { id: '2', titulo: 'Prefeito participa de café da manhã com lideranças', texto: '' },
    ]);
    expect([...r]).toEqual(['2']);
  });
});
