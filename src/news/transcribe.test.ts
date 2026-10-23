import { describe, expect, it } from 'vitest';
import { parseTranscricao, splitSegments, transcribeWav, wordTimes } from './transcribe';
import { applyCaptions, buildCaptionClips, CAPTION_PRESET } from '../ui/captions';
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

  it('cria itens válidos numa trilha "Legendas" e gerar de novo substitui', () => {
    const p = createProject('t', 'reel');
    const segs = [
      { falante: 1, inicio: 0, fim: 2.4, texto: 'Bom dia, aqui é o Primeiras Notícias.' },
      { falante: 2, inicio: 3, fim: 5, texto: 'Obrigado pelo convite.' },
    ];
    const clips = buildCaptionClips(p, segs, 'destaque', false);
    expect(clips).toHaveLength(2);
    for (const c of clips) expect(TextClipSchema.safeParse(c).success).toBe(true);
    expect(clips[1]!.caption).toMatchObject({ speaker: 2, look: 'destaque' });
    let next = applyCaptions(p, clips);
    next = applyCaptions(next, buildCaptionClips(next, segs.slice(0, 1), 'caixa', true));
    const caps = next.clips.filter((c) => c.type === 'text' && c.preset === CAPTION_PRESET);
    expect(caps).toHaveLength(1);
    expect(next.tracks.filter((t) => t.name === 'Legendas')).toHaveLength(1);
    expect(next.tracks.find((t) => t.id === caps[0]!.trackId)!.name).toBe('Legendas');
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
