/**
 * Motor do preview: sincroniza os elementos de mídia com o relógio da timeline
 * e roteia o áudio por Web Audio (ganho > 100% e fades).
 *
 * Cortes sem tela preta: os pedaços de uma mesma mídia revezam em DOIS
 * players (A/B). Enquanto um toca, o outro fica parado e já posicionado no
 * começo do próximo pedaço — quando a agulha chega no corte, o quadro já está
 * pronto. Além de não piscar, limita o número de players (o celular tem poucos
 * decodificadores de vídeo; um player por pedaço esgotava e ficava preto).
 */
import type { AudioClip, MediaAsset, Project, VideoClip } from '../core/model';
import { buildAudioPlan, gainAt, type AudioSegment } from '../core/audio';
import { clipEnd, projectDuration } from '../core/timeline';
import type { MediaSources } from '../render/renderer';
import { createPitchShifter, type PitchShifter } from './pitchShifter';

type MediaEl = HTMLVideoElement | HTMLAudioElement;

class PreviewEngine {
  /** players por "vaga" (mídia + número da vaga), não por clipe */
  private els = new Map<string, { el: MediaEl; url: string; pending: number | null }>();
  /** em qual vaga está cada clipe (recalculado a cada sincronização) */
  private slotOf = new Map<string, string>();
  /** último quadro bom de cada vídeo (mostrado enquanto o próximo carrega) */
  private held = new Map<string, { canvas: HTMLCanvasElement; at: number }>();

