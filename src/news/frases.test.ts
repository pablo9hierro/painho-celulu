import { describe, expect, it } from 'vitest';
import { casarTempos, frases } from './frases';

describe('tempo das palavras pelo Whisper', () => {
  // a IA escreveu certo mas errou o tempo da frase em ~1 s; o Whisper ouviu errado algumas palavras mas sabe quando
  const segs = [
    { falante: 1, inicio: 0.5, fim: 2.4, texto: 'Manuel Gomes, eu queria te parabenizar.' },
    { falante: 2, inicio: 6.0, fim: 7.0, texto: 'Você ganhou nosso coração.' },
  ];
  const relogio = [
    { w: 'Mas', t: 0.0, e: 0.3 },
    { w: 'meu', t: 0.64, e: 0.78 },
    { w: 'Gomes,', t: 0.88, e: 1.06 },
    { w: 'eu', t: 1.06, e: 1.14 },
    { w: 'queria', t: 1.14, e: 1.28 },
    { w: 'te', t: 1.28, e: 1.4 },
    { w: 'parar', t: 1.4, e: 1.56 },
    { w: 'Você', t: 7.62, e: 7.98 },
    { w: 'ganhou', t: 7.98, e: 8.2 },
    { w: 'o', t: 8.2, e: 8.32 },
    { w: 'nosso', t: 8.32, e: 8.5 },
    { w: 'coração.', t: 8.5, e: 9.0 },
  ];
  it('usa o texto da IA com o tempo ouvido', () => {
    const ws = casarTempos(segs, relogio);
    expect(ws.map((w) => w.w).join(' ')).toBe('Manuel Gomes, eu queria te parabenizar. Você ganhou nosso coração.');
    const t = (w: string) => ws.find((x) => x.w === w)!.t;
    expect(t('Gomes,')).toBeCloseTo(0.88, 2);
    expect(t('queria')).toBeCloseTo(1.14, 2);
    // "parabenizar" ≈ "parar" (mesmo começo)
    expect(t('parabenizar.')).toBeCloseTo(1.4, 2);
    // a frase da IA estava 1,6 s adiantada: vale o Whisper
    expect(t('Você')).toBeCloseTo(7.62, 2);
    expect(t('coração.')).toBeCloseTo(8.5, 2);
    // "Manuel" não casou: fica logo antes de "Gomes", no ritmo da IA
    expect(t('Manuel')).toBeLessThan(0.88);
    // sempre em ordem
    for (let i = 1; i < ws.length; i++) expect(ws[i]!.t).toBeGreaterThan(ws[i - 1]!.t);
  });
  it('frase repetida no áudio: fica com a mais perto do tempo da IA', () => {
    const s = [{ falante: 1, inicio: 14.2, fim: 15.5, texto: 'Não sei se é chato.' }];
    const r = ['Não', 'sei', 'se', 'é', 'chato.'];
    const rel = [...r.map((w, i) => ({ w, t: 13.9 + i * 0.2, e: 14.05 + i * 0.2 })), ...r.map((w, i) => ({ w, t: 17.5 + i * 0.1, e: 17.6 + i * 0.1 }))];
    expect(casarTempos(s, rel)[0]!.t).toBeCloseTo(13.9, 2);
  });
  it('frases curtas, quebrando na troca de quem fala e sem deixar o "véi." para a próxima', () => {
    const fr = frases([{ falante: 1, inicio: 0, fim: 3, texto: 'Mas foi bom, véi. É melhor, né? Ser deputado é chato.' }], [], [
      { w: 'Mas', t: 0, e: 0.1 }, { w: 'foi', t: 0.1, e: 0.3 }, { w: 'bom,', t: 0.3, e: 0.6 }, { w: 'véi.', t: 0.7, e: 0.9 },
      { w: 'É', t: 0.92, e: 1 }, { w: 'melhor,', t: 1, e: 1.3 }, { w: 'né?', t: 1.4, e: 1.5 }, { w: 'Ser', t: 1.6, e: 1.7 },
      { w: 'deputado', t: 1.7, e: 2.1 }, { w: 'é', t: 2.1, e: 2.2 }, { w: 'chato.', t: 2.2, e: 2.6 },
    ]);
    expect(fr.map((f) => f.palavras.map((w) => w.w).join(' '))).toEqual(['Mas foi bom, véi.', 'É melhor, né?', 'Ser deputado é chato.']);
  });
});
