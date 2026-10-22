import { beforeEach, describe, expect, it } from 'vitest';
import { collabUsernames, publishReel, type IgHttp } from './instagram';
import { guessTone, noteTrackUse, tonesForAi, type Tone } from './tones';
import { buildStoryProject } from '../ui/storyVideo';
import type { MediaAsset } from '../core/model';

// localStorage mínimo (os testes rodam em Node)
const mem = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};

const tones: Tone[] = [
  { id: 'p', name: 'Policial', hint: 'crime', tracks: [
    { mediaId: 'a', name: 'policial - suspense sombrio, crime', inicio: 0.5, dur: 15 },
    { mediaId: 'b', name: 'policial - reportagem policial, batida forte', inicio: 55.5, dur: 15 },
  ] },
];

describe('música do post e collab', () => {
  beforeEach(() => mem.clear());

  it('varia a música: as últimas usadas saem da lista da IA (se houver outra)', () => {
    expect(tonesForAi(tones)[0]!.audios).toHaveLength(2);
    noteTrackUse('policial - suspense sombrio, crime');
    expect(tonesForAi(tones)[0]!.audios).toEqual(['policial - reportagem policial, batida forte']);
    noteTrackUse('policial - reportagem policial, batida forte');
    expect(tonesForAi(tones)[0]!.audios).toHaveLength(2); // todas usadas: volta a lista inteira
    mem.clear();
    noteTrackUse('policial - suspense sombrio, crime');
    expect(guessTone(tones, 'suspeito preso em operação')!.track.mediaId).toBe('b');
  });

  it('o post usa o trecho escolhido da música e dura o tamanho do trecho', () => {
    const song = { id: 's', kind: 'audio', name: 'Dark Knight', status: 'ready', duration: 150, width: 0, height: 0, url: '' } as unknown as MediaAsset;
    const p = buildStoryProject({ kicker: 'Polícia', title: 'Teste', subtitle: '', audioStart: 86.5, audioDur: 20 }, null, song);
    const a = p.clips.find((c) => c.type === 'audio')!;
    expect(a.type === 'audio' && a.sourceIn).toBe(86.5);
    expect(a.duration).toBe(20);
    expect(p.clips.find((c) => c.type === 'text')!.duration).toBe(20);
    // trecho perto do fim da música: recua para caber
    const q = buildStoryProject({ kicker: 'x', title: 'y', subtitle: '', audioStart: 145, audioDur: 15 }, null, song);
    const b = q.clips.find((c) => c.type === 'audio')!;
    expect(b.type === 'audio' && b.sourceIn).toBe(135);
    expect(b.duration).toBe(15);
  });

  it('convida para collab e, se o Instagram recusar o convite, posta sem ele', async () => {
    expect(collabUsernames('@portalnewsjampa, @PortalNewsJampa x y z')).toEqual(['portalnewsjampa', 'x', 'y']);
    const sent: Record<string, string>[] = [];
    const mk = (refuse: boolean): IgHttp => ({
      async post(url, body) {
        sent.push(body as Record<string, string>);
        if (url.endsWith('/media') && refuse && (body as Record<string, string>).collaborators) return { error: { code: 100, message: 'Invalid collaborator' } };
        if (url.endsWith('/media')) return { id: 'c1', uri: 'https://rupload' };
        return { id: 'reel1' };
      },
      async get() {
        return { status_code: 'FINISHED' };
      },
      async upload() {
        return { success: true };
      },
    }) as IgHttp;
    const ok = await publishReel(mk(false), { userId: '1', token: 'EAA' }, new Uint8Array(10), 'oi', { collaborators: ['portalnewsjampa'] });
    expect(sent[0]!.collaborators).toBe('["portalnewsjampa"]');
    expect(ok.collab).toEqual(['portalnewsjampa']);
    sent.length = 0;
    const no = await publishReel(mk(true), { userId: '1', token: 'EAA' }, new Uint8Array(10), 'oi', { collaborators: ['portalnewsjampa'] });
    expect(no.id).toBe('reel1');
    expect(no.collab).toEqual([]);
    expect(sent.filter((b) => b.media_type === 'REELS').at(-1)!.collaborators).toBeUndefined();
  }, 60_000);
});
