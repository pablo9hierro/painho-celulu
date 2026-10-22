import { describe, expect, it } from 'vitest';
import { cleanText, dedupeSentences, ensureFooter, fitLimit, headlineUpper, slopIssues, templateStory, unverifiedFacts, writeStory, type Chat } from './writer';
import { parseBingRss, parseGoogleRss } from './search';
import type { ArticleText } from './search';

const src: ArticleText[] = [
  { url: 'https://g1.globo.com/a', title: 'Polícia prende suspeito em Santa Rita', source: 'G1', date: null, text: 'A Polícia Militar prendeu um homem de 32 anos em Santa Rita na manhã desta terça. Segundo o tenente Carlos Souza, ele foi detido às 9h.' },
];

describe('redação da matéria', () => {
  it('confere números e nomes contra as fontes', () => {
    const t = 'PRESO EM SANTA RITA\n\nUm homem de 32 anos foi preso em Santa Rita, segundo o tenente Carlos Souza. Ele tinha 5 passagens e se chama João Pereira.\n\nFonte: G1';
    const u = unverifiedFacts(t, src);
    expect(u).toContain('5');
    expect(u).toContain('João Pereira');
    expect(u).not.toContain('32');
    expect(u).not.toContain('Carlos Souza');
  });

  it('acha vícios de texto de IA e enrolação', () => {
    expect(slopIssues('Vale ressaltar que — em meio a tudo — foi trágico!')).toEqual(expect.arrayContaining(['travessão (—)', 'ponto de exclamação', '"vale ressaltar/destacar"', '"em meio a"', '"trágico"']));
    expect(slopIssues('Recomenda-se levar guarda-chuva.')).toContain('conselho ao leitor (enrolação)');
    expect(slopIssues('A polícia prendeu o suspeito na terça.')).toEqual([]);
  });

  it('limpeza: sem travessão/exclamação, manchete em maiúsculas pelo app, sem frases repetidas', () => {
    expect(cleanText('Chuva forte — e alagamentos!')).toBe('Chuva forte, e alagamentos.');
    expect(headlineUpper('Dia nublado em João Pessoa\n\nTexto.')).toBe('DIA NUBLADO EM JOÃO PESSOA\n\nTexto.');
    expect(dedupeSentences('A umidade fica entre 65% e 90%. Vento forte.\n\nOutra coisa. A umidade fica entre 65% e 90%.')).toBe('A umidade fica entre 65% e 90%. Vento forte.\n\nOutra coisa.');
  });

  it('repõe "Fonte:" e hashtags removidos pela checagem e respeita o limite do Instagram', () => {
    const out = ensureFooter('MANCHETE\n\nCorpo.\n\nFonte: inventada', { fonte: '', tags: '#PB #Policia' }, [...src, { ...src[0]!, source: 'www.portalcorreio.com.br' }]);
    expect(out).toBe('MANCHETE\n\nCorpo.\n\nCréditos: G1 · portalcorreio\n\n#PB #Policia');
    expect(fitLimit('Frase. '.repeat(500)).length).toBeLessThanOrEqual(2200);
  });

  it('sem IA (ou IA fora do ar) monta um rascunho a partir das fontes', async () => {
    const r = await writeStory('preso santa rita', src, null);
    expect(r.text).toContain('POLÍCIA PRENDE SUSPEITO EM SANTA RITA');
    expect(r.text).toContain('Créditos: G1');
    const failing: Chat = async () => {
      throw new Error('sem rede');
    };
    const r2 = await writeStory('preso santa rita', src, failing);
    expect(r2.text).toContain('Créditos: G1');
    expect(r2.model).toBeNull();
    expect(templateStory('x', [])).toBe('');
  });

  it('pipeline com IA: escreve, checa, revisa e mantém o rodapé', async () => {
    const calls: string[] = [];
    const chat: Chat = async (m, o) => {
      const sys = m[0]!.content;
      calls.push(sys.slice(0, 20));
      if (o?.json) return { content: JSON.stringify({ problemas: ['idade 33 não está nas fontes'], legenda: 'Polícia prende homem em Santa Rita\n\nA PM prendeu um homem de 32 anos em Santa Rita.' }), model: 'google/gemini-2.5-flash-lite' };
      if (sys.startsWith('Você é revisor')) return { content: m[1]!.content, model: 'google/gemini-2.5-flash-lite' };
      return { content: 'Polícia prende homem em Santa Rita\n\nA PM prendeu um homem de 33 anos em Santa Rita.\n\nFonte: G1\n\n#SantaRita', model: 'google/gemini-2.5-flash-lite' };
    };
    const r = await writeStory('preso santa rita', src, chat);
    expect(r.text.startsWith('POLÍCIA PRENDE HOMEM EM SANTA RITA')).toBe(true);
    expect(r.text).toContain('32 anos');
    expect(r.text).not.toContain('33');
    expect(r.text).toContain('Créditos: G1');
    expect(r.text).toContain('#SantaRita');
    expect(r.unverified).toEqual([]);
  });
});

