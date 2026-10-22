import { describe, expect, it } from 'vitest';
import { extractBlocks, sameStory, scorePauta, isPortuguese, looksStale, mentionsBlockedCity, CITIES } from './pautas';

describe('captura de pautas', () => {
  it('lê a matéria na ordem: parágrafo, imagem (com legenda), parágrafo, vídeo; ignora lixo', () => {
    const html = `<html><head><meta property="og:image" content="https://site.com/capa.jpg"></head><body>
      <header><img src="/logo.png"></header>
      <article>
        <p>A Polícia Militar prendeu um suspeito na manhã desta terça-feira no bairro do Cristo.</p>
        <figure><img data-src="/fotos/prisao.jpg" width="800"><figcaption>Suspeito foi levado à delegacia</figcaption></figure>
        <p>Segundo a corporação, o homem tinha um mandado de prisão em aberto por roubo.</p>
        <p>Receba as notícias no seu WhatsApp, clique aqui e participe do grupo agora.</p>
        <iframe src="https://www.youtube.com/embed/abc123"></iframe>
        <img src="https://site.com/pixel.gif" width="1">
      </article></body></html>`;
    const r = extractBlocks(html, 'https://site.com/noticia');
    expect(r.blocks.map((b) => b.type)).toEqual(['p', 'img', 'p', 'video']);
    expect(r.blocks[1]).toMatchObject({ src: 'https://site.com/fotos/prisao.jpg', caption: 'Suspeito foi levado à delegacia' });
    expect(r.blocks[3]).toMatchObject({ kind: 'youtube' });
    expect(r.ogImage).toBe('https://site.com/capa.jpg');
  });

  it('mesma história em veículos diferentes é agrupada', () => {
    expect(sameStory('Ato pró-Lula reúne apoiadores no Ponto de Cem Réis, em João Pessoa', 'Apoiadores realizam ato pró-Lula no Ponto de Cem Réis em João Pessoa')).toBe(true);
    expect(sameStory('Ato pró-Lula reúne apoiadores em João Pessoa', 'Chuva forte alaga ruas de Campina Grande')).toBe(false);
  });

  it('ranking: imagem baixável e mais conteúdo valem mais; sem texto perde pontos', () => {
    const base = { id: '1', title: 't', url: 'u', source: 's', date: new Date().toISOString(), snippet: '', city: null, blocks: [], videos: 0, coverage: 1, trendHits: [], readable: true };
    const rica = scorePauta({ ...base, paragraphs: 10, images: 3, imagesOk: 3 });
    const semImagemBaixavel = scorePauta({ ...base, paragraphs: 10, images: 3, imagesOk: 0 });
    const pobre = scorePauta({ ...base, paragraphs: 1, images: 0, imagesOk: 0, readable: false });
    expect(rica.score).toBeGreaterThan(semImagemBaixavel.score);
    expect(semImagemBaixavel.score).toBeGreaterThan(pobre.score);
    expect(rica.reasons.join(' ')).toContain('imagem(ns) que dá para baixar');
    const local = scorePauta({ ...base, paragraphs: 10, images: 3, imagesOk: 3, city: 'Cabedelo' });
    expect(local.score - rica.score).toBe(25);
  });
});

describe('regras de captura', () => {
  it('só notícia em português (corta homônimo de fora)', () => {
    expect(isPortuguese('Residents of 1066 Country lose battle for Bayeux tapestry tickets')).toBe(false);
    expect(isPortuguese('Golfinho é encontrado morto com ferimento em praia de Cabedelo')).toBe(true);
    expect(isPortuguese('Polícia prende suspeito em Bayeux')).toBe(true);
  });
});

describe('matéria antiga republicada', () => {
  const now = new Date('2026-10-22T03:00:00Z');
  it('só anos passados = antiga; com o ano atual ou sem ano = atual', () => {
    expect(looksStale('Senador participou de evento em Brasília em julho de 2020, em meio à pandemia', now)).toBe(true);
    expect(looksStale('Polícia prende suspeito nesta terça em João Pessoa', now)).toBe(false);
    expect(looksStale('Caso de 2019 volta à Justiça em outubro de 2026', now)).toBe(false);
  });
});

describe('trecho destacado escolhido pela IA', () => {
  it('aceita só se estiver no título (até 5 palavras); senão, palavra-chave', async () => {
    const { pickHighlight } = await import('./siteWriter');
    expect(pickHighlight('Bolsonaro não poderá votar no segundo turno', 'não poderá votar', [])).toBe('não poderá votar');
    expect(pickHighlight('Bolsonaro não poderá votar no segundo turno', 'trecho que não existe', ['Bolsonaro'])).toBe('Bolsonaro');
    expect(pickHighlight('Polícia prende suspeitos em Bayeux', 'prende suspeitos', [])).toBe('prende suspeitos');
  });
});

describe('cidades bloqueadas', () => {
  it('Cabedelo e Santa Rita nunca entram (nem com acento/maiúscula)', () => {
    expect(CITIES).not.toContain('Cabedelo');
    expect(mentionsBlockedCity('Golfinho é encontrado morto em praia de CABEDELO')).toBe(true);
    expect(mentionsBlockedCity('Polícia prende suspeito em Santa Rita')).toBe(true);
    expect(mentionsBlockedCity('Operação em Bayeux prende dois')).toBe(false);
  });
});
