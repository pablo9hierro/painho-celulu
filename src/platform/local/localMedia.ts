/**
 * Biblioteca de mídia 100% local. O arquivo importado é guardado inteiro na
 * memória do app (IndexedDB) e processado no próprio aparelho:
 * metadados pelo <video>/<img>, miniaturas desenhando quadros num canvas e
 * forma de onda decodificando o áudio com Web Audio.
 */
import type { MediaAsset } from '../../core/model';
import { uid } from '../../core/id';
import type { MediaService } from '../types';
import { idbAll, idbDelete, idbGet, idbPut } from './idb';
import horizontalUrl from '../../assets/pn-logo-horizontal.png';
import normalUrl from '../../assets/pn-logo-normal.png';

type StoredMeta = Omit<MediaAsset, 'url' | 'thumbs' | 'waveform'> & {
  thumbs: Omit<NonNullable<MediaAsset['thumbs']>, 'url'> | null;
  hasWaveform: boolean;
};

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp|avif)$/i;
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|ogg|oga|opus|flac)$/i;
const WAVE_PREFIX = 'local-wave:';

/** URLs de objeto da sessão (blob: na memória do navegador/WebView). */
const objectUrls = new Map<string, string>();

async function blobUrl(key: string): Promise<string> {
  const hit = objectUrls.get(key);
  if (hit) return hit;
  const blob = await idbGet<Blob>(key.startsWith('thumbs:') ? 'derived' : 'blobs', key);
  if (!blob) return '';
  const url = URL.createObjectURL(blob);
  objectUrls.set(key, url);
  return url;
}

async function toAsset(m: StoredMeta): Promise<MediaAsset> {
  return {
    ...m,
    url: await blobUrl(m.id),
    thumbs: m.thumbs ? { ...m.thumbs, url: await blobUrl(`thumbs:${m.id}`) } : null,
    waveform: m.hasWaveform ? `${WAVE_PREFIX}${m.id}` : null,
  };
}

function kindOf(file: File): MediaAsset['kind'] {
  if (file.type.startsWith('image/') || IMAGE_EXT.test(file.name)) return 'image';
  if (file.type.startsWith('audio/') || AUDIO_EXT.test(file.name)) return 'audio';
  return 'video';
}

function once<K extends keyof HTMLMediaElementEventMap>(el: HTMLMediaElement, ok: K, timeout = 15000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Tempo esgotado ao ler o arquivo.')), timeout);
    el.addEventListener(ok, () => (clearTimeout(t), resolve()), { once: true });
    el.addEventListener('error', () => (clearTimeout(t), reject(new Error('Formato não suportado neste aparelho.'))), { once: true });
  });
}

/** Faixa de miniaturas (sprite horizontal) desenhando quadros do próprio vídeo. */
async function makeThumbs(url: string, duration: number, vw: number, vh: number) {
  const count = Math.max(1, Math.min(30, Math.ceil(duration)));
  const height = 72;
  const width = Math.max(16, Math.round((vw / Math.max(1, vh)) * height));
  const v = document.createElement('video');
  v.muted = true;
  v.preload = 'auto';
  v.playsInline = true;
  v.src = url;
  await once(v, 'loadeddata');
  const c = document.createElement('canvas');
  c.width = width * count;
  c.height = height;
  const ctx = c.getContext('2d')!;
  const interval = Math.max(duration / count, 0.04);
  for (let i = 0; i < count; i++) {
    v.currentTime = Math.min(duration - 0.05, i * interval + 0.01);
    await once(v, 'seeked', 8000).catch(() => undefined);
    ctx.drawImage(v, i * width, 0, width, height);
  }
  v.removeAttribute('src');
  v.load();
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', 0.7));
  return blob ? { blob, info: { count, interval, width, height } } : null;
}

/** Picos de áudio (50 por segundo); null se não houver trilha de áudio. */
async function makeWaveform(file: Blob): Promise<number[] | null> {
  try {
    const ctx = new OfflineAudioContext(1, 1, 8000);
    const buf = await ctx.decodeAudioData(await file.arrayBuffer());
    const perSec = 50;
    const step = buf.sampleRate / perSec;
    const ch = buf.getChannelData(0);
    const ch2 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null;
    const peaks: number[] = [];
    for (let i = 0; i < ch.length; i += step) {
      let m = 0;
      const end = Math.min(ch.length, i + step);
      for (let j = Math.floor(i); j < end; j++) {
        const v = Math.max(Math.abs(ch[j]!), ch2 ? Math.abs(ch2[j]!) : 0);
        if (v > m) m = v;
      }
      peaks.push(Math.round(Math.min(1, m) * 255));
    }
    return peaks;
  } catch {
    return null;
  }
}

