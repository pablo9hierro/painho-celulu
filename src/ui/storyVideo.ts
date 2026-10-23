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
import type { FormatId, Keyframe, MediaAsset, Project, Transform, VisualClip } from '../core/model';
import { createAudioClip, createBlurClip, createImageClip, createVideoClip, createProject, createTextClip, fitContain } from '../core/factory';
import { coverWindow, frameWindow, getFrame, insertFrame } from '../core/frames';
import { placeClip } from '../core/timeline';
import { media as mediaApi, projects } from '../platform/api';
import { markKeyword } from '../render/edicao';
import { waitReady } from './importer';
import { ensureTrackMedia } from '../news/defaultTones';

export const STORY_FRAME = 'reels-post';
export const STORY_SECONDS = 15;

/**
 * "Snap zoom" (corte e reencaixe): em vez de um zoom lento e contínuo, fica
 * PARADO numa moldura por um tempo e, de repente, pula rapidinho pra outra
 * moldura (um pouco mais perto e um pouco deslocada) — o efeito de editor que
 * parece um corte de cena sem cortar de verdade. Cresce aos poucos (nunca
 * volta a diminuir) até um teto, pra não ficar exagerado em vídeos longos.
 */
const SNAP_CYCLE_S = 2.1;
const SNAP_DUR_S = 0.16;
const SNAP_STEP = 0.045;
const SNAP_MAX_SCALE = 1.22;
const SNAP_FOCOS: { x: number; y: number }[] = [
  { x: 0, y: 0 },
  { x: -1, y: -0.4 },
  { x: 1, y: 0.4 },
  { x: -1, y: 0.6 },
  { x: 1, y: -0.6 },
];

export function snapZoomKeyframes(base: Transform, duration: number): Keyframe[] {
  const ciclos = Math.max(1, Math.ceil(duration / SNAP_CYCLE_S));
  const out: Keyframe[] = [{ ...base, t: 0, easing: 'linear' }];
  let atual = base;
  for (let i = 0; i < ciclos; i++) {
    const fimParado = Math.min(duration, (i + 1) * SNAP_CYCLE_S - SNAP_DUR_S);
    const fimPulo = Math.min(duration, (i + 1) * SNAP_CYCLE_S);
    if (fimParado <= out[out.length - 1]!.t) break;
    // parado: mantém a mesma moldura até pouco antes do próximo pulo
    out.push({ ...atual, t: fimParado, easing: 'linear' });
    if (fimPulo <= fimParado) break;
    const scale = Math.min(SNAP_MAX_SCALE, atual.width / base.width + SNAP_STEP);
    const f = SNAP_FOCOS[i % SNAP_FOCOS.length]!;
    const novo: Transform = {
      ...base,
      width: base.width * scale,
      height: base.height * scale,
      x: base.x + (f.x * base.width * (scale - 1)) / 2,
      y: base.y + (f.y * base.height * (scale - 1)) / 2,
    };
    // pulo rápido pra nova moldura (o "corte e reencaixe")
    out.push({ ...novo, t: fimPulo, easing: 'ease-out' });
    atual = novo;
  }
  const last = out[out.length - 1]!;
  if (last.t < duration) out.push({ ...last, t: duration, easing: 'linear' });
  return out;
}

