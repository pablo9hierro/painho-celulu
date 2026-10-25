import { describe, expect, it } from 'vitest';
import { parseTranscricao, splitSegments, transcribeWav, wordTimes } from './transcribe';
import { applyCaptions, CAPTION_PRESET } from '../ui/captions';
import { createProject } from '../core/factory';
import { TextClipSchema } from '../core/model';

describe('legendas automáticas', () => {
  it('lê o JSON da IA, separa falantes e corrige tempos fora de ordem', () => {
    const raw = 'ok ```json {"segmentos":[{"falante":1,"inicio":0,"fim":2,"texto":"Bom dia"},{"falante":2,"inicio":1.5,"fim":1,"texto":" Obrigado  pelo convite "},{"falante":1,"inicio":3,"fim":4,"texto":""}],"falantes":[{"id":1,"voz":"mulher"},{"id":2,"voz":"homem"}]} ```';
    const r = parseTranscricao(raw, 10);
    expect(r.segmentos).toHaveLength(2);
    expect(r.segmentos[1]).toMatchObject({ falante: 2, inicio: 2, texto: 'Obrigado pelo convite' });
    expect(r.segmentos[1]!.fim).toBeGreaterThan(2);
    expect(r.falantes.map((f) => f.id)).toEqual([1, 2]);
    expect(parseTranscricao('sem json', 5).segmentos).toEqual([]);
  });

  it('tempo por palavra é crescente e cabe na frase; frases longas viram pedaços', () => {
    const w = wordTimes('A situação na avenida está complicada', 3);
    expect(w).toHaveLength(6);
    expect(w[0]!.t).toBe(0);
    for (let i = 1; i < w.length; i++) expect(w[i]!.t).toBeGreaterThan(w[i - 1]!.t);
    expect(w.at(-1)!.t).toBeLessThan(3);
    const parts = splitSegments([{ falante: 2, inicio: 10, fim: 16, texto: 'um dois três quatro cinco seis sete oito nove dez onze doze' }]);
    expect(parts.length).toBe(2);
    expect(parts[0]!.inicio).toBe(10);
    expect(parts.at(-1)!.fim).toBe(16);
    expect(parts.every((p) => p.falante === 2 && p.texto.split(' ').length <= 7)).toBe(true);
  });

  it('um bloco de legenda por trecho de vídeo, agrupado com ele; gerar de novo substitui', async () => {
    const { buildCaptionBlocks, frases, blocosDeFala } = await import('../ui/captions');
    const { createVideoClip } = await import('../core/factory');
    const { placeClip } = await import('../core/timeline');
    let p = createProject('t', 'reel');
    const v = createVideoClip(p, { id: 'm', kind: 'video', name: 'v', status: 'ready', duration: 10, width: 1080, height: 1920, url: '', hasAudio: true } as never, 0);
    v.duration = 10;
    p = placeClip(p, v);
    const segs = [
      { falante: 1, inicio: 0.5, fim: 2.4, texto: 'Bom dia, aqui é o Primeiras Notícias.' },
      { falante: 2, inicio: 3, fim: 5, texto: 'Obrigado pelo convite.' },
    ];
    const blocos = blocosDeFala(p);
    expect(blocos.map((x) => x.id)).toEqual([v.id]);
    const { clips, grupos } = buildCaptionBlocks(p, frases(segs, []), blocos, 'destaque', false);
    expect(clips).toHaveLength(1); // um bloco só, não um item por frase
    const c = clips[0]!;
    expect(TextClipSchema.safeParse(c).success).toBe(true);
    expect(c.start).toBe(0);
    expect(c.duration).toBe(10); // do tamanho do vídeo
    expect(c.group).toBe(grupos.get(v.id));
    expect(new Set(c.caption!.words.map((w) => w.s)).size).toBeGreaterThanOrEqual(2); // as frases ficam dentro
    expect(c.caption!.words.find((w) => w.w === 'Obrigado')!.sp).toBe(2);
    let next = applyCaptions(p, clips, grupos, true);
    expect(next.clips.find((x) => x.id === v.id)!.group).toBe(c.group); // vídeo agrupado com a legenda
    const outro = buildCaptionBlocks(next, frases(segs.slice(0, 1), []), blocosDeFala(next), 'caixa', true);
    next = applyCaptions(next, outro.clips, outro.grupos, true);
    const caps = next.clips.filter((x) => x.type === 'text' && x.preset === CAPTION_PRESET);
    expect(caps).toHaveLength(1);
    expect(next.tracks.filter((tr) => tr.name === 'Legendas')).toHaveLength(1);
  });

  it('na tela aparece só a frase da hora (um instante antes da fala) e o ajuste de sincronia vale', async () => {
    const { phraseAt } = await import('../render/captions');
    const c = {
      duration: 10,
      fields: { kicker: '', title: 'bom dia gente\nobrigado pelo convite', subtitle: '' },
      caption: { speaker: 1, look: 'limpa', words: [
        { w: 'bom', t: 1, e: 1.3, s: 0 }, { w: 'dia', t: 1.3, e: 1.6, s: 0 }, { w: 'gente', t: 1.6, e: 2, s: 0 },
        { w: 'obrigado', t: 4, e: 4.5, s: 1, sp: 2 }, { w: 'pelo', t: 4.5, e: 4.7, s: 1, sp: 2 }, { w: 'convite', t: 4.7, e: 5.2, s: 1, sp: 2 },
      ] },
    } as never;
    expect(phraseAt(c, 0.5)).toBeNull(); // antes de falar
    expect(phraseAt(c, 0.92)!.words[0]!.w).toBe('bom'); // aparece um tiquinho antes
    expect(phraseAt(c, 3)).toBeNull(); // pausa entre as frases
    const p2 = phraseAt(c, 4.6)!;
    expect(p2.words.map((w) => w.w)).toEqual(['obrigado', 'pelo', 'convite']);
    expect(p2.speaker).toBe(2);
    // atrasar 0,5 s: em 1,3 s ainda não apareceu
    const atrasada = { ...(c as object), caption: { ...(c as { caption: object }).caption, offset: 0.5 } } as never;
    expect(phraseAt(atrasada, 1.3)).toBeNull();
    // corrigiu um erro de digitação na linha (mesmo número de palavras): mantém o tempo
    const corrigida = { ...(c as object), fields: { kicker: '', title: 'bom dia, gente\nobrigado pelo convite', subtitle: '' } } as never;
    expect(phraseAt(corrigida, 1.4)!.words[1]!.w).toBe('dia,');
  });

  it('manda o áudio como input_audio na OpenRouter e soma o custo', async () => {
    let body: { model?: string; messages?: { content: { type: string; input_audio?: { format: string } }[] }[] } = {};
    const r = await transcribeWav('sk-or-teste', 'UklGRg==', 4, [{ id: 1, voz: 'mulher' }], async (_u, _h, b) => {
      body = b as typeof body;
      return { status: 200, json: { choices: [{ message: { content: '{"segmentos":[{"falante":1,"inicio":0,"fim":1.5,"texto":"Olá"}],"falantes":[]}' } }], usage: { cost: 0.0002 } } };
    });
    expect(body.model).toBe('google/gemini-2.5-flash-lite');
    expect(body.messages![0]!.content[1]).toMatchObject({ type: 'input_audio', input_audio: { format: 'wav' } });
    expect(JSON.stringify(body)).toContain('1 = mulher');
    expect(r.segmentos[0]!.texto).toBe('Olá');
    expect(r.costUsd).toBe(0.0002);
  });
});

