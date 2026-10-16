/**
 * Serviço de mídia: armazena arquivos no disco, extrai metadados (ffprobe),
 * gera miniaturas, forma de onda e — quando o navegador não suporta o codec —
 * um proxy H.264 para o preview.
 */
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import type { MediaAsset } from '../src/core/model';
import { uid } from '../src/core/id';
import { BRAND_DIR, DERIVED_DIR, MEDIA_DIR } from './config';
import { getDb, now } from './db';
import { parseRate, probe, runOk, type ProbeResult } from './ffmpeg';

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif']);
const CONVERT_IMAGE_EXT = new Set(['.heic', '.heif', '.tif', '.tiff']);
const AUDIO_EXT = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.flac', '.wma', '.amr']);
const BROWSER_VIDEO = new Set(['h264', 'vp8', 'vp9', 'av1']);
const BROWSER_VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.webm']);
const BROWSER_AUDIO = new Set(['mp3', 'aac', 'opus', 'vorbis', 'flac', 'pcm_s16le', 'pcm_s24le', 'pcm_f32le']);

interface MediaRow {
  id: string;
  name: string;
  kind: MediaAsset['kind'];
  file: string;
  proxy: string | null;
  duration: number;
  width: number;
  height: number;
  fps: number;
  has_audio: number;
  status: MediaAsset['status'];
  error: string | null;
  thumbs: string | null;
  waveform: string | null;
  size: number;
  created_at: string;
}

function toAsset(r: MediaRow): MediaAsset {
  const thumbs = r.thumbs ? (JSON.parse(r.thumbs) as Omit<NonNullable<MediaAsset['thumbs']>, 'url'>) : null;
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    duration: r.duration,
    width: r.width,
    height: r.height,
    fps: r.fps,
    hasAudio: !!r.has_audio,
    url: `/api/media/${r.id}/file`,
    status: r.status,
    error: r.error ?? undefined,
    thumbs: thumbs ? { ...thumbs, url: `/api/media/${r.id}/thumbs` } : null,
    waveform: r.waveform ? `/api/media/${r.id}/waveform` : null,
    size: r.size,
    createdAt: r.created_at,
  };
}

export function listMedia(): MediaAsset[] {
  const rows = getDb().prepare('SELECT * FROM media ORDER BY created_at DESC').all() as unknown as MediaRow[];
  return rows.map(toAsset);
}

export function getMediaRow(id: string): MediaRow | undefined {
  return getDb().prepare('SELECT * FROM media WHERE id = ?').get(id) as unknown as MediaRow | undefined;
}

export function getMedia(id: string): MediaAsset | undefined {
  const r = getMediaRow(id);
  return r ? toAsset(r) : undefined;
}

/** Caminho do arquivo que o navegador deve reproduzir (proxy, se houver). */
export function playablePath(r: MediaRow): string {
  return path.join(MEDIA_DIR, r.proxy ?? r.file);
}

/** Caminho do arquivo original (melhor qualidade de áudio para a exportação). */
export function originalPath(r: MediaRow): string {
  return path.join(MEDIA_DIR, r.file);
}

export function derivedPath(id: string, name: string) {
  return path.join(DERIVED_DIR, `${id}-${name}`);
}

function update(id: string, fields: Partial<Omit<MediaRow, 'id'>>) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sql = `UPDATE media SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`;
  getDb()
    .prepare(sql)
    .run(...(keys.map((k) => (fields as Record<string, string | number | null>)[k] ?? null) as (string | number | null)[]), id);
}

export function safeName(name: string) {
  const base = path.basename(name).replace(/[^\p{L}\p{N}._ -]+/gu, '_').slice(0, 120);
  return base || 'arquivo';
}

