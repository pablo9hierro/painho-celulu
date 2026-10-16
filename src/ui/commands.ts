/** Comandos do editor — chamados por botões, atalhos de teclado e painéis. */
import type { Clip, MediaAsset, Project, ShapeClip } from '../core/model';
import { isVisual } from '../core/model';
import {
  createAudioClip,
  createBlurClip,
  createImageClip,
  createShapeClip,
  createSponsorsClip,
  createTextClip,
  createVideoClip,
  fitContain,
  fitCover,
  NEUTRAL_ADJUST,
} from '../core/factory';
import { uid } from '../core/id';
import { clipEnd, deleteClips, duplicateClip, findClip, placeClip, projectDuration, splitClip } from '../core/timeline';
import { coverWindow, FRAME_LOGO_DEFAULT, fitVideosToFrame, frameAt, getFrame, insertFrame } from '../core/frames';
import { getEditor } from '../state/store';
import { preview } from '../engine/preview';
import { effectiveTransform, patchClip } from '../core/edit';
import { ensureOutroAudio, waitReady } from './importer';
import { cutoutImage } from '../platform/imagePrep';
import { media as mediaApi } from '../platform/api';
import { outroAuto } from './frameLogos';

const st = getEditor;

/**
 * Adiciona mídia EXATAMENTE na agulha (ou no ponto de soltura). Vídeo tenta a
 * trilha principal; se ali já houver vídeo naquele instante, vai para uma camada.
 */
/** Último item da biblioteca inserido (evita duplicar com toque duplo / clique após arrastar). */
let lastAdd = { id: '', at: 0 };
export function recentlyAdded(mediaId: string): boolean {
  const now = Date.now();
  const dup = lastAdd.id === mediaId && now - lastAdd.at < 700;
  lastAdd = { id: mediaId, at: now };
  return dup;
}

export function addMedia(m: MediaAsset, at?: number) {
  const s = st();
  if (!s.project) return;
  if (recentlyAdded(m.id)) return;
  if (m.status !== 'ready') {
    s.notify('Aguarde o processamento do arquivo.', 'info');
    return;
  }
  let clip: Clip;
  const p = s.project;
  const t = at ?? s.time;
  if (m.kind === 'video') {
    const main = p.tracks.find((tr) => tr.kind === 'visual');
    clip = createVideoClip(p, m, t);
    const frame = frameAt(p, t);
    if (frame) clip.transform = coverWindow(getFrame(frame.frame), p.width, p.height, clip.transform.width / clip.transform.height);
    s.apply((pr) => placeClip(pr, clip, main?.id));
  } else if (m.kind === 'image') {
    clip = createImageClip(p, m, t);
    s.apply((pr) => placeClip(pr, clip));
  } else {
    clip = createAudioClip(p, m, t);
    s.apply((pr) => placeClip(pr, clip));
  }
  s.select([clip.id]);
}

export function addText(presetId: string) {
  const s = st();
  if (!s.project) return;
  const c = createTextClip(s.project, presetId, s.time);
  s.apply((p) => placeClip(p, c));
  s.select([c.id]);
}

export function addSponsors(mediaIds: string[] = []) {
  const s = st();
  if (!s.project) return;
  const c = createSponsorsClip(s.project, mediaIds, s.time);
  s.apply((p) => placeClip(p, c));
  s.select([c.id]);
}

export function addShape(kind: ShapeClip['shape']) {
  const s = st();
  if (!s.project) return;
  const c = createShapeClip(s.project, kind, s.time);
  s.apply((p) => placeClip(p, c));
  s.select([c.id]);
}

export function addBlur(rect: { x: number; y: number; width: number; height: number }, shape: 'rect' | 'ellipse') {
  const s = st();
  if (!s.project) return;
  const c = createBlurClip(s.project, rect, s.time, shape);
  s.apply((p) => placeClip(p, c));
  s.select([c.id]);
  s.set('tool', 'select');
}

