import { describe, expect, it } from 'vitest';
import { markKeyword, singleHighlight } from './edicao';

describe('post em vídeo: destaque de UMA palavra-chave', () => {
  it('marca só a primeira palavra-chave que aparece no título (sem ligar para acento/maiúscula)', () => {
    expect(markKeyword('Entenda por que Bolsonaro não poderá votar nas eleições de 2026', ['eleicoes', 'Bolsonaro'])).toBe(
      'Entenda por que Bolsonaro não poderá votar nas *eleições* de 2026',
    );
    expect(markKeyword('Polícia prende suspeito em João Pessoa', ['joão pessoa'])).toBe('Polícia prende suspeito em *João Pessoa*');
  });

  it('não marca pedaço de palavra nem palavra-chave ausente', () => {
    expect(markKeyword('Chuva forte em Bayeux', ['bay', 'Cabedelo'])).toBe('Chuva forte em Bayeux');
  });

  it('com vários destaques, mantém só o primeiro', () => {
    expect(singleHighlight('*Um* dois *três* quatro *cinco*')).toBe('*Um* dois três quatro cinco');
  });
});
