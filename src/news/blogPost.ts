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

/** até `max` fotos diferentes da matéria além da primeira (para o slide do Reels) */
export async function morePhotos(imagens: { src: string }[], referer: string, max = 4): Promise<File[]> {
  const out: File[] = [];
  const vistos = new Set<string>();
  let primeira = true;
  for (const im of imagens.slice(0, 10)) {
    if (out.length >= max) break;
    const chave = im.src.replace(/[?#].*/, '').replace(/-\d+x\d+(?=\.)/, '');
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    try {
      const f = await fetchPhoto(im.src, referer);
      if (primeira) {
        primeira = false; // a 1ª já é a capa
        continue;
      }
      if (f.size > 25_000) out.push(f);
    } catch {
      /* próxima */
    }
  }
  return out;
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
  if (!story.model && !opts.story) {
    const tem = (re: RegExp) => story!.steps.some((s) => re.test(s));
    throw new Error(
      tem(/Sem chave de IA/)
        ? 'Falta a chave da IA: coloque em ⚙ Configurações (tela inicial). Sem ela não dá para escrever a matéria.'
        : tem(/IA indisponível/)
          ? `A IA não respondeu (${story.steps.find((s) => /IA indisponível/.test(s))}).`
          : 'O portal não deixou ler o texto e não achei a mesma notícia em outro portal: sem os fatos, não dá para escrever.',
    );
  }
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
  contarPublicada();
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

const HOJE_KEY = 'pn-blog-hoje';
const diaBR = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
/** conta cada matéria publicada no site hoje (na mão ou no automático) */
function contarPublicada() {
  try {
    const c = JSON.parse(localStorage.getItem(HOJE_KEY) ?? '{}') as { dia?: string; n?: number };
    localStorage.setItem(HOJE_KEY, JSON.stringify({ dia: diaBR(), n: c.dia === diaBR() ? (c.n ?? 0) + 1 : 1 }));
  } catch {
    /* sem armazenamento */
  }
}
export function blogPublicadasHoje(): number {
  try {
    const c = JSON.parse(localStorage.getItem(HOJE_KEY) ?? '{}') as { dia?: string; n?: number };
    return c.dia === diaBR() ? (c.n ?? 0) : 0;
  } catch {
    return 0;
  }
}
