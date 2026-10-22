/**
 * Exportação 100% local (celular e navegador), sem servidor e sem FFmpeg:
 * - quadros: o mesmo `renderFrame` do preview → VideoEncoder (H.264 do aparelho);
 * - áudio: mixado num OfflineAudioContext com o MESMO plano do player
 *   (buildAudioPlan: início, trecho, velocidade, volume, fades) → AudioEncoder;
 * - contêiner: MP4 montado em JavaScript (mp4-muxer).
 */
import { ArrayBufferTarget, Muxer, StreamTarget } from 'mp4-muxer';
import type { MediaAsset, Project } from '../core/model';
import { buildAudioPlan } from '../core/audio';
import { renderFrame } from '../render/renderer';
import { ensureFonts } from '../render/fonts';
import { ensureBrandAssets } from '../render/brandAssets';
import { exportFileName, type ExportProgress, type ExportSettings, type Exporter } from '../platform/types';
import { prepareFrameSource } from './frameSource';
import { createPitchShifter } from './pitchShifter';
import { abortable, abortError, throwIfAborted, waitQueue } from './abortable';
import { cachedIndex, decodeAudioRange, WHOLE_DECODE_LIMIT, type Pcm } from './audioDecode';
import { timeStretch } from './timeStretch';
import { mediaBlob } from '../platform/mediaBlob';

const SAMPLE_RATE = 48000;

/** Escolhe um perfil H.264 que o aparelho saiba codificar nesse tamanho. */
async function pickVideoConfig(width: number, height: number, fps: number, bitrate: number): Promise<VideoEncoderConfig | null> {
  const codecs = fps > 30 ? ['avc1.64002a', 'avc1.4d002a', 'avc1.640033'] : ['avc1.640028', 'avc1.4d0028', 'avc1.640033', 'avc1.42e028', 'avc1.42e01f'];
  for (const codec of codecs) {
    for (const hardwareAcceleration of ['prefer-hardware', 'no-preference'] as const) {
      const cfg: VideoEncoderConfig = { codec, width, height, bitrate, framerate: fps, hardwareAcceleration, avc: { format: 'avc' } };
      try {
        const r = await VideoEncoder.isConfigSupported(cfg);
        if (r.supported) return cfg;
      } catch {
        /* tenta o próximo */
      }
    }
  }
  return null;
}

async function pickAudioConfig(): Promise<{ cfg: AudioEncoderConfig; muxCodec: 'aac' | 'opus' } | null> {
  if (typeof AudioEncoder === 'undefined') return null;
  const tries: [string, 'aac' | 'opus'][] = [
    ['mp4a.40.2', 'aac'],
    ['opus', 'opus'],
  ];
  for (const [codec, muxCodec] of tries) {
    const cfg: AudioEncoderConfig = { codec, sampleRate: SAMPLE_RATE, numberOfChannels: 2, bitrate: 192_000 };
    try {
      const r = await AudioEncoder.isConfigSupported(cfg);
      if (r.supported) return { cfg, muxCodec };
    } catch {
      /* tenta o próximo */
    }
  }
  return null;
}

