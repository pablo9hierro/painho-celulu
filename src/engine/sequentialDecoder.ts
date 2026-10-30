/**
 * Decodificação SEQUENCIAL para a exportação.
 *
 * Posicionar um <video> quadro a quadro obriga o aparelho a redecodificar desde
 * o último quadro-chave a cada quadro (muito lento em vídeos de celular). Aqui o
 * MP4 é entregue em ordem ao decodificador de hardware (WebCodecs VideoDecoder).
 * O quadro devolvido para o instante t é o mesmo que o <video> mostraria em t.
 *
 * Memória: o arquivo NÃO é carregado inteiro. Lê-se só o índice (mp4index) e os
 * dados das amostras em pequenos blocos, sob demanda — vídeos longos funcionam
 * no celular. Se o índice falhar (MP4 fragmentado etc.), usa o mp4box com o
 * arquivo inteiro apenas para arquivos pequenos; senão devolve null e a
 * exportação usa o <video> (mais lento, mas sem estourar a memória).
 */
import MP4Box, { type MP4Sample, type MP4VideoTrack } from 'mp4box';
import type { MediaAsset } from '../core/model';
import { mediaBlob } from '../platform/mediaBlob';
import { indexMp4, readSamples, type Mp4Sample, type Mp4Track } from './mp4index';

interface Meta {
  /** tempo de apresentação em microssegundos */
  ts: number;
  dur: number;
  key: boolean;
}

/** limite do caminho antigo (arquivo inteiro na memória) */
const MEMORY_DEMUX_LIMIT = 200 * 1024 * 1024;
const READ_AHEAD = 48;

function description(file: ReturnType<typeof MP4Box.createFile>, track: MP4VideoTrack): Uint8Array | undefined {
  const trak = file.getTrackById(track.id);
  for (const entry of trak.mdia.minf.stbl.stsd.entries) {
    const box = entry.avcC ?? entry.hvcC ?? entry.vpcC ?? entry.av1C;
    if (box) {
      const stream = new MP4Box.DataStream(undefined, 0, MP4Box.DataStream.BIG_ENDIAN);
      box.write(stream);
      return new Uint8Array(stream.buffer, 8); // remove o cabeçalho da caixa
    }
  }
  return undefined;
}

function rotationOfMatrix(m: ArrayLike<number>): number {
  const a = (m[0] ?? 65536) / 65536;
  const b = (m[1] ?? 0) / 65536;
  const deg = Math.round((Math.atan2(b, a) * 180) / Math.PI / 90) * 90;
  return ((deg % 360) + 360) % 360;
}

/** Fonte das amostras: índice + leitura parcial, ou tudo na memória (caminho antigo). */
type Source =
  | { kind: 'index'; blob: Blob; track: Mp4Track }
  | { kind: 'mem'; data: Uint8Array[] };

export interface Demuxed {
  meta: Meta[];
  source: Source;
  config: VideoDecoderConfig;
  rotation: number;
}

function memoryDemux(buffer: ArrayBuffer): Promise<Demuxed | null> {
  return new Promise((resolve) => {
    const file = MP4Box.createFile();
    let track: MP4VideoTrack | null = null;
    const meta: Meta[] = [];
    const data: Uint8Array[] = [];
    file.onError = () => resolve(null);
    file.onReady = (info) => {
      track = info.videoTracks[0] ?? null;
      if (!track) return resolve(null);
      file.setExtractionOptions(track.id, null, { nbSamples: Infinity });
      file.start();
    };
    file.onSamples = (_id, _u, list: MP4Sample[]) => {
      for (const s of list) {
        meta.push({ ts: (s.cts * 1e6) / s.timescale, dur: (s.duration * 1e6) / s.timescale, key: s.is_sync });
        data.push(s.data);
      }
    };
    const ab = buffer as ArrayBuffer & { fileStart: number };
    ab.fileStart = 0;
    try {
      file.appendBuffer(ab);
      file.flush();
    } catch {
      return resolve(null);
    }
    if (!track || !meta.length) return resolve(null);
    const t = track as MP4VideoTrack;
    resolve({
      meta,
      source: { kind: 'mem', data },
      config: {
        codec: t.codec.startsWith('vp08') ? 'vp8' : t.codec,
        codedWidth: t.video.width,
        codedHeight: t.video.height,
        description: description(file, t),
        hardwareAcceleration: 'no-preference',
      },
      rotation: rotationOfMatrix(t.matrix),
    });
  });
}