/** Insere uma moldura na agulha, como item normal da timeline (pode haver várias). */
export function applyFrameCmd(id: string) {
  const s = st();
  if (!s.project) return;
  // moldura selecionada: trocar o modelo dela (como trocar o estilo no CapCut);
  // sem moldura selecionada: insere uma nova na agulha (pode haver várias)
  const selected = s.selection.length === 1 ? s.project.clips.find((c) => c.id === s.selection[0] && c.type === 'frame') : undefined;
  if (selected && selected.type === 'frame') {
    if (selected.frame === id) return;
    const def = getFrame(id);
    s.apply((p) =>
      fitVideosToFrame(
        patchClip(p, selected.id, { frame: id, name: `Moldura · ${def.name}` } as Partial<Clip>),
        def,
        selected.start,
        selected.start + selected.duration,
      ),
    );
    return;
  }
  let clipId = '';
  const at = s.time;
  s.apply((p) => {
    const r = insertFrame(p, id, at);
    clipId = r.clipId;
    return r.project;
  });
  s.select([clipId]);
}

/** Volta o item selecionado à configuração padrão do seu template/tipo. */
export function resetClip(id: string) {
  const s = st();
  const p = s.project;
  if (!p) return;
  const c = findClip(p, id);
  if (!c) return;
  const frame = frameAt(p, c.start);
  const keep = { id: c.id, trackId: c.trackId, start: c.start, duration: c.duration, name: c.name };
  let next: Clip = c;
  switch (c.type) {
    case 'text': {
      const d = createTextClip(p, c.preset, c.start);
      next = { ...d, ...keep, name: d.name, fields: c.fields };
      break;
    }
    case 'video': {
      const m = s.media[c.mediaId];
      const ratio = m?.width ? m.width / m.height : c.transform.width / c.transform.height;
      const tr = frame ? coverWindow(getFrame(frame.frame), p.width, p.height, ratio) : fitContain(ratio * 1000, 1000, p.width, p.height);
      const span = c.duration * c.speed;
      next = { ...c, transform: tr, keyframes: [], adjust: { ...NEUTRAL_ADJUST }, flipH: false, volume: 1, muted: false, fadeIn: 0, fadeOut: 0, speed: 1, duration: Math.min(span, c.sourceDuration - c.sourceIn || span), backdrop: 'none', animIn: { type: 'none', duration: 1 }, animOut: { type: 'none', duration: 1 } };
      break;
    }
    case 'image': {
      const m = s.media[c.mediaId];
      const d = m ? createImageClip(p, m, c.start) : c;
      next = { ...c, transform: d.transform, keyframes: [], adjust: { ...NEUTRAL_ADJUST }, flipH: false };
      break;
    }
    case 'audio': {
      const span = c.duration * c.speed;
      next = { ...c, volume: 1, muted: false, fadeIn: 0, fadeOut: 0, speed: 1, duration: span };
      break;
    }
    case 'blur':
      next = { ...c, intensity: 60, mode: 'blur', keyframes: [], transform: { ...c.transform, rotation: 0, opacity: 1 } };
      break;
    case 'frame': {
      // reenquadra os vídeos do trecho desta moldura
      s.apply((pr) => fitVideosToFrame(pr, getFrame(c.frame), c.start, c.start + c.duration));
      s.select([id]);
      return;
    }
    case 'sponsors':
      next = { ...c, transform: createSponsorsClip(p, [], c.start).transform, keyframes: [] };
      break;
    case 'shape':
      next = { ...c, transform: createShapeClip(p, c.shape, c.start).transform, keyframes: [] };
      break;
  }
  s.apply((pr) => ({ ...pr, clips: pr.clips.map((x) => (x.id === id ? next : x)) }));
  s.notify('Configuração padrão restaurada');
}

export function splitAtPlayhead() {
  const s = st();
  if (!s.project) return;
  const t = s.time;
  const targets = (s.selection.length ? s.project.clips.filter((c) => s.selection.includes(c.id)) : s.project.clips).filter(
    (c) => t > c.start && t < clipEnd(c),
  );
  if (!targets.length) {
    s.notify('Posicione a agulha sobre um clipe para dividir.');
    return;
  }
  const newIds: string[] = [];
  s.apply((p) => {
    let pr = p;
    for (const c of targets) {
      const r = splitClip(pr, c.id, t);
      pr = r.project;
      if (r.newId) newIds.push(r.newId);
    }
    return pr;
  });
  if (newIds.length) s.select(newIds);
}