/** Mixagem antiga (arquivo inteiro na memória): reserva para projetos curtos. */
async function mixAudioWhole(project: Project, media: Record<string, MediaAsset>, duration: number): Promise<AudioBuffer | null> {
  const plan = buildAudioPlan(project);
  if (!plan.length) return null;
  const length = Math.max(1, Math.ceil(duration * SAMPLE_RATE));
  const ctx = new OfflineAudioContext(2, length, SAMPLE_RATE);
  const decoded = new Map<string, AudioBuffer | null>();
  for (const seg of plan) {
    if (!decoded.has(seg.mediaId)) {
      const m = media[seg.mediaId];
      let buf: AudioBuffer | null = null;
      if (m) {
        try {
          const data = await (await fetch(m.url)).arrayBuffer();
          buf = await ctx.decodeAudioData(data);
        } catch {
          buf = null; // vídeo sem trilha de áudio decodificável
        }
      }
      decoded.set(seg.mediaId, buf);
    }
    const buf = decoded.get(seg.mediaId);
    if (!buf) continue;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = seg.speed;
    const gain = ctx.createGain();
    const end = seg.start + seg.duration;
    const g = gain.gain;
    g.setValueAtTime(seg.fadeIn > 0 ? 0 : seg.volume, seg.start);
    if (seg.fadeIn > 0) g.linearRampToValueAtTime(seg.volume, seg.start + seg.fadeIn);
    if (seg.fadeOut > 0) {
      g.setValueAtTime(seg.volume, Math.max(seg.start, end - seg.fadeOut));
      g.linearRampToValueAtTime(0, end);
    }
    if (Math.abs(seg.pitch - 1) > 1e-3) {
      // disfarce de voz (mesmo efeito do preview)
      const shifter = createPitchShifter(ctx, seg.pitch, seg.start);
      src.connect(shifter.input);
      shifter.output.connect(gain);
    } else {
      src.connect(gain);
    }
    gain.connect(ctx.destination);
    src.start(seg.start, seg.sourceIn, seg.duration * seg.speed);
  }
  return ctx.startRendering();
}


type RangeReader = (t0: number, t1: number) => Promise<Pcm | null>;

/** Leitor de trechos de áudio de uma mídia, sem carregar o arquivo inteiro. */
async function audioReader(m: MediaAsset): Promise<RangeReader | null> {
  const blob = await mediaBlob(m);
  const idx = await cachedIndex(blob);
  let whole: Promise<Pcm | null> | null = null;
  const decodeWhole = () => {
    whole ??= (async () => {
      if (blob.size > WHOLE_DECODE_LIMIT) return null;
      try {
        const ctx = new OfflineAudioContext(2, 1, SAMPLE_RATE);
        const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
        const channels = Array.from({ length: Math.min(2, buf.numberOfChannels) }, (_, c) => buf.getChannelData(c));
        return { sampleRate: buf.sampleRate, channels, start: 0 };
      } catch {
        return null;
      }
    })();
    return whole;
  };
  const slice = (p: Pcm, t0: number, t1: number): Pcm => {
    const a = Math.max(0, Math.floor((t0 - p.start) * p.sampleRate));
    const b = Math.min(p.channels[0]!.length, Math.ceil((t1 - p.start) * p.sampleRate));
    return { sampleRate: p.sampleRate, channels: p.channels.map((c) => c.subarray(a, Math.max(a, b))), start: p.start + a / p.sampleRate };
  };
  if (idx?.audio) {
    const track = idx.audio;
    return async (t0, t1) => {
      const r = await decodeAudioRange(blob, track, t0, t1);
      if (r) return r;
      const w = await decodeWhole();
      return w ? slice(w, t0, t1) : null;
    };
  }
  if (idx && !idx.audio) return null; // MP4 sem trilha de áudio
  return async (t0, t1) => {
    const w = await decodeWhole();
    return w ? slice(w, t0, t1) : null;
  };
}

const WINDOW_S = 20;

/**
 * Mixa o áudio em janelas de 20 s e entrega cada janela pronta (`onWindow`).
 * A memória fica pequena mesmo em vídeos longos, e a mudança de velocidade
 * preserva o tom da voz (igual ao player): só o "Disfarçar voz" muda o tom.
 */