async function demux(m: MediaAsset): Promise<Demuxed | null> {
  const blob = await mediaBlob(m);
  const idx = await indexMp4(blob);
  const track = idx?.video;
  if (track) {
    const ts = track.timescale;
    return {
      meta: track.samples.map((s: Mp4Sample) => ({ ts: (s.cts * 1e6) / ts, dur: (s.dur * 1e6) / ts, key: s.sync })),
      source: { kind: 'index', blob, track },
      config: { codec: track.codec, codedWidth: track.width, codedHeight: track.height, description: track.description, hardwareAcceleration: 'no-preference' },
      rotation: track.rotation,
    };
  }
  if (blob.size > MEMORY_DEMUX_LIMIT) return null;
  return memoryDemux(await blob.arrayBuffer());
}

export class SequentialDecoder {
  private decoder!: VideoDecoder;
  private queue: VideoFrame[] = [];
  private current: VideoFrame | null = null;
  private next = 0;
  private flushed = false;
  private flushing = false;
  private wake: (() => void) | null = null;
  private error: Error | null = null;
  private lastTarget = -Infinity;
  private canvas: HTMLCanvasElement | null = null;
  /** apresentação do 1º quadro: o <video> considera esse instante como 0 */
  private origin: number;
  /** fim do último quadro do arquivo (µs) */
  private lastTs: number;
  /** dados já lidos à frente (índice → bytes) */
  private ahead = new Map<number, Uint8Array>();
  private gen = 0;

  private constructor(private readonly d: Demuxed) {
    let o = Infinity;
    let fim = -Infinity;
    for (const s of d.meta) {
      if (s.ts < o) o = s.ts;
      if (s.ts + s.dur > fim) fim = s.ts + s.dur;
    }
    this.origin = o;
    this.lastTs = fim;
    this.createDecoder();
  }

  /** `cache`: índice compartilhado entre trechos do mesmo vídeo */
  static async create(m: MediaAsset, cache?: Map<string, Promise<Demuxed | null>>): Promise<SequentialDecoder | null> {
    if (typeof VideoDecoder === 'undefined') return null;
    try {
      let p = cache?.get(m.id);
      if (!p) {
        p = demux(m).catch(() => null);
        cache?.set(m.id, p);
      }
      const d = await p;
      if (!d) return null;
      const sup = await VideoDecoder.isConfigSupported(d.config);
      if (!sup.supported) return null;
      return new SequentialDecoder(d);
    } catch {
      return null;
    }
  }

  private createDecoder() {
    this.decoder = new VideoDecoder({
      output: (f) => {
        this.queue.push(f);
        this.wake?.();
      },
      error: (e) => {
        this.error = e instanceof Error ? e : new Error(String(e));
        this.wake?.();
      },
    });
    this.decoder.configure(this.d.config);
  }

  /** Bytes da amostra `i` (lê um bloco à frente quando precisa). */
  private async dataFor(i: number): Promise<Uint8Array> {
    const src = this.d.source;
    if (src.kind === 'mem') return src.data[i]!;
    let b = this.ahead.get(i);
    if (!b) {
      this.ahead = await readSamples(src.blob, src.track.samples, i, Math.min(this.d.meta.length, i + READ_AHEAD));
      b = this.ahead.get(i)!;
    }
    this.ahead.delete(i);
    return b;
  }

  /** Recomeça a decodificação a partir do quadro-chave anterior a `target`. */
  private restart(target: number) {
    this.gen++;
    if (this.decoder.state !== 'closed') this.decoder.close();
    for (const f of this.queue) f.close();
    this.queue = [];
    this.current?.close();
    this.current = null;
    this.flushed = false;
    this.flushing = false;
    this.ahead.clear();
    let k = 0;
    const meta = this.d.meta;
    for (let i = 0; i < meta.length; i++) {
      const s = meta[i]!;
      if (s.key && s.ts <= target) k = i;
    }
    this.next = k;
    this.createDecoder();
  }

