import { describe, expect, it } from 'vitest';
import { applyEditActions, buildContext, cutRange, type EditAction } from './editAi';
import { createProject, createVideoClip, createTextClip } from '../core/factory';
import { placeClip } from '../core/timeline';
import type { MediaAsset, TextClip } from '../core/model';

const video = (dur: number): MediaAsset => ({ id: 'm1', kind: 'video', name: 'v.mp4', status: 'ready', duration: dur, width: 1080, height: 1920, url: '' }) as MediaAsset;

describe('edição por IA: aplica de verdade na timeline', () => {
  it('cutRange remove o trecho de TODAS as camadas e fecha o espaço', () => {
    let p = createProject('t', 'reel');
    const v = createVideoClip(p, video(20), 0);
    v.duration = 20;
    p = placeClip(p, v);
    // manchete que cruza o corte inteiro
    const txt = createTextClip(p, 'pn-faixa', 6);
    txt.duration = 4; // 6-10
    p = placeClip(p, txt);
    p = cutRange(p, 5, 9);
    const vids = p.clips.filter((c) => c.type === 'video');
    expect(vids.reduce((s, c) => s + c.duration, 0)).toBeCloseTo(16, 1); // 20 - 4
    expect(vids.map((c) => c.start).sort((a, b) => a - b)).toEqual([0, 5]);
    const t = p.clips.find((c) => c.type === 'text')!;
    // a manchete também foi cortada (restou só 9-10 -> agora 5-6)
    expect(t.start).toBeCloseTo(5, 1);
    expect(t.duration).toBeCloseTo(1, 1);
  });

  it('buildContext lista os clipes e as falas (legendas) com tempo', () => {
    let p = createProject('t', 'reel');
    const v = createVideoClip(p, video(10), 0);
    v.duration = 10;
    p = placeClip(p, v);
    const cap = createTextClip(p, 'pn-legenda', 2) as TextClip;
    cap.duration = 1.5;
    cap.fields = { ...cap.fields, title: 'isso é golpe' };
    cap.caption = { words: [], speaker: 1, look: 'limpa' };
    p = placeClip(p, cap);
    const ctx = buildContext(p);
    expect(ctx.duration).toBeCloseTo(10, 0);
    expect(ctx.clips).toHaveLength(2);
    expect(ctx.falas).toEqual([{ inicio: 2, fim: 3.5, falante: 1, texto: 'isso é golpe' }]);
  });

  it('aplica manchete, zoom, desfoque e exclusão', () => {
    let p = createProject('t', 'reel');
    const v = createVideoClip(p, video(10), 0);
    v.duration = 10;
    p = placeClip(p, v);
    const actions: EditAction[] = [
      { tipo: 'manchete', preset: 'pn-faixa', texto: 'URGENTE', inicio: 1, duracao: 3 },
      { tipo: 'zoom', clipId: v.id, inicio: 0, duracao: 2, direcao: 'aproximar', foco: 'centro' },
      { tipo: 'desfoque', inicio: 0, duracao: 2, area: 'centro' },
    ];
    const p2 = applyEditActions(p, actions);
    const texto = p2.clips.find((c) => c.type === 'text')!;
    expect(texto.start).toBeCloseTo(1, 1);
    const vid = p2.clips.find((c) => c.id === v.id)!;
    expect(vid.type === 'video' && vid.keyframes).toHaveLength(2);
    expect(p2.clips.filter((c) => c.type === 'blur')).toHaveLength(1);
    const texto2 = applyEditActions(p2, [{ tipo: 'excluir', clipId: texto.id }]);
    expect(texto2.clips.find((c) => c.id === texto.id)).toBeUndefined();
  });

  it('ignora um clipId inventado e não quebra', () => {
    const p = createProject('t', 'reel');
    const p2 = applyEditActions(p, [{ tipo: 'velocidade', clipId: 'não-existe', fator: 2 }]);
    expect(p2).toEqual(p);
  });
});

describe('contexto para a IA: agulha e cantos', () => {
  it('leva a posição da agulha no contexto', () => {
    const p = createProject('t', 'reel');
    expect(buildContext(p, 6.37).agulha).toBeCloseTo(6.4, 1);
    expect(buildContext(p).agulha).toBe(0);
  });

  it('desfoque de canto cobre o quadrante certo (onde costuma ficar a logo de outro canal)', () => {
    let p = createProject('t', 'reel');
    const v = createVideoClip(p, video(10), 0);
    v.duration = 10;
    p = placeClip(p, v);
    const p2 = applyEditActions(p, [{ tipo: 'desfoque', inicio: 0, duracao: 3, area: 'topo-direita' }]);
    const blur = p2.clips.find((c) => c.type === 'blur')!;
    expect(blur.transform.x).toBeGreaterThan(p.width / 2); // lado direito
    expect(blur.transform.y).toBeLessThan(p.height / 2); // lado de cima
  });
});

describe('transcrição automática no contexto da IA', () => {
  it('sem legendas, usa a transcrição com início e fim de cada palavra', async () => {
    const { buildContext } = await import('./editAi');
    const p = createProject('t', 'reel');
    const ctx = buildContext(p, 0, {
      segs: [{ falante: 1, inicio: 1, fim: 3, texto: 'pessoal urgente agora' }],
      regs: [{ ini: 1, fim: 3 }],
    });
    expect(ctx.falas).toHaveLength(1);
    const w = ctx.falas[0]!.palavras!;
    expect(w.map((x) => x[0])).toEqual(['pessoal', 'urgente', 'agora']);
    expect(w[0]![1]).toBeCloseTo(1, 1);
    expect(w[2]![2]).toBeCloseTo(3, 1); // a última palavra termina no fim da frase
    for (const x of w) expect(x[2]).toBeGreaterThan(x[1]);
  });
});