export async function mixAudioWindows(
  project: Project,
  media: Record<string, MediaAsset>,
  duration: number,
  onWindow: (buf: AudioBuffer, startSec: number) => Promise<void>,
  signal: AbortSignal,
): Promise<boolean> {
  const plan = buildAudioPlan(project);
  if (!plan.length) return false;
  const readers = new Map<string, Promise<RangeReader | null>>();
  const reader = (id: string) => {
    let r = readers.get(id);
    if (!r) {
      const m = media[id];
      r = m ? audioReader(m).catch(() => null) : Promise.resolve(null);
      readers.set(id, r);
    }
    return r;
  };
  for (let w0 = 0; w0 < duration - 1e-6; w0 += WINDOW_S) {
    throwIfAborted(signal);
    const w1 = Math.min(duration, w0 + WINDOW_S);
    const len = Math.max(1, Math.round((w1 - w0) * SAMPLE_RATE));
    const ctx = new OfflineAudioContext(2, len, SAMPLE_RATE);
    for (const seg of plan) {
      const segEnd = seg.start + seg.duration;
      const a = Math.max(seg.start, w0);
      const b = Math.min(segEnd, w1);
      if (b - a < 1e-4) continue;
      const read = await reader(seg.mediaId);
      if (!read) continue;
      const srcA = seg.sourceIn + (a - seg.start) * seg.speed;
      const srcB = seg.sourceIn + (b - seg.start) * seg.speed;
      const margin = 0.3;
      const pcm = await read(Math.max(0, srcA - margin), srcB + margin);
      if (!pcm || !pcm.channels[0]?.length) continue;
      let chans = pcm.channels;
      if (Math.abs(seg.speed - 1) > 1e-3) {
        try {
          chans = timeStretch(chans, seg.speed, pcm.sampleRate);
        } catch {
          chans = pcm.channels; // reserva: sem esticar
        }
      }
      const stretched = chans !== pcm.channels || Math.abs(seg.speed - 1) <= 1e-3;
      const rate = stretched ? 1 : seg.speed;
      const buf = ctx.createBuffer(2, chans[0]!.length, pcm.sampleRate);
      buf.copyToChannel(chans[0]! as Float32Array<ArrayBuffer>, 0);
      buf.copyToChannel((chans[1] ?? chans[0]!) as Float32Array<ArrayBuffer>, 1);
      // instante da timeline em que o início do trecho decodificado toca
      const tl0 = a - (srcA - pcm.start) / seg.speed;
      let when = tl0 - w0;
      let offset = 0;
      if (when < 0) {
        offset = (-when * seg.speed) / (stretched ? seg.speed : 1);
        when = 0;
      }
      const playFor = b - w0 - when;
      if (playFor <= 0) continue;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = rate;
      const gain = ctx.createGain();
      const volAt = (t: number) => {
        const fi = seg.fadeIn > 0 ? Math.min(1, Math.max(0, (t - seg.start) / seg.fadeIn)) : 1;
        const fo = seg.fadeOut > 0 ? Math.min(1, Math.max(0, (segEnd - t) / seg.fadeOut)) : 1;
        return seg.volume * Math.min(fi, fo);
      };
      const g = gain.gain;
      g.setValueAtTime(volAt(a), a - w0);
      const bps = [seg.start + seg.fadeIn, segEnd - seg.fadeOut, b].filter((x) => x > a && x <= b).sort((x, y) => x - y);
      for (const bp of bps) g.linearRampToValueAtTime(volAt(bp), bp - w0);
      if (Math.abs(seg.pitch - 1) > 1e-3) {
        // disfarce de voz (mesmo efeito do preview)
        const shifter = createPitchShifter(ctx, seg.pitch, when);
        src.connect(shifter.input);
        shifter.output.connect(gain);
      } else {
        src.connect(gain);
      }
      gain.connect(ctx.destination);
      src.start(when, offset, playFor * rate);
    }
    const out = await abortable(ctx.startRendering(), signal);
    await onWindow(out, w0);
  }
  return true;
}

/**
 * Destino do MP4 que vai sendo gravado em partes (Blob), sem juntar tudo na
 * memória. As poucas regravações (cabeçalho no início) ficam num bloco inicial.
 */