/** Recebe o upload em streaming e devolve o registro criado (status "processing"). */
export async function ingestUpload(stream: Readable, originalName: string): Promise<MediaAsset> {
  const id = uid();
  const name = safeName(originalName);
  const ext = path.extname(name).toLowerCase() || '.bin';
  const file = `${id}${ext}`;
  const full = path.join(MEDIA_DIR, file);
  await pipeline(stream, createWriteStream(full));
  const size = statSync(full).size;
  if (size === 0) {
    unlinkSync(full);
    throw new Error('Arquivo vazio.');
  }
  const kind: MediaAsset['kind'] = IMAGE_EXT.has(ext) || CONVERT_IMAGE_EXT.has(ext) ? 'image' : AUDIO_EXT.has(ext) ? 'audio' : 'video';
  getDb()
    .prepare('INSERT INTO media (id, name, kind, file, status, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, name, kind, file, 'processing', size, now());
  // processamento em segundo plano: a resposta do upload volta imediatamente
  void processMedia(id).catch((e: unknown) => {
    update(id, { status: 'error', error: e instanceof Error ? e.message : String(e) });
  });
  return getMedia(id)!;
}

function mainStreams(info: ProbeResult) {
  const video = info.streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const audio = info.streams.find((s) => s.codec_type === 'audio');
  return { video, audio };
}

function rotationOf(s: { tags?: { rotate?: string }; side_data_list?: { rotation?: number }[] }): number {
  const r = s.side_data_list?.find((d) => typeof d.rotation === 'number')?.rotation ?? Number(s.tags?.rotate ?? 0);
  return Math.abs(Math.round(r)) % 180 === 90 ? 90 : 0;
}

export async function processMedia(id: string): Promise<void> {
  const row = getMediaRow(id);
  if (!row) return;
  const src = originalPath(row);
  const info = await probe(src);
  const { video, audio } = mainStreams(info);
  const ext = path.extname(row.file).toLowerCase();
  const duration = Number(info.format.duration ?? video?.duration ?? audio?.duration ?? 0) || 0;

  // Imagens (inclusive quando o ffprobe as vê como "vídeo" de 1 quadro)
  const isImage = row.kind === 'image' || (video && !audio && (duration === 0 || ['image2', 'png_pipe', 'jpeg_pipe', 'webp_pipe'].some((f) => info.format.format_name?.includes(f))));
  if (isImage) {
    let proxy: string | null = null;
    if (CONVERT_IMAGE_EXT.has(ext)) {
      proxy = `${id}-proxy.png`;
      await runOk('ffmpeg', ['-y', '-v', 'error', '-i', src, '-frames:v', '1', path.join(MEDIA_DIR, proxy)]);
    }
    update(id, { kind: 'image', width: video?.width ?? 0, height: video?.height ?? 0, proxy, status: 'ready', error: null });
    return;
  }

  if (!video && audio) {
    let proxy: string | null = null;
    if (!BROWSER_AUDIO.has(audio.codec_name ?? '')) {
      proxy = `${id}-proxy.m4a`;
      await runOk('ffmpeg', ['-y', '-v', 'error', '-i', src, '-vn', '-c:a', 'aac', '-b:a', '192k', path.join(MEDIA_DIR, proxy)]);
    }
    update(id, { kind: 'audio', duration, has_audio: 1, proxy });
    await makeWaveform(id, src);
    update(id, { status: 'ready', error: null });
    return;
  }

  if (!video) throw new Error('Arquivo sem trilha de vídeo ou áudio reconhecível.');

  const rot = rotationOf(video);
  // pixel não quadrado (SAR): a largura de exibição é largura × SAR
  const [sn, sd] = (video.sample_aspect_ratio ?? '1:1').split(':').map(Number);
  const sar = sn && sd ? sn / sd : 1;
  const dispW = Math.round((video.width ?? 0) * (sar > 0.1 && sar < 10 ? sar : 1));
  const w = rot ? (video.height ?? 0) : dispW;
  const h = rot ? dispW : (video.height ?? 0);
  const fps = parseRate(video.avg_frame_rate) || parseRate(video.r_frame_rate) || 30;
  update(id, { kind: 'video', duration, width: w, height: h, fps, has_audio: audio ? 1 : 0 });

  const needsProxy =
    !BROWSER_VIDEO.has(video.codec_name ?? '') ||
    !BROWSER_VIDEO_EXT.has(ext) ||
    !['yuv420p', 'yuvj420p'].includes(video.pix_fmt ?? '') ||
    (audio && !BROWSER_AUDIO.has(audio.codec_name ?? ''));
  if (needsProxy) {
    const proxy = `${id}-proxy.mp4`;
    await runOk('ffmpeg', [
      '-y', '-v', 'error', '-i', src,
      '-map', '0:v:0', '-map', '0:a:0?',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-g', '30',
      '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart',
      path.join(MEDIA_DIR, proxy),
    ]);
    update(id, { proxy });
  }
  await makeThumbs(id, src, duration);
  if (audio) await makeWaveform(id, src);
  update(id, { status: 'ready', error: null });
}

async function makeThumbs(id: string, src: string, duration: number) {
  const count = Math.max(1, Math.min(60, Math.ceil(duration)));
  const interval = Math.max(duration / count, 0.04);
  const height = 72;
  const out = derivedPath(id, 'thumbs.jpg');
  await runOk('ffmpeg', [
    '-y', '-v', 'error', '-i', src,
    '-vf', `fps=1/${interval.toFixed(4)},scale=-2:${height},tile=${count}x1`,
    '-frames:v', '1', '-q:v', '5', out,
  ]);
  const info = await probe(out);
  const total = info.streams[0]?.width ?? count * 128;
  update(id, { thumbs: JSON.stringify({ count, interval, width: Math.round(total / count), height }) });
}

async function makeWaveform(id: string, src: string) {
  const rate = 8000;
  const perSec = 50;
  const pcm = await runOk('ffmpeg', ['-v', 'error', '-i', src, '-vn', '-ac', '1', '-ar', String(rate), '-f', 's16le', 'pipe:1']);
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
  const bucket = rate / perSec;
  const peaks: number[] = [];
  for (let i = 0; i < samples.length; i += bucket) {
    let m = 0;
    const end = Math.min(samples.length, i + bucket);
    for (let j = i; j < end; j++) {
      const v = Math.abs(samples[j]!);
      if (v > m) m = v;
    }
    peaks.push(Math.round((m / 32768) * 255));
  }
  writeFileSync(derivedPath(id, 'waveform.json'), JSON.stringify({ perSec, peaks }));
  update(id, { waveform: 'waveform.json' });
}

export function deleteMedia(id: string) {
  const r = getMediaRow(id);
  if (!r) return;
  for (const f of [r.file, r.proxy]) {
    if (f && existsSync(path.join(MEDIA_DIR, f))) unlinkSync(path.join(MEDIA_DIR, f));
  }
  for (const n of ['thumbs.jpg', 'waveform.json']) {
    const p = derivedPath(id, n);
    if (existsSync(p)) unlinkSync(p);
  }
  getDb().prepare('DELETE FROM media WHERE id = ?').run(id);
}

// ---------------------------------------------------------------------------
// Pasta de marca: imagens fornecidas pela redação (logos, selos, molduras)
// ---------------------------------------------------------------------------

const brandCache = new Map<string, { mtime: number; w: number; h: number }>();

export async function listBrand(): Promise<MediaAsset[]> {
  if (!existsSync(BRAND_DIR)) return [];
  const files = readdirSync(BRAND_DIR).filter((f) => IMAGE_EXT.has(path.extname(f).toLowerCase()));
  const out: MediaAsset[] = [];
  for (const f of files) {
    const full = path.join(BRAND_DIR, f);
    const st = statSync(full);
    let dims = brandCache.get(f);
    if (!dims || dims.mtime !== st.mtimeMs) {
      try {
        const info = await probe(full);
        dims = { mtime: st.mtimeMs, w: info.streams[0]?.width ?? 0, h: info.streams[0]?.height ?? 0 };
        brandCache.set(f, dims);
      } catch {
        continue;
      }
    }
    out.push({
      id: `brand:${f}`,
      name: f.replace(/\.[^.]+$/, ''),
      kind: 'image',
      brand: true,
      duration: 0,
      width: dims.w,
      height: dims.h,
      fps: 0,
      hasAudio: false,
      url: `/api/brand/${encodeURIComponent(f)}`,
      status: 'ready',
      thumbs: null,
      waveform: null,
      size: st.size,
      createdAt: new Date(st.mtimeMs).toISOString(),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function brandFile(name: string): string | null {
  const safe = path.basename(name);
  const full = path.join(BRAND_DIR, safe);
  return existsSync(full) ? full : null;
}

/** "Exclui" uma imagem da pasta brand/: move para brand/.lixeira (nada é apagado de vez). */
export function trashBrandFile(name: string): boolean {
  const full = brandFile(name);
  if (!full) return false;
  const trash = path.join(BRAND_DIR, '.lixeira');
  mkdirSync(trash, { recursive: true });
  const base = path.basename(full);
  let dest = path.join(trash, base);
  if (existsSync(dest)) dest = path.join(trash, `${Date.now()}-${base}`);
  renameSync(full, dest);
  brandCache.delete(base);
  return true;
}

export async function saveBrandUpload(stream: Readable, originalName: string): Promise<string> {
  const name = safeName(originalName);
  const ext = path.extname(name).toLowerCase();
  if (!IMAGE_EXT.has(ext)) throw new Error('A pasta de marca aceita apenas imagens (PNG, JPG, WEBP...).');
  await pipeline(stream, createWriteStream(path.join(BRAND_DIR, name)));
  return name;
}
