/**
 * Tons que já vêm no app: 10 músicas de notícia INTEIRAS (no mesmo volume) e 17
 * trilhas em 3 tons. Cada trilha aponta para uma música e para o melhor trecho
 * dela (início marcado); o jornalista pode deslizar na faixa e escolher outro
 * trecho de 15 ou 20 s, como no Instagram.
 *
 * A lista aparece NA HORA (sem copiar nada): a trilha guarda "pn-musica:<nome>".
 * A música só entra na biblioteca de mídia quando um vídeo for usá-la
 * (ensureTrackMedia), uma vez por aparelho.
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

const PREFIX = 'pn-musica:';
export const isBundled = (id: string) => id.startsWith(PREFIX);
const slugOf = (id: string) => id.slice(PREFIX.length);
/** endereço da música que vem no app */
export function bundledUrl(id: string): string | null {
  const slug = slugOf(id);
  return Object.entries(FILES).find(([p]) => p.endsWith(`/${slug}.m4a`))?.[1] ?? null;
}

/** música tocável (vem no app ou da biblioteca) */
export async function trackUrl(id: string): Promise<string> {
  if (isBundled(id)) {
    const u = bundledUrl(id);
    if (!u) throw new Error('Música não encontrada no app.');
    return u;
  }
  return (await mediaApi.get(id)).url;
}

const IMPORTED = 'pn-musicas-importadas';
function imported(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(IMPORTED) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}
const importing = new Map<string, Promise<string>>();

/**
 * Id na biblioteca de mídia para usar no vídeo. Música do app: importa uma vez
 * (e de novo se tiver sido apagada da biblioteca). Erro se não der: o post NÃO
 * sai sem música.
 */
export async function ensureTrackMedia(id: string): Promise<string> {
  if (!isBundled(id)) return id;
  const slug = slugOf(id);
  const known = imported()[slug];
  if (known) {
    try {
      const m = await mediaApi.get(known);
      if (m.status === 'ready') return known;
    } catch {
      /* apagada: importa de novo */
    }
  }
  let p = importing.get(slug);
  if (!p) {
    p = (async () => {
      const url = bundledUrl(id);
      if (!url) throw new Error(`Música "${slug}" não está no app.`);
      const blob = await (await fetch(url)).blob();
      if (!blob.size) throw new Error(`Música "${slug}" veio vazia.`);
      const up = await mediaApi.upload(new File([blob], `${SONG_NAMES[slug] ?? slug}.m4a`, { type: 'audio/mp4' }));
      const m = await waitReady(up.id);
      if (m.status !== 'ready') throw new Error(m.error ?? `Não foi possível preparar a música "${slug}".`);
      try {
        localStorage.setItem(IMPORTED, JSON.stringify({ ...imported(), [slug]: m.id }));
      } catch {
        /* sem armazenamento */
      }
      return m.id;
    })().finally(() => importing.delete(slug));
    importing.set(slug, p);
  }
  return p;
}

const FLAG = 'pn-tons-padrao-v3';

/**
 * Coloca os tons padrão NA HORA (sem copiar arquivos). O que o jornalista já
 * cadastrou é mantido; trilhas padrão antigas são trocadas pelas novas.
 */
export function ensureDefaultTones(): Promise<void> {
  try {
    if (localStorage.getItem(FLAG) === 'ok' && loadTones().some((t) => t.tracks.length)) return Promise.resolve();
  } catch {
    return Promise.resolve();
  }
  const tones: Tone[] = loadTones();
  for (const def of DEFAULT_TONES) {
    let tone = tones.find((t) => t.name.trim().toLowerCase() === def.name.toLowerCase());
    if (!tone) {
      tone = { id: `padrao-${def.name.toLowerCase()}`, name: def.name, hint: def.hint, tracks: [] };
      tones.push(tone);
    } else if (!tone.hint.trim()) tone.hint = def.hint;
    for (const [tom, name, slug, inicio] of DEFAULT_TRACKS) {
      if (tom !== def.name) continue;
      const i = tone.tracks.findIndex((k) => k.name === name);
      const old = i >= 0 ? tone.tracks[i]! : null;
      const track = { mediaId: `${PREFIX}${slug}`, name, inicio: old && isBundled(old.mediaId) ? (old.inicio ?? inicio) : inicio, dur: old?.dur ?? TRECHO_S };
      if (i >= 0) tone.tracks[i] = track;
      else tone.tracks.push(track);
    }
  }
  saveTones(tones);
  try {
    localStorage.setItem(FLAG, 'ok');
  } catch {
    /* sem armazenamento */
  }
  return Promise.resolve();
}