export interface StoryVideoInput {
  kicker: string;
  title: string;
  subtitle: string;
  /** trecho a destacar primeiro (o da IA) e, de reserva, palavras-chave: só UM é destacado */
  keywords?: string[];
  /** foto da matéria (arquivo já baixado); sem foto, a janela fica com o fundo da moldura */
  photo?: File | null;
  /** vídeo da matéria (baixado): entra no lugar da foto, sem o som original */
  video?: File | null;
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
  input: Omit<StoryVideoInput, 'photo' | 'video' | 'audioId'>,
  photo: Pick<MediaAsset, 'id' | 'name' | 'width' | 'height'> | MediaAsset | null,
  audio: MediaAsset | null,
): Project {
  const format = input.format ?? 'reel';
  let duration = Math.max(5, Math.min(20, input.duration ?? (audio ? input.audioDur : undefined) ?? STORY_SECONDS));
  // vídeo da matéria no lugar da foto: o post não passa do fim do vídeo
  const isVideo = (photo as MediaAsset | null)?.kind === 'video';
  if (isVideo) duration = Math.max(5, Math.min(duration, (photo as MediaAsset).duration || duration));
  const title = markKeyword(input.title.trim(), input.keywords ?? []);
  const name = title.replace(/\*/g, '').slice(0, 60) || `Post ${new Date().toLocaleDateString('pt-BR')}`;
  let p = createProject(name, format);
  const def = getFrame(STORY_FRAME);
  const visual = p.tracks.find((t) => t.kind === 'visual');
  if (photo) {
    const m = photo as MediaAsset;
    // foto ou vídeo (o som do vídeo fica mudo: só a trilha, baixinha)
    const mk = (): VisualClip => (isVideo ? { ...createVideoClip(p, m, 0), volume: 0, muted: true } : createImageClip(p, m, 0));
    const img = mk();
    const ratio = (m.width || 16) / (m.height || 9);
    // cobre a janela da moldura; o que sobra fica escondido atrás do fundo da moldura
    const start = coverWindow(def, p.width, p.height, ratio);
    img.transform = start;
    img.duration = duration;
    // foto: corte-e-reencaixe (fica parado e pula pra uma moldura nova de vez em
    // quando); vídeo já tem motion próprio, fica só o zoom lento de sempre
    img.keyframes = isVideo
      ? [{ ...start, t: 0, easing: 'linear' }, { ...start, width: start.width * 1.07, height: start.height * 1.07, t: duration, easing: 'linear' }]
      : snapZoomKeyframes(start, duration);
    p = placeClip(p, img, visual?.id);
    // foto em pé, quadrada ou panorâmica: a cobertura cortaria demais. Fica
    // inteira na janela, sobre a própria foto desfocada preenchendo o fundo.
    if (ratio < 1.15 || ratio > 2.1) {
      const win = frameWindow(def, p.width, p.height);
      const blur = createBlurClip(p, { x: win.x + win.w / 2, y: win.y + win.h / 2, width: win.w, height: win.h }, 0);
      blur.duration = duration;
      blur.intensity = 75;
      p = placeClip(p, blur);
      const whole = mk();
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
  // termina antes da área do nome/legenda do Instagram (e dentro da miniatura 3:4)
  const bottom = p.height * 0.75;
  // caixa centralizada de verdade (a margem é igual dos dois lados); o texto em
  // si começa rente à esquerda da caixa (estilo da placa), não precisa empurrar
  // a caixa pra esquerda — isso é o que deixava torto
  text.transform = { ...text.transform, x: p.width * 0.5, y: (top + bottom) / 2, width: p.width * 0.86, height: bottom - top };
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
    clip.volume = isVideo ? 0.35 : 0.85;
    clip.name = `Trilha · ${audio.name}`;
    p = placeClip(p, clip);
  }
  return p;
}

/** App: envia a foto para a biblioteca, monta o projeto e salva. Devolve o id. */
export async function createStoryVideo(input: StoryVideoInput): Promise<string> {
  let photo: MediaAsset | null = null;
  if (input.video) {
    try {
      const up = await mediaApi.upload(input.video);
      const v = await waitReady(up.id);
      if (v.status === 'ready' && v.duration >= 3) photo = v;
    } catch {
      /* vídeo não abriu: segue com a foto */
    }
  }
  if (!photo && input.photo) {
    const up = await mediaApi.upload(input.photo);
    photo = await waitReady(up.id);
    if (photo.status !== 'ready') throw new Error(photo.error ?? 'Não foi possível processar a foto.');
  }
  let audio: MediaAsset | null = null;
  if (input.audioId) {
    // música do app entra na biblioteca agora (uma vez); se não der, NÃO monta sem música
    const id = await ensureTrackMedia(input.audioId);
    audio = await mediaApi.get(id).catch(() => null);
    if (!audio || audio.status !== 'ready') throw new Error('A música escolhida não carregou; o post não foi montado sem música.');
  }
  const p = buildStoryProject(input, photo, audio);
  await projects.create(p);
  return p.id;
}
