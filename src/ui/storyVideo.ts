/**
 * Matéria → post em vídeo, sempre no MESMO padrão (serve para qualquer foto):
 * - moldura "Vídeo central" da marca (logo no cabeçalho, logo andando no fundo);
 * - a foto da notícia na janela do meio (larga, ~1,4:1: quase toda foto de
 *   notícia cabe com pouco corte), com aproximação lenta; foto em pé ou
 *   panorâmica fica inteira, sobre ela mesma desfocada;
 * - a placa "Edição" logo abaixo da janela, sem cobrir a foto, com UM trecho
 *   destacado (o que a IA escolheu ao escrever a matéria);
 * - a trilha do tom da matéria, se houver.
 * O app abre o projeto no editor; a automação renderiza o mesmo projeto.
 */
import type { FormatId, MediaAsset, Project } from '../core/model';
import { createAudioClip, createBlurClip, createImageClip, createProject, createTextClip, fitContain } from '../core/factory';
import { coverWindow, frameWindow, getFrame, insertFrame } from '../core/frames';
import { placeClip } from '../core/timeline';
import { media as mediaApi, projects } from '../platform/api';
import { markKeyword } from '../render/edicao';
import { waitReady } from './importer';

export const STORY_FRAME = 'central';
export const STORY_SECONDS = 15;

export interface StoryVideoInput {
  kicker: string;
  title: string;
  subtitle: string;
  /** trecho a destacar primeiro (o da IA) e, de reserva, palavras-chave: só UM é destacado */
  keywords?: string[];
  /** foto da matéria (arquivo já baixado); sem foto, a janela fica com o fundo da moldura */
  photo?: File | null;
  format?: FormatId;
  /** segundos */
  duration?: number;
  /** trilha do tom escolhido (id na biblioteca de mídia) */
  audioId?: string | null;
  /** trecho escolhido da música: início (s) e duração (s); a duração do post segue o trecho */
  audioStart?: number;
  audioDur?: number;
}

/** Monta o projeto (sem enviar nada): usado pelo app e pela automação. */
export function buildStoryProject(
  input: Omit<StoryVideoInput, 'photo' | 'audioId'>,
  photo: Pick<MediaAsset, 'id' | 'name' | 'width' | 'height'> | null,
  audio: MediaAsset | null,
): Project {
  const format = input.format ?? 'reel';
  const duration = Math.max(5, Math.min(20, input.duration ?? (audio ? input.audioDur : undefined) ?? STORY_SECONDS));
  const title = markKeyword(input.title.trim(), input.keywords ?? []);
  const name = title.replace(/\*/g, '').slice(0, 60) || `Post ${new Date().toLocaleDateString('pt-BR')}`;
  let p = createProject(name, format);
  const def = getFrame(STORY_FRAME);
  const visual = p.tracks.find((t) => t.kind === 'visual');
  if (photo) {
    const m = photo as MediaAsset;
    const img = createImageClip(p, m, 0);
    const ratio = (m.width || 16) / (m.height || 9);
    // cobre a janela da moldura; o que sobra fica escondido atrás do fundo da moldura
    const start = coverWindow(def, p.width, p.height, ratio);
    const end = { ...start, width: start.width * 1.07, height: start.height * 1.07 };
    img.transform = start;
    img.duration = duration;
    img.keyframes = [
      { ...start, t: 0, easing: 'linear' },
      { ...end, t: duration, easing: 'linear' },
    ];
    p = placeClip(p, img, visual?.id);
    // foto em pé, quadrada ou panorâmica: a cobertura cortaria demais. Fica
    // inteira na janela, sobre a própria foto desfocada preenchendo o fundo.
    if (ratio < 1.15 || ratio > 2.1) {
      const win = frameWindow(def, p.width, p.height);
      const blur = createBlurClip(p, { x: win.x + win.w / 2, y: win.y + win.h / 2, width: win.w, height: win.h }, 0);
      blur.duration = duration;
      blur.intensity = 75;
      p = placeClip(p, blur);
      const whole = createImageClip(p, m, 0);
      const fit = fitContain(m.width || 16, m.height || 9, win.w, win.h);
      whole.transform = { ...fit, x: win.x + win.w / 2, y: win.y + win.h / 2 };
      whole.duration = duration;
      whole.name = `${m.name} (inteira)`;
      p = placeClip(p, whole);
    }
  }
  const fr = insertFrame(p, STORY_FRAME, 0);
  p = { ...fr.project, clips: fr.project.clips.map((c) => (c.id === fr.clipId ? { ...c, duration } : c)) };
  const text = createTextClip(p, 'pn-edicao', 0);
  text.duration = duration;
  text.fields = { kicker: input.kicker.trim(), title, subtitle: input.subtitle.trim() };
  // placa logo abaixo da janela da foto, até antes do @perfil da moldura
  const top = (def.window.y + def.window.h) * p.height + p.height * 0.008;
  const bottom = p.height * 0.935;
  text.transform = { ...text.transform, x: p.width / 2, y: (top + bottom) / 2, width: p.width, height: bottom - top };
  p = placeClip(p, text);
  // trilha do tom: cortada no tamanho do post, entrando e saindo suave
  if (audio && audio.status === 'ready') {
    const clip = createAudioClip(p, audio, 0);
    // o trecho que o jornalista escolheu (ou o melhor que veio marcado), nunca passando do fim da música
    const total = audio.duration || duration;
    clip.sourceIn = Math.max(0, Math.min(input.audioStart ?? 0, total - Math.min(total, duration)));
    clip.duration = Math.min(duration, Math.max(0.1, total - clip.sourceIn));
    clip.fadeIn = 0.3;
    clip.fadeOut = Math.min(1.2, clip.duration / 3);
    clip.volume = 0.85;
    clip.name = `Trilha · ${audio.name}`;
    p = placeClip(p, clip);
  }
  return p;
}

/** App: envia a foto para a biblioteca, monta o projeto e salva. Devolve o id. */
export async function createStoryVideo(input: StoryVideoInput): Promise<string> {
  let photo: MediaAsset | null = null;
  if (input.photo) {
    const up = await mediaApi.upload(input.photo);
    photo = await waitReady(up.id);
    if (photo.status !== 'ready') throw new Error(photo.error ?? 'Não foi possível processar a foto.');
  }
  let audio: MediaAsset | null = null;
  if (input.audioId) {
    try {
      audio = await mediaApi.get(input.audioId);
    } catch {
      /* áudio apagado da biblioteca: o post sai sem trilha */
    }
  }
  const p = buildStoryProject(input, photo, audio);
  await projects.create(p);
  return p.id;
}
