/**
 * Decodificação de áudio por TRECHOS (sem carregar o arquivo inteiro):
 * usa o índice do MP4 + WebCodecs AudioDecoder. Serve para a mixagem da
 * exportação e para a forma de onda da importação, inclusive de vídeos longos.
 * Formatos que não são MP4 (mp3, wav...) usam o decodeAudioData do navegador,
 * só para arquivos de tamanho razoável.
 */
import { indexMp4, readSamples, type Mp4Index, type Mp4Track } from './mp4index';

export interface Pcm {
  sampleRate: number;
  channels: Float32Array[];
  /** instante (s, tempo do arquivo) da primeira amostra */
  start: number;
}

/** limite para decodificar o arquivo inteiro de uma vez (formatos sem índice) */
export const WHOLE_DECODE_LIMIT = 60 * 1024 * 1024;

const indexCache = new WeakMap<Blob, Promise<Mp4Index | null>>();
export function cachedIndex(blob: Blob): Promise<Mp4Index | null> {
  let p = indexCache.get(blob);
  if (!p) {
    p = indexMp4(blob);
    indexCache.set(blob, p);
  }
  return p;
}

async function supported(track: Mp4Track): Promise<AudioDecoderConfig | null> {
  if (typeof AudioDecoder === 'undefined') return null;
  const cfg: AudioDecoderConfig = { codec: track.codec, sampleRate: track.sampleRate || 48000, numberOfChannels: track.channels || 2, description: track.description };
  try {
    const r = await AudioDecoder.isConfigSupported(cfg);
    return r.supported ? cfg : null;
  } catch {
    return null;
  }
}

const secOf = (track: Mp4Track, i: number) => (track.samples[i]!.cts - track.editOffset) / track.timescale;

/** Espera a fila do decodificador baixar (com rede de segurança por tempo). */
function drain(dec: AudioDecoder, max: number): Promise<void> {
  if (dec.decodeQueueSize <= max) return Promise.resolve();
  return new Promise((resolve) => {
    const check = () => {
      if (dec.decodeQueueSize <= max || dec.state === 'closed') {
        clearInterval(timer);
        dec.removeEventListener('dequeue', check);
        resolve();
      }
    };
    const timer = setInterval(check, 15);
    dec.addEventListener('dequeue', check);
  });
}

/**
 * Decodifica [t0, t1] segundos da trilha de áudio. Devolve null se o aparelho
 * não decodificar esse áudio.
 */
export async function decodeAudioRange(blob: Blob, track: Mp4Track, t0: number, t1: number): Promise<Pcm | null> {
  const cfg = await supported(track);
  if (!cfg) return null;
  const n = track.samples.length;
  // um pouco antes (pré-rolagem do AAC) e um pouco depois
  let from = 0;
  while (from < n - 1 && secOf(track, from + 1) <= t0 - 0.05) from++;
  from = Math.max(0, from - 2);
  let to = from;
  while (to < n && secOf(track, to) < t1 + 0.05) to++;
  if (to <= from) return null;

  const chunks: AudioData[] = [];
  let failed = false;
  const dec = new AudioDecoder({ output: (d) => chunks.push(d), error: () => (failed = true) });
  dec.configure(cfg);
  try {
    for (let i = from; i < to && !failed; ) {
      const j = Math.min(to, i + 256);
      const data = await readSamples(blob, track.samples, i, j);
      for (let k = i; k < j; k++) {
        const s = track.samples[k]!;
        dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round(secOf(track, k) * 1e6), duration: Math.round((s.dur / track.timescale) * 1e6), data: data.get(k)! }));
      }
      await drain(dec, 64);
      i = j;
    }
    await dec.flush();
  } catch {
    failed = true;
  } finally {
    if (dec.state !== 'closed') dec.close();
  }
  if (failed || !chunks.length) {
    for (const c of chunks) c.close();
    return null;
  }
  const sr = chunks[0]!.sampleRate;
  const nch = Math.min(2, chunks[0]!.numberOfChannels);
  const first = chunks[0]!.timestamp / 1e6;
  const last = chunks[chunks.length - 1]!;
  const total = Math.ceil((last.timestamp / 1e6 - first) * sr) + last.numberOfFrames;
  const out = Array.from({ length: nch }, () => new Float32Array(total));
  for (const c of chunks) {
    const at = Math.max(0, Math.round((c.timestamp / 1e6 - first) * sr));
    const frames = Math.min(c.numberOfFrames, total - at);
    for (let ch = 0; ch < nch; ch++) {
      const tmp = new Float32Array(c.numberOfFrames);
      try {
        c.copyTo(tmp, { planeIndex: Math.min(ch, c.numberOfChannels - 1), format: 'f32-planar' });
      } catch {
        tmp.fill(0);
      }
      out[ch]!.set(tmp.subarray(0, frames), at);
    }
    c.close();
  }
  return { sampleRate: sr, channels: out, start: first };
}

/**
 * Picos de volume para a forma de onda (perSec por segundo, 0..255), lendo e
 * decodificando o áudio aos poucos. null se não der para decodificar.
 */
export async function audioPeaks(blob: Blob, track: Mp4Track, perSec = 50): Promise<number[] | null> {
  const cfg = await supported(track);
  if (!cfg) return null;
  const peaks: number[] = [];
  let failed = false;
  const dec = new AudioDecoder({
    output: (d) => {
      try {
        const sr = d.sampleRate;
        const tmp = new Float32Array(d.numberOfFrames);
        d.copyTo(tmp, { planeIndex: 0, format: 'f32-planar' });
        const t0 = d.timestamp / 1e6;
        for (let i = 0; i < tmp.length; i++) {
          const slot = Math.floor((t0 + i / sr) * perSec);
          if (slot < 0) continue;
          const v = Math.min(255, Math.round(Math.abs(tmp[i]!) * 255));
          if ((peaks[slot] ?? 0) < v) peaks[slot] = v;
        }
      } finally {
        d.close();
      }
    },
    error: () => (failed = true),
  });
  dec.configure(cfg);
  try {
    const n = track.samples.length;
    for (let i = 0; i < n && !failed; ) {
      const j = Math.min(n, i + 512);
      const data = await readSamples(blob, track.samples, i, j);
      for (let k = i; k < j; k++) {
        const s = track.samples[k]!;
        dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round(secOf(track, k) * 1e6), duration: Math.round((s.dur / track.timescale) * 1e6), data: data.get(k)! }));
      }
      await drain(dec, 64);
      i = j;
    }
    await dec.flush();
  } catch {
    failed = true;
  } finally {
    if (dec.state !== 'closed') dec.close();
  }
  if (failed) return null;
  for (let i = 0; i < peaks.length; i++) peaks[i] ??= 0;
  return peaks;
}
