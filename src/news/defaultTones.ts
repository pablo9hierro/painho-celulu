/**
 * Tons que já vêm no app: 10 músicas de notícia INTEIRAS (no mesmo volume) e 17
 * trilhas em 3 tons. Cada trilha aponta para uma música e para o melhor trecho
 * dela (início marcado); o jornalista pode deslizar na faixa e escolher outro
 * trecho de 15 ou 20 s, como no Instagram. Na primeira vez as músicas entram na
 * biblioteca de mídia; o que o jornalista já cadastrou é mantido.
 */
import { media as mediaApi } from '../platform/api';
import { waitReady } from '../ui/importer';
import { loadTones, saveTones, TRECHO_S, type Tone } from './tones';

const FILES = import.meta.glob('../assets/musicas/*.m4a', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;

export const DEFAULT_TONES: { name: string; hint: string }[] = [
  { name: 'Urgente', hint: 'fato grave e recente de grande impacto: tragédia, acidente grave, morte, ataque, decisão urgente, plantão' },
  { name: 'Policial', hint: 'crime, prisão, operação policial, violência, homicídio, assalto, tráfico' },
  { name: 'Geral', hint: 'notícias do dia: cidades, serviços, economia, política, cultura, esporte' },
];

/** tom, nome (a IA escolhe pelo nome), música, início do melhor trecho (s) */
export const DEFAULT_TRACKS: [string, string, string, number][] = [
  ['Urgente', 'urgente - plantão breaking news, abertura forte', 'breaking-news-arber', 1],
  ['Urgente', 'urgente - orquestra de ação, impacto máximo', 'action-orchestral', 139.5],
  ['Urgente', 'urgente - orquestra de ação, abertura', 'action-orchestral', 0.5],
  ['Urgente', 'urgente - vinheta de notícia, clímax', 'news-opener', 66],
  ['Urgente', 'urgente - impacto chocante, batida pesada', 'musica-impactante', 24],
  ['Geral', 'geral - abertura de telejornal', 'news-intro-music4video', 0.5],
  ['Geral', 'geral - telejornal, ritmo animado', 'news-intro-music4video', 49],
  ['Geral', 'geral - vinheta de notícia, abertura', 'news-opener', 0.5],
  ['Geral', 'geral - fundo de notícia leve', 'news-sound', 12.5],
  ['Policial', 'policial - suspense sombrio, crime', 'crime-is-everywhere', 0.5],
  ['Policial', 'policial - suspense sombrio, tensão', 'crime-is-everywhere', 87],
  ['Policial', 'policial - thriller escuro, perseguição', 'dark-knight', 86.5],
  ['Policial', 'policial - thriller escuro, abertura', 'dark-knight', 0.5],
  ['Policial', 'policial - tensão crescente, clímax', 'tensions-run-high', 67.5],
  ['Policial', 'policial - tensão crescente, abertura', 'tensions-run-high', 0.5],
  ['Policial', 'policial - reportagem policial, batida forte', 'warrior-strife', 55.5],
  ['Policial', 'policial - reportagem policial, abertura', 'warrior-strife', 0.5],
];

/** nomes legíveis das músicas na biblioteca */
const SONG_NAMES: Record<string, string> = {
  'breaking-news-arber': 'Breaking News (Arber Krasniqi)',
  'action-orchestral': 'Action Orchestral',
  'news-intro-music4video': 'News Intro (Music4Video)',
  'news-opener': 'News Opener',
  'news-sound': 'News Sound',
  'musica-impactante': 'Música impactante',
  'dark-knight': 'Dark Knight (Soundridemusic)',
  'crime-is-everywhere': 'Crime is Everywhere (Soundridemusic)',
  'tensions-run-high': 'Tensions Run High (Soundridemusic)',
  'warrior-strife': 'Warrior Strife (Jingle Punks)',
};

const FLAG = 'pn-tons-padrao-v2';
let running: Promise<void> | null = null;

/** Coloca os tons padrão (uma vez por aparelho). Seguro chamar várias vezes. */
export function ensureDefaultTones(): Promise<void> {
  try {
    if (localStorage.getItem(FLAG) === 'ok') return Promise.resolve();
  } catch {
    return Promise.resolve();
  }
  running ??= (async () => {
    const tones: Tone[] = loadTones();
    const uploaded = new Map<string, string>();
    const song = async (slug: string): Promise<string | null> => {
      if (uploaded.has(slug)) return uploaded.get(slug)!;
      const url = Object.entries(FILES).find(([p]) => p.endsWith(`/${slug}.m4a`))?.[1];
      if (!url) return null;
      const blob = await (await fetch(url)).blob();
      const up = await mediaApi.upload(new File([blob], `${SONG_NAMES[slug] ?? slug}.m4a`, { type: 'audio/mp4' }));
      const m = await waitReady(up.id);
      if (m.status !== 'ready') return null;
      uploaded.set(slug, m.id);
      return m.id;
    };
    for (const def of DEFAULT_TONES) {
      let tone = tones.find((t) => t.name.trim().toLowerCase() === def.name.toLowerCase());
      if (!tone) {
        tone = { id: `padrao-${def.name.toLowerCase()}`, name: def.name, hint: def.hint, tracks: [] };
        tones.push(tone);
      } else if (!tone.hint.trim()) tone.hint = def.hint;
      for (const [tom, name, slug, inicio] of DEFAULT_TRACKS) {
        if (tom !== def.name) continue;
        const mediaId = await song(slug);
        if (!mediaId) continue;
        const track = { mediaId, name, inicio, dur: TRECHO_S };
        // versão anterior (trechos de 10 s): troca pela música inteira com o trecho marcado
        const i = tone.tracks.findIndex((k) => k.name === name);
        if (i >= 0) tone.tracks[i] = { ...track, inicio: tone.tracks[i]!.inicio ?? inicio };
        else tone.tracks.push(track);
      }
    }
    saveTones(tones);
    try {
      localStorage.setItem(FLAG, 'ok');
    } catch {
      /* sem armazenamento */
    }
  })().finally(() => {
    running = null;
  });
  return running;
}