class BlobSink {
  private static readonly HEAD = 8 * 1024 * 1024;
  private head = new Uint8Array(BlobSink.HEAD);
  private headLen = 0;
  private parts: Blob[] = [];
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private end = BlobSink.HEAD;
  write(data: Uint8Array, pos: number) {
    if (pos < BlobSink.HEAD) {
      const n = Math.min(data.length, BlobSink.HEAD - pos);
      this.head.set(data.subarray(0, n), pos);
      this.headLen = Math.max(this.headLen, pos + n);
      if (n < data.length) this.write(data.subarray(n), pos + n);
      return;
    }
    if (pos !== this.end) throw new Error('Gravação fora de ordem no MP4.');
    this.pending.push(data.slice());
    this.pendingBytes += data.length;
    this.end += data.length;
    if (this.pendingBytes >= 16 * 1024 * 1024) this.flushPending();
  }
  private flushPending() {
    if (!this.pending.length) return;
    this.parts.push(new Blob(this.pending as BlobPart[]));
    this.pending = [];
    this.pendingBytes = 0;
  }
  blob(): Blob {
    this.flushPending();
    const head = this.end > BlobSink.HEAD ? this.head : this.head.subarray(0, this.headLen);
    return new Blob([head as BlobPart, ...this.parts], { type: 'video/mp4' });
  }
}

/** O navegador recolheu o codec por inatividade (recuperável recriando-o). */
function isReclaim(e: Error | null): boolean {
  return !!e && (/reclaim/i.test(e.message) || e.name === 'QuotaExceededError');
}

const BITRATE: Record<number, number> = { 16: 12_000_000, 19: 8_000_000, 24: 4_500_000 };