export function deleteSelection(ripple = false) {
  const s = st();
  if (!s.project || !s.selection.length) return;
  // logo da moldura selecionada no preview: tira só a logo, a moldura fica
  if (s.frameLogoId && s.selection.length === 1 && s.selection[0] === s.frameLogoId) {
    const id = s.frameLogoId;
    s.apply((p) => {
      const c = p.clips.find((x) => x.id === id);
      if (!c || c.type !== 'frame') return p;
      return patchClip(p, id, { logo: { ...(c.logo ?? FRAME_LOGO_DEFAULT), hidden: true } } as Partial<Clip>);
    });
    s.set('frameLogoId', null);
    return;
  }
  const ids = [...s.selection];
  s.apply((p) => deleteClips(p, ids, ripple));
  s.select([]);
}

export function duplicateSelection() {
  const s = st();
  if (!s.project || !s.selection.length) return;
  const ids: string[] = [];
  s.apply((p) => {
    let pr = p;
    for (const id of s.selection) {
      const r = duplicateClip(pr, id);
      pr = r.project;
      if (r.newId) ids.push(r.newId);
    }
    return pr;
  });
  s.select(ids);
}

export function copySelection() {
  const s = st();
  if (!s.project || !s.selection.length) return;
  s.set('clipboard', s.project.clips.filter((c) => s.selection.includes(c.id)).map((c) => structuredClone(c)));
  s.notify(`${s.selection.length} item(ns) copiado(s)`);
}

export function paste() {
  const s = st();
  if (!s.project || !s.clipboard?.length) return;
  const minStart = Math.min(...s.clipboard.map((c) => c.start));
  const ids: string[] = [];
  s.apply((p) => {
    let pr = p;
    for (const c of s.clipboard!) {
      const copy = { ...structuredClone(c), id: uid(), start: s.time + (c.start - minStart) } as Clip;
      ids.push(copy.id);
      pr = placeClip(pr, copy, c.trackId);
    }
    return pr;
  });
  s.select(ids);
}

export function togglePlay() {
  const s = st();
  if (!s.project) return;
  if (s.playing) {
    preview.stop();
    s.setPlaying(false);
    return;
  }
  if (projectDuration(s.project) <= 0) return;
  s.setPlaying(true);
  preview.play(
    s.project,
    s.time,
    (t) => st().setTime(t),
    () => st().setPlaying(false),
  );
}

export function stopPlayback() {
  preview.stop();
  st().setPlaying(false);
}

export function seek(t: number) {
  const s = st();
  if (s.playing) {
    stopPlayback();
  }
  s.setTime(t);
}

export function stepFrames(n: number) {
  const s = st();
  if (!s.project) return;
  seek(Math.round((s.time + n / s.project.fps) * s.project.fps) / s.project.fps);
}

/** Encaixa (contain) ou preenche (cover) o quadro com a mídia selecionada. */
export function fitSelection(mode: 'contain' | 'cover') {
  const s = st();
  const p = s.project;
  if (!p) return;
  s.apply((pr) => ({
    ...pr,
    clips: pr.clips.map((c) => {
      if (!s.selection.includes(c.id) || (c.type !== 'video' && c.type !== 'image')) return c;
      const m = s.media[c.mediaId];
      const r = m && m.width ? m.width / m.height : c.transform.width / c.transform.height;
      const tr = mode === 'contain' ? fitContain(r * 1000, 1000, p.width, p.height) : fitCover(r * 1000, 1000, p.width, p.height);
      return { ...c, transform: { ...tr, rotation: 0, opacity: c.transform.opacity }, keyframes: [] };
    }),
  }));
}

/** Separa o áudio do vídeo selecionado em um clipe de áudio independente. */
export function detachAudio() {
  const s = st();
  const p = s.project;
  if (!p) return;
  const v = p.clips.find((c) => s.selection.includes(c.id) && c.type === 'video');
  if (!v || v.type !== 'video' || !v.hasAudio) {
    s.notify('Selecione um vídeo com áudio.');
    return;
  }
  const a: Clip = {
    type: 'audio',
    id: uid(),
    trackId: '',
    name: `Áudio · ${v.name}`,
    start: v.start,
    duration: v.duration,
    mediaId: v.mediaId,
    sourceIn: v.sourceIn,
    sourceDuration: v.sourceDuration,
    speed: v.speed,
    volume: v.volume,
    muted: false,
    fadeIn: v.fadeIn,
    fadeOut: v.fadeOut,
  };
  s.apply((pr) => placeClip({ ...pr, clips: pr.clips.map((c) => (c.id === v.id ? { ...c, muted: true } : c)) }, a));
  s.select([a.id]);
}

