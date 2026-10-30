/**
 * Matéria → post em vídeo, sempre no MESMO padrão (serve para qualquer foto):
 * - moldura "Vídeo central" da marca (logo no cabeçalho, logo andando no fundo);
 * - a foto da notícia na janela do meio (larga, ~1,4:1: quase toda foto de
 *   notícia cabe com pouco corte), com aproximação lenta; foto em pé ou
 *   panorâmica fica inteira, sobre ela mesma desfocada;
 * - a placa "Edição" logo abaixo da janela, sem cobrir a foto, com UM trecho
 *   destacado (o que a IA escolheu ao escrever a matéria);
 * - vídeo: aproximado no CENTRO (marca d'água de outro canal fica nos cantos,
 *   fora da janela) e, se for longo, montado com 3 trechos do meio dele;
 * - várias fotos: slide, uma atrás da outra, com transição suave;
 * - a trilha do tom da matéria, se houver.
 * O app abre o projeto no editor; a automação renderiza o mesmo projeto.
 */
import type { FormatId, MediaAsset, Project, VisualClip } from '../core/model';
import { createAudioClip, createBlurClip, createImageClip, createVideoClip, createProject, createTextClip, fitContain } from '../core/factory';
import { coverWindow, frameWindow, getFrame, insertFrame } from '../core/frames';
import { placeClip } from '../core/timeline';
import { media as mediaApi, projects } from '../platform/api';
import { markKeyword } from '../render/edicao';
import { waitReady } from './importer';
import { ensureTrackMedia } from '../news/defaultTones';

