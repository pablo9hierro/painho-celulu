import { describe, expect, it } from 'vitest';
import { fitNoEllipsis, videoTexts, VIDEO_SUB_MAX, VIDEO_TITLE_MAX } from './videoTexts';
import { hasAacAudio } from './autopostApp';

const SUB = 'Uma discussão por causa de uma dívida financeira terminou em homicídio na noite de segunda-feira (19), no pátio de uma loja de conveniência de um posto de combustíveis.';
const TIT = 'Dívida acaba em morte após cadeirada e ataque com golpes de faca em mesa de bar: IMAGEM FORTÍSSIMA';

describe('textos do post em vídeo', () => {
  it('corta sem reticências e sem terminar em palavra solta', () => {
    const s = fitNoEllipsis(SUB, VIDEO_SUB_MAX);
    expect(s.length).toBeLessThanOrEqual(VIDEO_SUB_MAX);
    expect(s).not.toMatch(/\.\.\.|…/);
    expect(s).not.toMatch(/\s(de|da|do|e|em|no|na|um|uma)$/i);
    expect(fitNoEllipsis('Frase curta.', 50)).toBe('Frase curta.');
    expect(fitNoEllipsis('Texto do site cortado...', 100)).toBe('Texto do site cortado');
  });

  it('IA resume título e subtítulo; se ela exagerar no tamanho, ainda cabe', async () => {
    let asked = '';
    const chat = async (msgs: { content: string }[]) => {
      asked = msgs.map((m) => m.content).join('\n');
      return { content: JSON.stringify({ titulo: 'Dívida termina em morte em mesa de bar', subtitulo: 'Homem foi atacado com cadeira e faca em posto de combustíveis na segunda-feira (19).', destaque: 'termina em morte', tom: 'Policial', audio: 'x' }), model: 't' };
    };
    const r = await videoTexts(chat as never, { titulo: TIT, subtitulo: SUB, texto: SUB, palavras: [] });
    expect(r.titulo).toBe('Dívida termina em morte em mesa de bar');
    expect(r.destaque).toBe('termina em morte');
    expect(r.tom).toBe('Policial');
    expect(asked).toContain(`no máximo ${VIDEO_TITLE_MAX}`);
    const longo = async () => ({ content: JSON.stringify({ titulo: TIT, subtitulo: SUB + ' ' + SUB }), model: 't' });
    const r2 = await videoTexts(longo as never, { titulo: TIT, subtitulo: SUB, texto: SUB, palavras: [] });
    expect(r2.titulo.length).toBeLessThanOrEqual(VIDEO_TITLE_MAX);
    expect(r2.subtitulo.length).toBeLessThanOrEqual(VIDEO_SUB_MAX);
    // sem IA: corta direito
    const r3 = await videoTexts(null, { titulo: TIT, subtitulo: SUB, texto: SUB, palavras: [] });
    expect(r3.titulo.length).toBeLessThanOrEqual(VIDEO_TITLE_MAX);
    expect(r3.subtitulo).not.toMatch(/\.\.\.|…/);
  });

  it('confere a faixa AAC no MP4 (nunca posta mudo)', () => {
    const enc = new TextEncoder();
    expect(hasAacAudio(enc.encode('....moov....trak..stsd..mp4a..esds'))).toBe(true);
    expect(hasAacAudio(enc.encode('....moov....trak..stsd..avc1....'))).toBe(false);
  });
});

describe('matéria sem repetição', () => {
  it('acha o parágrafo que só repete o anterior com outras palavras', async () => {
    const { repeatedParagraphs } = await import('./writer');
    expect(
      repeatedParagraphs([
        'Um policial militar salvou um homem que caiu do terceiro andar de um prédio no bairro Manaíra, em João Pessoa.',
        'O homem caiu do prédio no bairro Manaíra e foi salvo pelo policial militar em João Pessoa.',
        'Segundo a PM, o sargento Carlos Lima segurou a vítima pelo braço às 14h e chamou o Samu.',
      ]),
    ).toEqual([1]);
    expect(repeatedParagraphs(['Fato principal com detalhes únicos aqui.', 'Outro dado totalmente diferente sobre horário e local.'])).toEqual([]);
  });
});
