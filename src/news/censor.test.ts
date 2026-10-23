import { describe, expect, it } from 'vitest';
import { censorCaption, disguiseWord } from './censor';

describe('disfarce de palavras sensíveis na legenda do Instagram', () => {
  it('troca as vogais por números (a→4, e→3, i→1, o→0), mantendo a 1ª letra', () => {
    expect(disguiseWord('homicídio')).toBe('h0m1c1d10');
    expect(disguiseWord('Morte')).toBe('M0rt3');
    expect(disguiseWord('assassinato')).toBe('ass4ss1n4t0');
  });

  it('só nas palavras sensíveis, sem estragar as outras', () => {
    const t = censorCaption('Jovem é morta a tiros; suspeito do homicídio foi esfaqueado. Mortadela não muda. Matemática também não.');
    expect(t).toContain('m0rt4');
    expect(t).toContain('t1r0s');
    expect(t).toContain('h0m1c1d10');
    expect(t).toContain('esf4qu34d0');
    expect(t).toContain('Mortadela');
    expect(t).toContain('Matemática');
  });
});