/** Move os elementos visuais selecionados alguns pixels (setas do teclado). */
export function nudge(dx: number, dy: number) {
  const s = st();
  if (!s.project) return;
  s.apply((p: Project) => {
    let pr = p;
    for (const id of s.selection) {
      const c = findClip(pr, id);
      if (!c || !isVisual(c)) continue;
      const tr = effectiveTransform(c, s.time);
      const next = { ...tr, x: tr.x + dx, y: tr.y + dy };
      pr = {
        ...pr,
        clips: pr.clips.map((x) => {
          if (x.id !== id || !isVisual(x)) return x;
          if (x.keyframes.length) {
            const local = Math.max(0, s.time - x.start);
            const kfs = x.keyframes.filter((k) => Math.abs(k.t - local) > 1 / 60);
            kfs.push({ ...next, t: local, easing: 'ease-in-out' });
            return { ...x, keyframes: kfs.sort((a, b) => a.t - b.t) };
          }
          return { ...x, transform: next };
        }),
      };
    }
    return pr;
  }, 'nudge');
}

/**
 * Encerramento estilo TikTok: tela final com a logo e o @perfil + som de
 * encerramento, colocados juntos logo depois do fim do vídeo.
 */
/**
 * Remove o fundo liso de uma imagem que já está no projeto (ex.: logo enviada
 * antes, que veio em JPG com fundo branco). Cria uma cópia PNG transparente e
 * troca a imagem do item por ela.
 */
export async function removeImageBackground(clipId: string) {
  const s = st();
  const clip = s.project?.clips.find((c) => c.id === clipId);
  if (!clip || clip.type !== 'image') return;
  const m = s.media[clip.mediaId];
  if (!m) return;
  try {
    const blob = await (await fetch(m.url)).blob();
    const file = new File([blob], m.name, { type: blob.type });
    const out = await cutoutImage(file, { minBorder: 0.6 });
    if (out === file) {
      st().notify('Esta imagem já é transparente ou não tem um fundo de cor única para remover.', 'info');
      return;
    }
    const up = await mediaApi.upload(out);
    st().upsertMedia(up);
    const ready = await waitReady(up.id);
    if (ready.status !== 'ready') throw new Error(ready.error ?? 'falha ao processar');
    st().apply((p) => patchClip(p, clipId, { mediaId: ready.id } as Partial<Clip>));
    st().notify('Fundo removido.', 'info');
  } catch (e) {
    st().notify(`Não foi possível remover o fundo: ${(e as Error).message}`, 'error');
  }
}

const OUTRO_PRESET = 'pn-encerramento';

/** Cartão do encerramento ocupando o quadro inteiro (sem faixas acima e abaixo). */
function outroCard(p: Project, start: number) {
  const c = createTextClip(p, OUTRO_PRESET, start);
  c.transform = { ...c.transform, x: p.width / 2, y: p.height / 2, width: p.width, height: p.height };
  return c;
}

export const hasOutro = (p: Project) => p.clips.some((c) => c.type === 'text' && c.preset === OUTRO_PRESET);

/**
 * Projeto que vai para a exportação: com o encerramento (cartão + som) no fim,
 * se estiver ligado e se o usuário já não tiver colocado um na timeline.
 * Não altera o projeto salvo.
 */
export async function projectForExport(p: Project): Promise<Project> {
  const start = projectDuration(p);
  if (!outroAuto() || start <= 0 || hasOutro(p)) return p;
  let next = placeClip(p, outroCard(p, start));
  try {
    const m = await ensureOutroAudio();
    const a = createAudioClip(next, m, start);
    a.name = 'Som do encerramento';
    next = placeClip(next, a);
  } catch {
    /* sem o som, o encerramento vai mudo */
  }
  return next;
}

export async function addOutro() {
  const s = st();
  if (!s.project) return;
  const start = projectDuration(s.project);
  const c = outroCard(s.project, start);
  s.apply((p) => placeClip(p, c));
  s.select([c.id]);
  s.setTime(start);
  try {
    const m = await ensureOutroAudio();
    const cur = st();
    if (!cur.project || !cur.project.clips.some((x) => x.id === c.id)) return;
    const a = createAudioClip(cur.project, m, start);
    a.name = 'Som do encerramento';
    cur.apply((p) => placeClip(p, a), `outro-${c.id}`);
  } catch (e) {
    st().notify(`Encerramento sem som: ${(e as Error).message}`, 'error');
  }
}
