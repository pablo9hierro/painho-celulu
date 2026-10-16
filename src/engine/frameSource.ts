/**
 * Fonte de quadros para exportação: um elemento de vídeo por clipe, posicionado
 * no instante exato de cada quadro. Compartilhado pela exportação via FFmpeg
 * (PC) e via WebCodecs (celular/navegador).
 */
import type { MediaAsset, Project, VideoClip } from '../core/model';
import { evaluateScene } from '../core/scene';
import type { MediaSources } from '../render/renderer';
import { SequentialDecoder, type Demuxed } from './sequentialDecoder';

function loadVideo(url: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    v.playsInline = true;
    v.onloadeddata = () => resolve(v);
    v.onerror = () => reject(new Error('Não foi possível carregar um dos vídeos do projeto.'));
    v.src = url;
  });
}

async function loadImage(url: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = url;
  await img.decode();
  return img;
}

function seekExact(v: HTMLVideoElement, t: number): Promise<void> {
  const target = Math.max(0, Math.min(t, (v.duration || Infinity) - 0.001));
  if (Math.abs(v.currentTime - target) < 1e-4 && !v.seeking && v.readyState >= 2) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, 4000);
    v.addEventListener('seeked', done, { once: true });
    v.currentTime = target;
  });
}

export interface FrameSource {
  sources: MediaSources;
  /** posiciona todos os vídeos ativos no instante `t` da timeline */
  seek(t: number): Promise<void>;
  dispose(): void;
}

const FAILED: unique symbol = Symbol("decodificador falhou");
const DECODER_TIMEOUT_MS = 8000;

export async function prepareFrameSource(project: Project, media: Record<string, MediaAsset>): Promise<FrameSource> {
  const videos = new Map<string, HTMLVideoElement>();
  // caminho rápido: decodificação sequencial (mesmos quadros, sem reposicionar o vídeo)
  const decoders = new Map<string, SequentialDecoder>();
  const decoded = new Map<string, CanvasImageSource | null>();
  const images = new Map<string, HTMLImageElement>();
  const urls = new Map<string, string>();
  const demuxCache = new Map<string, Promise<Demuxed | null>>();
  for (const c of project.clips) {
    if (c.type === 'video') {
      const m = media[c.mediaId];
      if (!m) throw new Error(`Mídia ausente: ${c.name}`);
      // o decodificador só é aberto quando o trecho começa (ver seek): o navegador
      // recolhe codecs ociosos, e trechos do fim ficariam parados por muito tempo
      urls.set(c.id, m.url);
    }
    const ids = c.type === 'image' ? [c.mediaId] : c.type === 'sponsors' ? c.mediaIds : [];
    for (const id of ids) {
      const m = media[id];
      if (m && !images.has(id)) images.set(id, await loadImage(m.url));
    }
  }
  return {
    sources: {
      video: (clip: VideoClip) => (decoders.has(clip.id) ? (decoded.get(clip.id) ?? null) : (videos.get(clip.id) ?? null)),
      image: (id) => images.get(id) ?? null,
      size: (id) => {
        const i = images.get(id);
        if (i) return { w: i.naturalWidth, h: i.naturalHeight };
        const m = media[id];
        return m && m.width && m.height ? { w: m.width, h: m.height } : null;
      },
    },
    async seek(t) {
      const active = evaluateScene(project, t).filter((it) => it.clip.type === 'video');
      const activeIds = new Set(active.map((it) => it.clip.id));
      // fecha o que já terminou (libera o decodificador)
      for (const [id, d] of decoders) {
        if (!activeIds.has(id)) {
          d.dispose();
          decoders.delete(id);
          decoded.delete(id);
        }
      }
      // abre o que está começando agora
      for (const it of active) {
        const id = it.clip.id;
        if (decoders.has(id) || videos.has(id)) continue;
        const url = urls.get(id)!;
        const dec = await SequentialDecoder.create(url, demuxCache);
        if (dec) decoders.set(id, dec);
        else videos.set(id, await loadVideo(url));
      }
      await Promise.all(
        active.map(async (it) => {
          const id = it.clip.id;
          const dec = decoders.get(id);
          if (dec) {
            // rede de segurança: se o decodificador do aparelho não responder,
            // este vídeo passa para o método clássico e a exportação continua
            const frame = await Promise.race([
              dec.frameAt(it.mediaTime).catch((): typeof FAILED => FAILED),
              new Promise<typeof FAILED>((r) => setTimeout(() => r(FAILED), DECODER_TIMEOUT_MS)),
            ]);
            if (frame !== FAILED) {
              decoded.set(id, frame);
              return;
            }
            dec.dispose();
            decoders.delete(id);
            decoded.delete(id);
            const clip = it.clip as VideoClip;
            videos.set(id, await loadVideo(media[clip.mediaId]!.url));
          }
          await seekExact(videos.get(id)!, it.mediaTime);
        }),
      );
    },
    dispose() {
      for (const v of videos.values()) {
        v.removeAttribute('src');
        v.load();
      }
      for (const d of decoders.values()) d.dispose();
    },
  };
}