async function process(meta: StoredMeta, file: Blob) {
  const url = await blobUrl(meta.id);
  try {
    if (meta.kind === 'image') {
      const img = new Image();
      img.src = url;
      await img.decode();
      meta.width = img.naturalWidth;
      meta.height = img.naturalHeight;
    } else {
      const el = document.createElement(meta.kind === 'video' ? 'video' : 'audio');
      el.preload = 'metadata';
      el.src = url;
      await once(el, 'loadedmetadata');
      meta.duration = Number.isFinite(el.duration) ? el.duration : 0;
      if (el instanceof HTMLVideoElement) {
        meta.width = el.videoWidth;
        meta.height = el.videoHeight;
      }
      el.removeAttribute('src');
      const peaks = await makeWaveform(file);
      meta.hasAudio = !!peaks && peaks.some((p) => p > 2);
      if (peaks) {
        await idbPut('derived', `${WAVE_PREFIX}${meta.id}`, { perSec: 50, peaks });
        meta.hasWaveform = true;
      }
      if (meta.kind === 'video') {
        const th = await makeThumbs(url, meta.duration, meta.width, meta.height);
        if (th) {
          await idbPut('derived', `thumbs:${meta.id}`, th.blob);
          meta.thumbs = th.info;
        }
      }
    }
    meta.status = 'ready';
  } catch (e) {
    meta.status = 'error';
    meta.error = e instanceof Error ? e.message : String(e);
  }
  await idbPut('media', meta.id, meta);
}

/** Logos oficiais já embutidas no app + imagens de marca enviadas pelo usuário. */
const BUNDLED_BRAND: MediaAsset[] = [
  { id: 'brand:logo-horizontal', name: 'Logo horizontal', url: horizontalUrl, width: 1572, height: 516 },
  { id: 'brand:logo-normal', name: 'Logo normal', url: normalUrl, width: 1214, height: 1058 },
].map((b) => ({
  ...b,
  kind: 'image' as const,
  brand: true,
  duration: 0,
  fps: 0,
  hasAudio: false,
  status: 'ready' as const,
  thumbs: null,
  waveform: null,
  size: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
}));

async function ingest(file: File, onProgress: ((f: number) => void) | undefined, brand: boolean): Promise<MediaAsset> {
  const id = uid();
  onProgress?.(0.2);
  await idbPut('blobs', id, file);
  onProgress?.(1);
  const meta: StoredMeta = {
    id,
    name: file.name.slice(0, 120) || 'arquivo',
    kind: kindOf(file),
    brand,
    duration: 0,
    width: 0,
    height: 0,
    fps: 30,
    hasAudio: false,
    status: 'processing',
    thumbs: null,
    hasWaveform: false,
    size: file.size,
    createdAt: new Date().toISOString(),
  };
  await idbPut('media', id, meta);
  void process(meta, file);
  return toAsset(meta);
}

export const localMedia: MediaService = {
  async list() {
    const all = await idbAll<StoredMeta>('media');
    const lib = all.filter((m) => !m.brand);
    return Promise.all(lib.map(toAsset));
  },
  async get(id) {
    const m = await idbGet<StoredMeta>('media', id);
    if (!m) throw new Error('Mídia não encontrada.');
    return toAsset(m);
  },
  upload: (file, onProgress) => ingest(file, onProgress, false),
  async remove(id) {
    for (const k of [id]) {
      const u = objectUrls.get(k);
      if (u) URL.revokeObjectURL(u);
      objectUrls.delete(k);
    }
    await Promise.all([idbDelete('media', id), idbDelete('blobs', id), idbDelete('derived', `thumbs:${id}`), idbDelete('derived', `${WAVE_PREFIX}${id}`)]);
  },
  async brand() {
    const all = await idbAll<StoredMeta>('media');
    const mine = await Promise.all(all.filter((m) => m.brand && m.status === 'ready').map(toAsset));
    return [...BUNDLED_BRAND, ...mine];
  },
  async uploadBrand(file) {
    const asset = await ingest(file, undefined, true);
    // espera o processamento (dimensões) para a lista já vir pronta
    for (let i = 0; i < 50; i++) {
      const m = await idbGet<StoredMeta>('media', asset.id);
      if (m && m.status !== 'processing') break;
      await new Promise((r) => setTimeout(r, 100));
    }
  },
  async removeBrand(id) {
    if (BUNDLED_BRAND.some((b) => b.id === id)) return; // logos oficiais embutidas
    await localMedia.remove(id);
  },
  async waveform(url) {
    const data = await idbGet<{ perSec: number; peaks: number[] }>('derived', url);
    return data ?? { perSec: 50, peaks: [] };
  },
};