describe('busca de notícias (RSS)', () => {
  it('Google: tira o " - Veículo" do título; Bing: usa o link real do veículo', () => {
    const g = parseGoogleRss('<rss><item><title>Chuva alaga ruas - G1</title><link>https://news.google.com/rss/articles/x</link><pubDate>Mon, 19 Oct 2026 10:00:00 GMT</pubDate><source url="https://g1.globo.com">G1</source></item></rss>');
    expect(g[0]).toMatchObject({ title: 'Chuva alaga ruas', source: 'G1', readable: false });
    const b = parseBingRss('<rss><item><title>Caminh&#227;o abandonado em Ing&#225;</title><link>http://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;url=https%3a%2f%2fg1.globo.com%2fpb%2fnoticia.ghtml&amp;c=1</link><description>Carga de &lt;b&gt;cigarros&lt;/b&gt;</description><pubDate>Mon, 19 Oct 2026 10:00:00 GMT</pubDate></item></rss>');
    expect(b[0]).toMatchObject({ title: 'Caminhão abandonado em Ingá', url: 'https://g1.globo.com/pb/noticia.ghtml', readable: true, snippet: 'Carga de cigarros' });
  });
});

import { fromBold, styleCaption, toBold } from './unicodeStyle';
describe('negrito Unicode na legenda', () => {
  it('título e "Créditos:" em negrito; corpo e hashtags normais; ida e volta sem perdas', () => {
    const plain = 'POLÍCIA PRENDE SUSPEITO\n\nA PM prendeu um homem.\n\nCréditos: G1 · Correio\n\n#PB';
    const styled = styleCaption(plain);
    const lines = styled.split('\n');
    expect(lines[0]).toBe(toBold('POLÍCIA PRENDE SUSPEITO'));
    expect(lines[0]).not.toBe('POLÍCIA PRENDE SUSPEITO');
    expect(lines[2]).toBe('A PM prendeu um homem.');
    expect(lines[4]!.startsWith(toBold('Créditos:'))).toBe(true);
    expect(lines[4]!.endsWith(' G1 · Correio')).toBe(true);
    expect(lines[6]).toBe('#PB');
    expect(fromBold(styled)).toBe(plain);
  });
});

import { applyHashtags, pickHashtags } from './hashtags';
describe('5 hashtags pelo que está em alta', () => {
  it('prefere as em alta que estão no texto; ignora em alta fora do assunto; completa até 5', async () => {
    const text = 'FLAMENGO LIDERA\n\nO Flamengo tem 69% de chance de título no Brasileirão, segundo a UFMG.\n\nCréditos: ge\n\n#Futebol';
    const trending = [
      { tag: '#Flamengo', score: 100, mentions: 3 },
      { tag: '#Paulista', score: 90, mentions: 2 },
      { tag: '#Brasileirão', score: 60, mentions: 2 },
    ];
    const picks = await pickHashtags(text, [], trending, async () => 10);
    const tags = picks.map((p) => p.tag);
    expect(tags).toHaveLength(5);
    expect(tags.slice(0, 2)).toEqual(expect.arrayContaining(['#Flamengo', '#Brasileirão']));
    expect(tags).not.toContain('#Paulista');
    expect(tags).toContain('#Futebol');
    expect(picks.find((p) => p.tag === '#Flamengo')!.why).toContain('em alta agora');
    expect(applyHashtags(text, tags)).toMatch(/Créditos: ge\n\n#Flamengo/);
  });
});

import { brl, estimateUsd } from './cost';
describe('custo da IA em reais', () => {
  it('soma o custo de todas as etapas da matéria e mostra em reais', async () => {
    const chat: Chat = async (m, o) => {
      if (o?.json) return { content: JSON.stringify({ problemas: [], legenda: 'Polícia prende homem\n\nA PM prendeu um homem de 32 anos em Santa Rita.' }), model: 'x', costUsd: 0.0004 };
      if (m[0]!.content.startsWith('Você é revisor')) return { content: m[1]!.content, model: 'x', costUsd: 0.0002 };
      return { content: 'Polícia prende homem\n\nA PM prendeu um homem de 32 anos em Santa Rita.\n\n#SantaRita', model: 'x', costUsd: 0.001 };
    };
    const r = await writeStory('preso', src, chat);
    expect(r.costUsd).toBeCloseTo(0.0016, 6);
    const sp = (s: string) => s.replace(/\s/g, ' ');
    expect(sp(brl(r.costUsd, 5))).toBe('R$ 0,0080');
    expect(sp(brl(2, 5))).toBe('R$ 10,00');
    // sem custo informado: calcula pelos tokens (Flash Lite US$0,10/M entrada, US$0,40/M saída)
    expect(estimateUsd('google/gemini-2.5-flash-lite', 1_000_000, 1_000_000)).toBeCloseTo(0.5);
  });
});
