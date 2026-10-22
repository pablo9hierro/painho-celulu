/**
 * "Postar no site" de uma pauta, num toque: a IA escreve (com destaque e tom),
 * a capa é a foto da matéria, publica no painel e entra na FILA DO INSTAGRAM
 * (o Postador automático transforma em Reels no próximo horário de pico).
 */
import type { Pauta } from './pautas';
import type { SiteStory } from './siteWriter';
import { fetchPhoto, sitePublish, writeSite } from './postadorClient';
import { loadTones, tonesForAi } from './tones';

export interface QueueItem {
  id: string;
  criadoEm: string;
  siteId: number | null;
  pautaUrl: string;
  fonte: string;
  pautaTitulo: string;
  pautaData: string | null;
  /** texto da fonte (para a legenda do Instagram, só com fatos dela) */
  fonteTexto: string;
  cidade: string | null;
  story: Pick<SiteStory, 'titulo' | 'subtitulo' | 'minititulo' | 'categoria' | 'palavrasChave' | 'destaque' | 'tom' | 'audio' | 'paragrafos' | 'imagens'>;
}

const KEY = 'pn-fila-instagram';

export function loadQueue(): QueueItem[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]') as QueueItem[];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
export function saveQueue(q: QueueItem[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(q.slice(-50)));
  } catch {
    /* sem armazenamento */
  }
}
export function removeFromQueue(id: string) {
  saveQueue(loadQueue().filter((x) => x.id !== id));
}

/** primeira foto da matéria que realmente baixar */
export async function firstPhoto(imagens: { src: string }[], referer: string): Promise<File | null> {
  for (const im of imagens) {
    try {
      return await fetchPhoto(im.src, referer);
    } catch {
      /* próxima */
    }
  }
  return null;
}

export interface BlogResult {
  story: SiteStory;
  siteId: number | null;
  steps: string[];
  naFila: boolean;
}

/** Escreve e publica no site; põe na fila do Instagram. `onStep` mostra o andamento. */
export async function postToBlog(p: Pauta, opts: { prompt?: string; story?: SiteStory; onStep?: (m: string) => void } = {}): Promise<BlogResult> {
  const step = opts.onStep ?? (() => undefined);
  let story = opts.story;
  if (!story) {
    step('Escrevendo a matéria (fatos da fonte, destaque e tom)…');
    story = await writeSite(p, opts.prompt ?? '', tonesForAi(loadTones()));
  }
  if (!story.model && !opts.story) throw new Error('A IA não escreveu esta matéria (confira a chave da IA em Configurações).');
  step('Baixando a foto de capa…');
  const photo = await firstPhoto(story.imagens, p.url);
  step('Publicando no site…');
  const r = await sitePublish({
    titulo: story.titulo,
    subtitulo: story.subtitulo,
    minititulo: story.minititulo,
    categoria: story.categoria,
    palavrasChave: story.palavrasChave,
    html: story.html,
    foto: photo ? { data: new Uint8Array(await photo.arrayBuffer()), type: photo.type, name: photo.name } : null,
    publicar: true,
  });
  // fila do Instagram (só se tiver foto: o vídeo precisa dela)
  let naFila = false;
  if (photo) {
    const item: QueueItem = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      criadoEm: new Date().toISOString(),
      siteId: r.id,
      pautaUrl: p.url,
      fonte: p.source,
      pautaTitulo: p.title,
      pautaData: p.date,
      fonteTexto: p.blocks.filter((b) => b.type === 'p').map((b) => b.text).join('\n').slice(0, 12000),
      cidade: p.city,
      story: { titulo: story.titulo, subtitulo: story.subtitulo, minititulo: story.minititulo, categoria: story.categoria, palavrasChave: story.palavrasChave, destaque: story.destaque, tom: story.tom, audio: story.audio, paragrafos: story.paragrafos, imagens: story.imagens },
    };
    saveQueue([...loadQueue().filter((x) => x.pautaUrl !== p.url), item]);
    naFila = true;
  }
  return { story, siteId: r.id, steps: r.steps, naFila };
}