  /** Quadro que o <video> mostraria no instante `t` (segundos do arquivo). */
  async frameAt(t: number): Promise<CanvasImageSource | null> {
    const target = this.origin + t * 1e6 + 500; // meio milissegundo de tolerância
    if (target < this.lastTarget - 1000 || this.lastTarget === -Infinity) this.restart(target);
    this.lastTarget = target;
    const meta = this.d.meta;
    for (;;) {
      if (this.error) {
        // o navegador recolhe decodificadores ociosos: recria a partir deste ponto
        if (!/reclaim/i.test(this.error.message) && this.error.name !== 'QuotaExceededError') throw this.error;
        this.error = null;
        this.restart(target);
      }
      // avança pelos quadros já decodificados que pertencem a este instante
      while (this.queue.length && this.queue[0]!.timestamp <= target) {
        this.current?.close();
        this.current = this.queue.shift()!;
      }
      if (this.queue.length) break; // o próximo quadro já é posterior a t
      if (this.flushed && this.decoder.decodeQueueSize === 0 && !this.queue.length) break; // fim do arquivo
      // alimenta o decodificador mantendo uma fila curta
      const gen = this.gen;
      while (this.next < meta.length && this.decoder.decodeQueueSize < 12) {
        const i = this.next;
        const data = await this.dataFor(i);
        if (gen !== this.gen || this.decoder.state === 'closed') break;
        this.next = i + 1;
        const s = meta[i]!;
        this.decoder.decode(new EncodedVideoChunk({ type: s.key ? 'key' : 'delta', timestamp: s.ts, duration: s.dur, data }));
      }
      if (this.next >= meta.length && !this.flushed && !this.flushing) {
        // NÃO espera o flush aqui: o decodificador de hardware só tem alguns quadros
        // disponíveis; se ficarmos parados segurando quadros, ele nunca termina
        // (travava no fim da exportação). Os quadros seguem sendo entregues/liberados.
        const dec = this.decoder;
        this.flushing = true;
        dec
          .flush()
          .then(() => {
            if (dec === this.decoder) this.flushed = true;
          })
          .catch(() => {
            if (dec === this.decoder) this.flushed = true;
          })
          .finally(() => {
            if (dec === this.decoder) this.flushing = false;
            this.wake?.();
          });
      }
      await new Promise<void>((r) => {
        this.wake = r;
        setTimeout(r, 50);
      });
      this.wake = null;
    }
    const frame = this.current ?? this.queue[0] ?? null;
    if (!frame) return null;
    // trava: alguns decodificadores de celular devolvem quadro de outro ponto do arquivo
    // (o vídeo saía "inteiro", ignorando os cortes). Quadro longe do pedido: desiste, e
    // quem chamou passa este trecho para o <video> posicionado quadro a quadro.
    if (Math.abs(frame.timestamp - target) > 400_000 && target <= this.lastTs) throw new Error('quadro fora do lugar');
    if (!this.d.rotation) return frame;
    return this.rotated(frame);
  }

  /** Aplica a rotação gravada pela câmera (o <video> faz isso automaticamente). */
  private rotated(frame: VideoFrame): HTMLCanvasElement {
    const w = frame.displayWidth;
    const h = frame.displayHeight;
    const rot = this.d.rotation;
    const swap = rot === 90 || rot === 270;
    if (!this.canvas) this.canvas = document.createElement('canvas');
    const c = this.canvas;
    c.width = swap ? h : w;
    c.height = swap ? w : h;
    const ctx = c.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate((rot * Math.PI) / 180);
    ctx.drawImage(frame, -w / 2, -h / 2, w, h);
    return c;
  }

  dispose() {
    this.gen++;
    if (this.decoder.state !== 'closed') this.decoder.close();
    for (const f of this.queue) f.close();
    this.queue = [];
    this.current?.close();
    this.current = null;
    this.ahead.clear();
  }
}
