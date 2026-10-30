import { describe, expect, it } from 'vitest';
import { buildStoryProject } from './storyVideo';
import { coverWindow, getFrame } from '../core/frames';
import type { MediaAsset } from '../core/model';

const asset = (id: string, kind: 'image' | 'video', w: number, h: number, duration = 0) => ({ id, kind, name: id, status: 'ready', duration, width: w, height: h, url: '' }) as unknown as MediaAsset;
const base = { kicker: 'Polícia', title: 'Teste', subtitle: '' };

describe('post em vídeo da matéria', () => {
  it('vídeo: aproxima no centro e, se for longo, usa 3 trechos do meio', () => {
    const v = asset('v', 'video', 1280, 720, 60);
    const p = buildStoryProject({ ...base, duration: 15 }, v, null);
    const vids = p.clips.filter((c) => c.type === 'video') as Extract<(typeof p.clips)[number], { type: 'video' }>[];
    expect(vids).toHaveLength(3);
    const cobre = coverWindow(getFrame('central'), p.width, p.height, 1280 / 720);
    expect(vids[0]!.transform.width).toBeGreaterThan(cobre.width * 1.15);
    // pula o começo (vinheta) e não passa do fim; um trecho atrás do outro
    expect(vids[0]!.sourceIn).toBeGreaterThan(3);
    expect(vids[2]!.sourceIn + vids[2]!.duration).toBeLessThanOrEqual(60);
    expect(vids[1]!.start).toBeCloseTo(vids[0]!.start + vids[0]!.duration, 5);
    // vídeo em pé também vai no centro (sem a versão "inteira" com as bordas)
    const q = buildStoryProject({ ...base, duration: 15 }, asset('w', 'video', 720, 1280, 10), null);
    expect(q.clips.filter((c) => c.type === 'video')).toHaveLength(1);
  });
  it('várias fotos: slide, uma atrás da outra com transição', () => {
    const fotos = [1, 2, 3, 4].map((i) => asset(`f${i}`, 'image', 1600, 1000));
    const p = buildStoryProject({ ...base, duration: 15 }, asset('capa', 'image', 1600, 1000), null, fotos);
    const imgs = p.clips.filter((c) => c.type === 'image').sort((a, b) => a.start - b.start);
    expect(imgs).toHaveLength(5);
    for (let i = 1; i < imgs.length; i++) {
      expect(imgs[i]!.animIn?.type).toBe('fade');
      // entra antes da anterior sair (transição cruzada)
      expect(imgs[i]!.start).toBeLessThan(imgs[i - 1]!.start + imgs[i - 1]!.duration);
    }
    // post curto: menos fotos, cada uma com tempo para ser vista
    const curto = buildStoryProject({ ...base, duration: 6 }, asset('capa', 'image', 1600, 1000), null, fotos);
    expect(curto.clips.filter((c) => c.type === 'image')).toHaveLength(2);
  });
});