  private keepFrame(mediaId: string, v: HTMLVideoElement) {
    const now = performance.now();
    let h = this.held.get(mediaId);
    if (h && now - h.at < 200) return; // copia no máximo 5x por segundo (leve no celular)
    if (!h) {
      const k = Math.min(1, 720 / Math.max(v.videoWidth, v.videoHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(2, Math.round(v.videoWidth * k));
      canvas.height = Math.max(2, Math.round(v.videoHeight * k));
      h = { canvas, at: 0 };
      this.held.set(mediaId, h);
    }
    try {
      h.canvas.getContext('2d')?.drawImage(v, 0, 0, h.canvas.width, h.canvas.height);
      h.at = now;
    } catch {
      /* quadro indisponível agora */
    }
  }
  private images = new Map<string, HTMLImageElement>();
  private gains = new WeakMap<MediaEl, GainNode>();
  private audioRoutes = new WeakMap<MediaEl, { src: MediaElementAudioSourceNode; pitch: number; shifter: PitchShifter | null }>();
  private audioCtx: AudioContext | null = null;
  private listeners = new Set<() => void>();
  private media: Record<string, MediaAsset> = {};
  private clock: { t0: number; perf0: number } | null = null;

  readonly sources: MediaSources = {
    video: (clip) => {
      const key = this.slotOf.get(clip.id);
      const e = key ? (this.els.get(key)?.el as HTMLVideoElement | undefined) : undefined;
      if (e && e.readyState >= 2 && e.videoWidth > 0 && !e.seeking) {
        this.keepFrame(clip.mediaId, e);
        return e;
      }
      // quadro novo ainda carregando (pulo de corte, celular lento): segura o último quadro bom em vez de tela preta
      return this.held.get(clip.mediaId)?.canvas ?? (e && e.readyState >= 2 && e.videoWidth > 0 ? e : null);
    },
    image: (mediaId) => {
      const img = this.image(mediaId);
      return img && img.complete && img.naturalWidth > 0 ? img : null;
    },
    size: (mediaId) => {
      const img = this.image(mediaId);
      if (img && img.naturalWidth) return { w: img.naturalWidth, h: img.naturalHeight };
      const m = this.media[mediaId];
      return m && m.width ? { w: m.width, h: m.height } : null;
    },
  };

  setMedia(media: Record<string, MediaAsset>) {
    this.media = media;
  }

  onInvalidate(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private invalidate = () => {
    for (const fn of this.listeners) fn();
  };

  image(mediaId: string): HTMLImageElement | null {
    const m = this.media[mediaId];
    if (!m) return null;
    let img = this.images.get(m.url);
    if (!img) {
      img = new Image();
      img.decoding = 'async';
      img.onload = this.invalidate;
      img.src = m.url;
      this.images.set(m.url, img);
    }
    return img;
  }

  /** Web Audio só pode iniciar após um gesto do usuário. */
  unlockAudio() {
    if (!this.audioCtx) {
      try {
        this.audioCtx = new AudioContext();
        for (const { el } of this.els.values()) this.route(el);
      } catch {
        this.audioCtx = null;
      }
    }
    void this.audioCtx?.resume();
  }

  private route(el: MediaEl) {
    if (!this.audioCtx || this.gains.has(el)) return;
    try {
      const src = this.audioCtx.createMediaElementSource(el);
      const g = this.audioCtx.createGain();
      src.connect(g).connect(this.audioCtx.destination);
      this.gains.set(el, g);
      this.audioRoutes.set(el, { src, pitch: 1, shifter: null });
    } catch {
      /* elemento já roteado */
    }
  }

  /** Disfarce de voz no preview: insere/remove o trocador de tom entre a mídia e o volume. */
  private setPitch(el: MediaEl, pitch: number) {
    const r = this.audioRoutes.get(el);
    const g = this.gains.get(el);
    if (!r || !g || !this.audioCtx || Math.abs(r.pitch - pitch) < 1e-3) return;
    r.src.disconnect();
    r.shifter?.dispose();
    r.shifter = null;
    if (Math.abs(pitch - 1) > 1e-3) {
      r.shifter = createPitchShifter(this.audioCtx, pitch);
      r.src.connect(r.shifter.input);
      r.shifter.output.connect(g);
    } else {
      r.src.connect(g);
    }
    r.pitch = pitch;
  }

  private setGain(el: MediaEl, v: number) {
    const g = this.gains.get(el);
    if (g && this.audioCtx) {
      g.gain.setTargetAtTime(v, this.audioCtx.currentTime, 0.015);
      el.volume = 1;
    } else {
      el.volume = Math.max(0, Math.min(1, v));
    }
    el.muted = v <= 0;
  }

  private ensure(clip: VideoClip | AudioClip, key: string): MediaEl | null {
    const m = this.media[clip.mediaId];
    if (!m || m.status !== 'ready') return null;
    const cur = this.els.get(key);
    if (cur && cur.url === m.url) return cur.el;
    if (cur) this.dispose(key);
    const el: MediaEl = clip.type === 'video' ? document.createElement('video') : document.createElement('audio');
    el.preload = 'auto';
    el.src = m.url;
    if (el instanceof HTMLVideoElement) {
      el.playsInline = true;
      el.disablePictureInPicture = true;
    }
    const entry = { el, url: m.url, pending: null as number | null };
    el.addEventListener('loadeddata', this.invalidate);
    el.addEventListener('seeked', () => {
      if (entry.pending !== null) {
        const t = entry.pending;
        entry.pending = null;
        el.currentTime = t;
      }
      this.invalidate();
    });
    this.els.set(key, entry);
    this.route(el);
    return el;
  }

  private dispose(id: string) {
    const e = this.els.get(id);
    if (!e) return;
    e.el.pause();
    e.el.removeAttribute('src');
    e.el.load();
    this.els.delete(id);
  }

  private seek(id: string, t: number) {
    const e = this.els.get(id);
    if (!e) return;
    const el = e.el;
    const target = Math.max(0, Math.min(t, (el.duration || Infinity) - 0.001));
    if (el.seeking) {
      e.pending = target;
      return;
    }
    if (Math.abs(el.currentTime - target) > 1 / 120) el.currentTime = target;
  }

  /**
   * Vagas A/B: pedaços seguidos da mesma mídia alternam entre as vagas 0 e 1;
   * pedaços que tocam ao mesmo tempo (camadas) ganham vagas a mais.
   */
  private assignSlots(p: Project): Map<string, string> {
    const out = new Map<string, string>();
    const byMedia = new Map<string, (VideoClip | AudioClip)[]>();
    for (const c of p.clips) {
      if (c.type !== 'video' && c.type !== 'audio') continue;
      const k = `${c.type}:${c.mediaId}`;
      byMedia.set(k, [...(byMedia.get(k) ?? []), c]);
    }
    for (const [k, list] of byMedia) {
      list.sort((x, y) => x.start - y.start);
      const slotEnd: number[] = [];
      let last = -1;
      for (const c of list) {
        // alterna com o anterior (o próximo pedaço sempre fica num player livre, já posicionado)
        let s = slotEnd.findIndex((e, i) => e <= c.start + 1e-3 && i !== last);
        if (s < 0 && slotEnd.length >= 2) s = slotEnd.findIndex((e) => e <= c.start + 1e-3);
        if (s < 0) {
          s = slotEnd.length;
          slotEnd.push(0);
        }
        slotEnd[s] = clipEnd(c);
        last = s;
        out.set(c.id, `${k}#${s}`);
      }
    }
    return out;
  }

  /** Sincroniza todos os elementos com o tempo `t`. */
  sync(p: Project, t: number, playing: boolean) {
    const plan = new Map<string, AudioSegment>(buildAudioPlan(p).map((s) => [s.clipId, s]));
    this.slotOf = this.assignSlots(p);
    // por vaga: o clipe que está tocando agora, ou o próximo (para deixar pronto)
    const atual = new Map<string, VideoClip | AudioClip>();
    const proximo = new Map<string, VideoClip | AudioClip>();
    for (const c of p.clips) {
      if (c.type !== 'video' && c.type !== 'audio') continue;
      const key = this.slotOf.get(c.id)!;
      const track = p.tracks.find((tr) => tr.id === c.trackId);
      const active = t >= c.start && t < clipEnd(c) && !(c.type === 'video' && track?.hidden);
      if (active) atual.set(key, c);
      else if (c.start >= t) {
        const n = proximo.get(key);
        if (!n || c.start < n.start) proximo.set(key, c);
      }
    }
    const alive = new Set<string>();
    for (const key of new Set([...this.slotOf.values()])) {
      alive.add(key);
      const c = atual.get(key) ?? proximo.get(key);
      if (!c) {
        // vaga sem pedaço agora nem depois: PARA e cala (senão o resto do vídeo original
        // seguia tocando escondido, com som, como se não tivesse cortado)
        const e = this.els.get(key);
        if (e) {
          if (!e.el.paused) e.el.pause();
          this.setGain(e.el, 0);
        }
        continue;
      }
      const el = this.ensure(c, key);
      if (!el) continue;
      const active = atual.has(key);
      const seg = plan.get(c.id);
      if (active) {
        const mediaT = c.sourceIn + (t - c.start) * c.speed;
        if (playing) {
          if (el.playbackRate !== c.speed) el.playbackRate = c.speed;
          this.setGain(el, seg ? gainAt(seg, t) : 0);
          this.setPitch(el, seg ? seg.pitch : 1);
          if (el.paused) {
            if (Math.abs(el.currentTime - mediaT) > 0.05) el.currentTime = Math.max(0, mediaT);
            void el.play().catch(() => undefined);
          } else if (Math.abs(el.currentTime - mediaT) > 0.25) {
            el.currentTime = Math.max(0, mediaT);
          }
        } else {
          if (!el.paused) el.pause();
          if (c.type === 'video') this.seek(key, mediaT);
        }
      } else {
        // vaga livre: para e já espera no 1º quadro do próximo pedaço
        if (!el.paused) el.pause();
        this.setGain(el, 0);
        this.seek(key, c.sourceIn);
      }
    }
    for (const id of [...this.els.keys()]) if (!alive.has(id)) this.dispose(id);
  }

  // --------------------------------------------------------------- relógio
  play(p: Project, from: number, onTime: (t: number) => void, onEnd: () => void) {
    this.unlockAudio();
    const dur = projectDuration(p);
    const start = from >= dur - 0.02 ? 0 : from;
    this.clock = { t0: start, perf0: performance.now() };
    const tick = () => {
      if (!this.clock) return;
      const t = this.clock.t0 + (performance.now() - this.clock.perf0) / 1000;
      if (t >= dur) {
        this.clock = null;
        onTime(dur);
        onEnd();
        return;
      }
      onTime(t);
      requestAnimationFrame(tick);
    };
    onTime(start);
    requestAnimationFrame(tick);
  }

  stop() {
    this.clock = null;
  }

  get isRunning() {
    return this.clock !== null;
  }
}

export const preview = new PreviewEngine();
