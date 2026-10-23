import { describe, expect, it } from 'vitest';
import { cidadeDoTitulo, ordenar, type Nota } from './igPick';
import type { SiteNews } from './websg';

const n = (id: number, title: string): SiteNews => ({ id, title, url: `https://x/${id}` });
const nota = (v: number, cidade: string | null = null): Nota => ({ nota: v, cidade, hashtag: 'x', motivo: '' });

describe('escolha do Instagram por impacto/polêmica, com preferência para a nossa região', () => {
  it('só entra matéria forte (nota ≥ 7); nada forte = nada para postar', () => {
    const list = [n(1, 'agenda'), n(2, 'crime')];
    const ns = new Map([[1, nota(3)], [2, nota(6)]]);
    expect(ordenar(list, ns, new Set())).toEqual([]);
  });

  it('forte de Guarabira/JP/Campina que ainda não saiu hoje vai na frente', () => {
    const list = [n(1, 'nacional bombástica'), n(2, 'Guarabira')];
    const ns = new Map([[1, nota(10)], [2, nota(8, 'Guarabira')]]);
    expect(ordenar(list, ns, new Set()).map((x) => x.item.id)).toEqual([2, 1]);
    // Guarabira já saiu hoje: volta a valer a força da notícia
    expect(ordenar(list, ns, new Set(['Guarabira'])).map((x) => x.item.id)).toEqual([1, 2]);
  });

  it('acha a cidade da casa no título', () => {
    expect(cidadeDoTitulo('Homem é preso em Guarabira')).toBe('Guarabira');
    expect(cidadeDoTitulo('Acidente na capital paraibana')).toBe('João Pessoa');
    expect(cidadeDoTitulo('Briga em Campina deixa feridos')).toBe('Campina Grande');
    expect(cidadeDoTitulo('Notícia de São Paulo')).toBeNull();
  });
});