export async function exportWithWebCodecs(
  project: Project,
  media: Record<string, MediaAsset>,
  settings: ExportSettings,
  onProgress: (p: ExportProgress) => void,
  signal: AbortSignal,
): Promise<{ blob: Blob; fileName: string }> {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
    throw new Error('Este aparelho não tem o codificador de vídeo (WebCodecs). Atualize o Android System WebView/Chrome.');
  }
  onProgress({ phase: 'preparing', frame: 0, total: 0, fps: 0 });
  await Promise.all([ensureFonts(), ensureBrandAssets()]);

  const fps = settings.fps;
  const pixels = settings.width * settings.height;
  const bitrate = Math.round((BITRATE[settings.crf] ?? 8_000_000) * Math.min(1.4, Math.max(0.4, pixels / (1080 * 1920))));
  let width = settings.width;
  let height = settings.height;
  let vcfg = await pickVideoConfig(width, height, fps, bitrate);
  if (!vcfg) {
    // aparelho não codifica nesse tamanho: cai para 720p mantendo a proporção
    const k = 720 / Math.min(width, height);
    width = Math.round((width * k) / 2) * 2;
    height = Math.round((height * k) / 2) * 2;
    vcfg = await pickVideoConfig(width, height, fps, Math.round(bitrate * 0.55));
  }
  if (!vcfg) throw new Error('O codificador H.264 deste aparelho não aceitou o formato do vídeo.');

  throwIfAborted(signal);
  const hasAudio = buildAudioPlan(project).length > 0;
  const acfg = hasAudio ? await pickAudioConfig() : null;
  const total = Math.max(1, Math.round(settings.duration * fps));

  // MP4 gravado em partes (memória baixa); se não der, monta na memória como antes
  const sink = new BlobSink();
  let streamed = true;
  const makeMuxer = (stream: boolean) =>
    new Muxer({
      target: stream ? new StreamTarget({ onData: (data, pos) => sink.write(data, pos) }) : new ArrayBufferTarget(),
      video: { codec: 'avc', width, height, frameRate: fps },
      ...(acfg ? { audio: { codec: acfg.muxCodec, numberOfChannels: 2, sampleRate: SAMPLE_RATE } } : {}),
      fastStart: stream ? { expectedVideoChunks: total + 16, expectedAudioChunks: acfg ? Math.ceil(settings.duration * 50) + 64 : 0 } : 'in-memory',
      firstTimestampBehavior: 'offset',
    });
  let muxer: Muxer<ArrayBufferTarget | StreamTarget>;
  try {
    muxer = makeMuxer(true);
  } catch {
    streamed = false;
    muxer = makeMuxer(false);
  }

  let encodeError: Error | null = null;
  // prepara os vídeos ANTES de ligar o codificador: o navegador recolhe
  // codificadores ociosos ("Codec reclaimed due to inactivity")
  const src = await prepareFrameSource(project, media);
  if (signal.aborted) {
    src.dispose();
    throw abortError();
  }
  const makeEncoder = () => {
    const enc = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (e) => (encodeError = e instanceof Error ? e : new Error(String(e))),
    });
    enc.configure(vcfg);
    return enc;
  };
  let venc = makeEncoder();
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false })!;
  const frameUs = 1e6 / fps;
  const t0 = performance.now();

  try {
    for (let i = 0; i < total; i++) {
      throwIfAborted(signal);
      const t = i / fps;
      await abortable(src.seek(t), signal);
      renderFrame(ctx, project, t, src.sources, { editorHints: false });
      let forceKey = false;
      if (encodeError || venc.state === 'closed') {
        // codificador recolhido pelo navegador: recria e continua a partir deste quadro
        if (!isReclaim(encodeError) && venc.state !== 'closed') throw encodeError;
        encodeError = null;
        if (venc.state !== 'closed') venc.close();
        venc = makeEncoder();
        forceKey = true;
      }
      const frame = new VideoFrame(canvas, { timestamp: Math.round(i * frameUs), duration: Math.round(frameUs) });
      venc.encode(frame, { keyFrame: forceKey || i % (fps * 2) === 0 });
      frame.close();
      // controla a fila do codificador para não estourar a memória do aparelho
      await waitQueue(venc, 6, signal);
      const elapsed = (performance.now() - t0) / 1000;
      onProgress({ phase: 'rendering', frame: i + 1, total, fps: (i + 1) / Math.max(elapsed, 0.001) });
    }
    await abortable(venc.flush(), signal);
    if (encodeError) throw encodeError;
    onProgress({ phase: 'encoding', frame: total, total, fps: 0 });

    if (acfg) {
      const aenc = new AudioEncoder({
        output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
        error: (e) => (encodeError = e instanceof Error ? e : new Error(String(e))),
      });
      aenc.configure(acfg.cfg);
      const encodeBuffer = async (buf: AudioBuffer, startSec: number) => {
        const L = buf.getChannelData(0);
        const R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
        const base = Math.round(startSec * SAMPLE_RATE);
        const block = 4096;
        for (let off = 0; off < buf.length; off += block) {
          const n = Math.min(block, buf.length - off);
          const planar = new Float32Array(n * 2);
          planar.set(L.subarray(off, off + n), 0);
          planar.set(R.subarray(off, off + n), n);
          const data = new AudioData({
            format: 'f32-planar',
            sampleRate: SAMPLE_RATE,
            numberOfFrames: n,
            numberOfChannels: 2,
            timestamp: Math.round(((base + off) / SAMPLE_RATE) * 1e6),
            data: planar,
          });
          aenc.encode(data);
          data.close();
          await waitQueue(aenc, 16, signal);
          if (encodeError) throw encodeError;
        }
      };
      try {
        try {
          await mixAudioWindows(project, media, settings.duration, encodeBuffer, signal);
        } catch (e) {
          if ((e as Error).name === 'AbortError') throw e;
          // reserva: mixagem antiga (só para vídeos curtos, que cabem na memória)
          if (settings.duration > 120) throw new Error('Não foi possível mixar o áudio deste vídeo.');
          const whole = await abortable(mixAudioWhole(project, media, settings.duration), signal);
          if (whole) await encodeBuffer(whole, 0);
        }
        await abortable(aenc.flush(), signal);
      } finally {
        if (aenc.state !== 'closed') aenc.close();
      }
      if (encodeError) throw encodeError;
    }
    muxer.finalize();
    onProgress({ phase: 'done', frame: total, total, fps: 0 });
    const blob = streamed ? sink.blob() : new Blob([(muxer.target as ArrayBufferTarget).buffer], { type: 'video/mp4' });
    return { blob, fileName: exportFileName(project.name) };
  } finally {
    if (venc.state !== 'closed') venc.close();
    src.dispose();
  }
}

export const localExporter: Exporter = { exportVideo: exportWithWebCodecs };