describe('sincronia pela voz', () => {
  it('acha os trechos de voz e encosta cada frase no seu trecho (IA atrasada)', async () => {
    const { speechRegions, alignSegments } = await import('./transcribe');
    const rate = 16000;
    const pcm = new Float32Array(rate * 10);
    // voz em 0.5-1.4 s, 2.0-4.0 s e 5.0-8.0 s
    for (const [a, b] of [[0.5, 1.4], [2, 4], [5, 8]] as const) for (let i = a * rate; i < b * rate; i++) pcm[i] = 0.3 * Math.sin(i / 7);
    const regs = speechRegions(pcm, rate);
    expect(regs).toHaveLength(3);
    expect(regs[0]!.ini).toBeCloseTo(0.5, 1);
    expect(regs[2]!.fim).toBeCloseTo(8, 1);
    const al = alignSegments(
      [
        { falante: 1, inicio: 0.4, fim: 2.6, texto: 'Bom dia.' },
        { falante: 1, inicio: 2.6, fim: 4.9, texto: 'Aqui é o Primeiras Notícias.' },
        { falante: 2, inicio: 5.9, fim: 9.0, texto: 'Hoje vamos falar sobre o trânsito em João Pessoa.' },
      ],
      regs,
    );
    const r2 = (x: number) => Math.round(x * 100) / 100;
    expect(al.map((s) => [s.inicio, s.fim])).toEqual(regs.map((r) => [r2(r.ini), r2(r.fim)]));
  });
});