export const STORY_FRAME = 'central';
export const STORY_SECONDS = 15;
/** a foto entra quando a moldura e a manchete já estão chegando (tudo junto) */
const INTRO_S = 0.35;
/** transição entre as fotos do slide */
const CROSS_S = 0.6;
/** até quantas fotos no slide (a capa + extras), cada uma com pelo menos este tempo */
const MAX_FOTOS = 5;
const MIN_FOTO_S = 2.4;
/** vídeo: aproxima no centro (corta os cantos, onde fica marca d'água) */
const ZOOM_VIDEO = 1.22;
/** vídeo longo: monta com trechos do meio */
const TRECHOS = 3;

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
  /** mais fotos da matéria (sem vídeo): vira slide com transição (até 4 além da capa) */
  morePhotos?: File[];
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
  input: Omit<StoryVideoInput, 'photo' | 'video' | 'audioId' | 'morePhotos'>,
  photo: Pick<MediaAsset, 'id' | 'name' | 'width' | 'height'> | MediaAsset | null,
  audio: MediaAsset | null,
  extras: MediaAsset[] = [],
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
    // várias fotos (sem vídeo): slide, cada uma com seu tempo e transição suave
    const cabe = Math.max(0, Math.min(MAX_FOTOS, Math.floor(duration / MIN_FOTO_S)) - 1);
    const slides = isVideo ? [] : extras.filter((x) => x.status === 'ready' && x.kind === 'image').slice(0, cabe);
    const fatia = duration / (1 + slides.length);
    // cobre a janela da moldura; o que sobra fica escondido atrás do fundo da moldura
    const cobre = coverWindow(def, p.width, p.height, ratio);
    // vídeo: mais perto, no centro (onde acontece o fato; logo de outro canal fica nos cantos, fora)
    const start = isVideo ? { ...cobre, width: cobre.width * ZOOM_VIDEO, height: cobre.height * ZOOM_VIDEO } : cobre;
    img.transform = start;
    // entra junto com a moldura e a manchete (antes ficava sozinha na tela enquanto o resto subia)
    img.start = INTRO_S;
    img.duration = (slides.length ? fatia + CROSS_S : duration) - INTRO_S;
    img.animIn = { type: 'fade', duration: 0.45 };
    // aproximação lenta (Pan/Crop), sem mexer a câmera pros lados
    const end = { ...start, width: start.width * 1.07, height: start.height * 1.07 };
    img.keyframes = [
      { ...start, t: 0, easing: 'linear' },
      { ...end, t: img.duration, easing: 'linear' },
    ];
    // vídeo longo: em vez de só o começo, 3 trechos do meio (pula a abertura e o fim, onde costuma ter vinheta/logo)
    const vdur = isVideo ? (m.duration || 0) : 0;
    if (isVideo && vdur >= duration * 1.8) {
      const len = (duration - INTRO_S) / TRECHOS;
      const a = vdur * 0.08;
      const b = vdur * 0.92 - len;
      for (let k = 0; k < TRECHOS; k++) {
        const c = k === 0 ? img : { ...mk(), transform: start, animIn: { type: 'fade' as const, duration: 0.25 } };
        c.start = INTRO_S + k * len;
        c.duration = k === TRECHOS - 1 ? duration - c.start : len;
        (c as typeof c & { sourceIn: number }).sourceIn = a + ((b - a) * k) / (TRECHOS - 1);
        const fimK = { ...start, width: start.width * 1.06, height: start.height * 1.06 };
        c.keyframes = [
          { ...start, t: 0, easing: 'linear' },
          { ...fimK, t: c.duration, easing: 'linear' },
        ];
        if (k === 0) c.animIn = { type: 'fade', duration: 0.45 };
        c.name = `${m.name} (trecho ${k + 1})`;
        p = placeClip(p, c, visual?.id);
      }
    } else p = placeClip(p, img, visual?.id);
    slides.forEach((s, i) => {
      const c = createImageClip(p, s, 0);
      const st = coverWindow(def, p.width, p.height, (s.width || 16) / (s.height || 9));
      c.start = fatia * (i + 1);
      c.duration = i === slides.length - 1 ? duration - c.start : fatia + CROSS_S;
      // uma aproxima, a seguinte se afasta (movimento diferente a cada foto), entrando por cima da anterior
      const perto = { ...st, width: st.width * 1.09, height: st.height * 1.09 };
      const [de, ate] = i % 2 === 0 ? [perto, st] : [st, perto];
      c.transform = de;
      c.animIn = { type: 'fade', duration: CROSS_S };
      c.keyframes = [
        { ...de, t: 0, easing: 'linear' },
        { ...ate, t: c.duration, easing: 'linear' },
      ];
      p = placeClip(p, c);
    });
    // foto em pé, quadrada ou panorâmica: a cobertura cortaria demais. Fica
    // inteira na janela, sobre a própria foto desfocada preenchendo o fundo.
    // (vídeo não: nele o foco é o centro, sem as bordas com marca d'água)
    if (!isVideo && !slides.length && (ratio < 1.15 || ratio > 2.1)) {
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
  // a moldura reencaixa os vídeos na janela (sem zoom): devolve o enquadramento do post (zoom no centro)
  const enquadre = new Map(p.clips.filter((c) => c.type === 'video').map((c) => [c.id, { transform: c.transform, keyframes: c.keyframes }]));
  const fr = insertFrame(p, STORY_FRAME, 0);
  p = { ...fr.project, clips: fr.project.clips.map((c) => (c.id === fr.clipId ? { ...c, duration } : enquadre.has(c.id) ? { ...c, ...enquadre.get(c.id)! } : c)) };
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
  // mais fotos (sem vídeo): slide
  const extras: MediaAsset[] = [];
  if (photo && photo.kind === 'image') {
    for (const f of (input.morePhotos ?? []).slice(0, MAX_FOTOS - 1)) {
      try {
        const up = await mediaApi.upload(f);
        const m = await waitReady(up.id);
        if (m.status === 'ready') extras.push(m);
      } catch {
        /* foto extra não abriu: segue sem ela */
      }
    }
  }
  let audio: MediaAsset | null = null;
  if (input.audioId) {
    // música do app entra na biblioteca agora (uma vez); se não der, NÃO monta sem música
    const id = await ensureTrackMedia(input.audioId);
    audio = await mediaApi.get(id).catch(() => null);
    if (!audio || audio.status !== 'ready') throw new Error('A música escolhida não carregou; o post não foi montado sem música.');
  }
  const p = buildStoryProject(input, photo, audio, extras);
  await projects.create(p);
  return p.id;
}
