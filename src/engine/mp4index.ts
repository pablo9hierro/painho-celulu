/**
 * Índice de MP4/MOV sem carregar o arquivo inteiro na memória.
 *
 * Lê só o cabeçalho (caixa `moov`, poucos MB mesmo em vídeos longos) e monta a
 * tabela de amostras (posição, tamanho, tempo, quadro-chave) de cada trilha.
 * Os dados de cada amostra são lidos depois, sob demanda, com `Blob.slice` —
 * assim vídeos de 5 minutos ou mais não derrubam o app no celular.
 *
 * Arquivos fragmentados (moof) ou com codec desconhecido devolvem null e o app
 * usa os caminhos antigos.
 */

export interface Mp4Sample {
  offset: number;
  size: number;
  /** tempo de decodificação / apresentação, na escala da trilha */
  dts: number;
  cts: number;
  dur: number;
  sync: boolean;
}

export interface Mp4Track {
  id: number;
  type: 'video' | 'audio';
  timescale: number;
  codec: string;
  description?: Uint8Array;
  width: number;
  height: number;
  /** rotação gravada pela câmera, em graus (0/90/180/270) */
  rotation: number;
  sampleRate: number;
  channels: number;
  /** início da apresentação (lista de edição), na escala da trilha */
  editOffset: number;
  samples: Mp4Sample[];
}

export interface Mp4Index {
  tracks: Mp4Track[];
  video?: Mp4Track;
  audio?: Mp4Track;
}

const MAX_MOOV = 96 * 1024 * 1024;

async function read(blob: Blob, start: number, end: number): Promise<DataView> {
  const buf = await blob.slice(start, Math.min(end, blob.size)).arrayBuffer();
  return new DataView(buf);
}

const fourcc = (v: DataView, o: number) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
const u64 = (v: DataView, o: number) => v.getUint32(o) * 2 ** 32 + v.getUint32(o + 4);

interface Box {
  type: string;
  /** início do conteúdo (depois do cabeçalho) e fim, relativos ao DataView */
  start: number;
  end: number;
}

function children(v: DataView, start: number, end: number): Box[] {
  const out: Box[] = [];
  let p = start;
  while (p + 8 <= end) {
    let size = v.getUint32(p);
    const type = fourcc(v, p + 4);
    let header = 8;
    if (size === 1) {
      size = u64(v, p + 8);
      header = 16;
    } else if (size === 0) size = end - p;
    if (size < header || p + size > end) break;
    out.push({ type, start: p + header, end: p + size });
    p += size;
  }
  return out;
}

const find = (v: DataView, b: Box | { start: number; end: number }, type: string) => children(v, b.start, b.end).find((c) => c.type === type);

/** Rotação a partir da matriz do tkhd (16.16). */
function rotationOf(a: number, b: number): number {
  const deg = Math.round((Math.atan2(b / 65536, a / 65536) * 180) / Math.PI / 90) * 90;
  return ((deg % 360) + 360) % 360;
}

const hex = (n: number, w = 2) => n.toString(16).padStart(w, '0');

function avcCodec(d: Uint8Array): string {
  return `avc1.${hex(d[1]!)}${hex(d[2]!)}${hex(d[3]!)}`;
}

/** Texto do codec HEVC (ISO/IEC 14496-15, igual ao que o mp4box gera). */
function hevcCodec(fourCC: string, d: Uint8Array): string {
  const space = ['', 'A', 'B', 'C'][d[1]! >> 6] ?? '';
  const tier = (d[1]! >> 5) & 1 ? 'H' : 'L';
  const profile = d[1]! & 0x1f;
  let compat = (d[2]! << 24) | (d[3]! << 16) | (d[4]! << 8) | d[5]!;
  // bits invertidos
  let rev = 0;
  for (let i = 0; i < 32; i++) {
    rev = (rev << 1) | (compat & 1);
    compat >>>= 1;
  }
  const constraints = Array.from(d.subarray(6, 12));
  while (constraints.length && constraints[constraints.length - 1] === 0) constraints.pop();
  const level = d[12]!;
  let s = `${fourCC}.${space}${profile}.${(rev >>> 0).toString(16)}.${tier}${level}`;
  if (constraints.length) s += '.' + constraints.map((c) => c.toString(16)).join('.');
  return s;
}

function vp9Codec(d: Uint8Array): string {
  // vpcC: version(1) flags(3) profile(1) level(1) bitDepth(4 bits)...
  const profile = d[4]!;
  const level = d[5]!;
  const bitDepth = d[6]! >> 4;
  return `vp09.${hex(profile)}.${hex(level)}.${hex(bitDepth)}`;
}

/** AudioSpecificConfig dentro do esds (descritor 0x05). */
function parseEsds(d: Uint8Array): { oti: number; asc?: Uint8Array } {
  let p = 4; // versão + flags
  let oti = 0;
  const readLen = () => {
    let len = 0;
    for (let i = 0; i < 4; i++) {
      const b = d[p++]!;
      len = (len << 7) | (b & 0x7f);
      if (!(b & 0x80)) break;
    }
    return len;
  };
  while (p < d.length) {
    const tag = d[p++]!;
    const len = readLen();
    if (tag === 0x03) {
      p += 2; // ES_ID
      const flags = d[p++]!;
      if (flags & 0x80) p += 2;
      if (flags & 0x40) p += 1 + d[p]!;
      if (flags & 0x20) p += 2;
      continue; // descritores aninhados
    }
    if (tag === 0x04) {
      oti = d[p]!;
      p += 13;
      continue;
    }
    if (tag === 0x05) return { oti, asc: d.slice(p, p + len) };
    p += len;
  }
  return { oti };
}

function parseTrak(v: DataView, trak: Box): Mp4Track | null {
  const tkhd = find(v, trak, 'tkhd');
  const mdia = find(v, trak, 'mdia');
  if (!tkhd || !mdia) return null;
  const tv = v.getUint8(tkhd.start);
  const tid = v.getUint32(tkhd.start + (tv === 1 ? 20 : 12));
  const matrixAt = tkhd.start + (tv === 1 ? 52 : 40);
  const rotation = rotationOf(v.getInt32(matrixAt), v.getInt32(matrixAt + 4));

  const mdhd = find(v, mdia, 'mdhd');
  const hdlr = find(v, mdia, 'hdlr');
  const minf = find(v, mdia, 'minf');
  if (!mdhd || !hdlr || !minf) return null;
  const mv = v.getUint8(mdhd.start);
  const timescale = v.getUint32(mdhd.start + (mv === 1 ? 20 : 12));
  const handler = fourcc(v, hdlr.start + 8);
  if (handler !== 'vide' && handler !== 'soun') return null;
  const stbl = find(v, minf, 'stbl');
  if (!stbl || !timescale) return null;
  const tables = children(v, stbl.start, stbl.end);
  const get = (t: string) => tables.find((b) => b.type === t);

  // ---- descrição do codec (1ª entrada do stsd)
  const stsd = get('stsd');
  if (!stsd) return null;
  const entry = children(v, stsd.start + 8, stsd.end)[0];
  if (!entry) return null;
  const bytes = (b: Box) => new Uint8Array(v.buffer, v.byteOffset + b.start, b.end - b.start).slice();
  let codec = '';
  let description: Uint8Array | undefined;
  let width = 0;
  let height = 0;
  let sampleRate = 0;
  let channels = 0;
  if (handler === 'vide') {
    width = v.getUint16(entry.start + 24);
    height = v.getUint16(entry.start + 26);
    const sub = children(v, entry.start + 78, entry.end);
    const box = (t: string) => sub.find((b) => b.type === t);
    const f = entry.type;
    if ((f === 'avc1' || f === 'avc3') && box('avcC')) {
      description = bytes(box('avcC')!);
      codec = avcCodec(description);
    } else if ((f === 'hvc1' || f === 'hev1') && box('hvcC')) {
      description = bytes(box('hvcC')!);
      codec = hevcCodec(f, description);
    } else if (f === 'vp09' && box('vpcC')) {
      codec = vp9Codec(bytes(box('vpcC')!));
    } else return null;
  } else {
    const ver = v.getUint16(entry.start + 8);
    channels = v.getUint16(entry.start + 16);
    sampleRate = v.getUint32(entry.start + 24) / 65536;
    const extra = ver === 1 ? 16 : ver === 2 ? 36 : 0;
    const sub = children(v, entry.start + 28 + extra, entry.end);
    if (entry.type === 'mp4a') {
      const esds = sub.find((b) => b.type === 'esds') ?? sub.flatMap((b) => (b.type === 'wave' ? children(v, b.start, b.end) : [])).find((b) => b.type === 'esds');
      if (!esds) return null;
      const { oti, asc } = parseEsds(bytes(esds));
      if (oti !== 0x40 && oti !== 0x66 && oti !== 0x67) return null; // AAC
      const aot = asc && asc.length ? asc[0]! >> 3 : 2;
      codec = `mp4a.40.${aot === 31 ? 2 : aot}`;
      description = asc;
    } else return null;
  }

  // ---- tabela de amostras
  const stsz = get('stsz') ?? get('stz2');
  const stco = get('stco') ?? get('co64');
  const stsc = get('stsc');
  const stts = get('stts');
  if (!stsz || !stco || !stsc || !stts) return null;
  if (stsz.type === 'stz2') return null;
  const count = v.getUint32(stsz.start + 8);
  const fixed = v.getUint32(stsz.start + 4);
  const sizes = new Uint32Array(count);
  for (let i = 0; i < count; i++) sizes[i] = fixed || v.getUint32(stsz.start + 12 + i * 4);

  const chunkCount = v.getUint32(stco.start + 4);
  const chunkOff = new Float64Array(chunkCount);
  for (let i = 0; i < chunkCount; i++) chunkOff[i] = stco.type === 'co64' ? u64(v, stco.start + 8 + i * 8) : v.getUint32(stco.start + 8 + i * 4);

  const scN = v.getUint32(stsc.start + 4);
  const sc: { first: number; per: number }[] = [];
  for (let i = 0; i < scN; i++) sc.push({ first: v.getUint32(stsc.start + 8 + i * 12), per: v.getUint32(stsc.start + 12 + i * 12) });

  const samples: Mp4Sample[] = new Array(count);
  let si = 0;
  for (let e = 0; e < sc.length && si < count; e++) {
    const firstChunk = sc[e]!.first - 1;
    const lastChunk = e + 1 < sc.length ? sc[e + 1]!.first - 1 : chunkCount;
    for (let ch = firstChunk; ch < lastChunk && si < count; ch++) {
      let off = chunkOff[ch]!;
      for (let k = 0; k < sc[e]!.per && si < count; k++) {
        samples[si] = { offset: off, size: sizes[si]!, dts: 0, cts: 0, dur: 0, sync: true };
        off += sizes[si]!;
        si++;
      }
    }
  }
  if (si < count) return null;

  // tempos
  let t = 0;
  let idx = 0;
  const sttsN = v.getUint32(stts.start + 4);
  for (let e = 0; e < sttsN; e++) {
    const n = v.getUint32(stts.start + 8 + e * 8);
    const delta = v.getUint32(stts.start + 12 + e * 8);
    for (let k = 0; k < n && idx < count; k++, idx++) {
      samples[idx]!.dts = t;
      samples[idx]!.cts = t;
      samples[idx]!.dur = delta;
      t += delta;
    }
  }
  const ctts = get('ctts');
  if (ctts) {
    const cv = v.getUint8(ctts.start);
    const n = v.getUint32(ctts.start + 4);
    idx = 0;
    for (let e = 0; e < n; e++) {
      const c = v.getUint32(ctts.start + 8 + e * 8);
      const o = cv === 1 ? v.getInt32(ctts.start + 12 + e * 8) : v.getUint32(ctts.start + 12 + e * 8);
      for (let k = 0; k < c && idx < count; k++, idx++) samples[idx]!.cts = samples[idx]!.dts + o;
    }
  }
  const stss = get('stss');
  if (stss && handler === 'vide') {
    for (const s of samples) s.sync = false;
    const n = v.getUint32(stss.start + 4);
    for (let e = 0; e < n; e++) {
      const k = v.getUint32(stss.start + 8 + e * 4) - 1;
      if (samples[k]) samples[k]!.sync = true;
    }
  }

  // lista de edição: onde a apresentação começa
  let editOffset = 0;
  const edts = find(v, trak, 'edts');
  const elst = edts && find(v, edts, 'elst');
  if (elst) {
    const ev = v.getUint8(elst.start);
    const n = v.getUint32(elst.start + 4);
    for (let e = 0; e < n; e++) {
      const base = elst.start + 8 + e * (ev === 1 ? 20 : 12);
      const mediaTime = ev === 1 ? Number(v.getBigInt64(base + 8)) : v.getInt32(base + 4);
      if (mediaTime >= 0) {
        editOffset = mediaTime;
        break;
      }
    }
  }

  return { id: tid, type: handler === 'vide' ? 'video' : 'audio', timescale, codec, description, width, height, rotation, sampleRate, channels, editOffset, samples };
}

/** Índice do MP4 (só o cabeçalho é lido). */
export async function indexMp4(blob: Blob): Promise<Mp4Index | null> {
  try {
    let p = 0;
    let moov: DataView | null = null;
    while (p + 8 <= blob.size) {
      const h = await read(blob, p, p + 16);
      let size = h.getUint32(0);
      const type = fourcc(h, 4);
      let header = 8;
      if (size === 1) {
        size = u64(h, 8);
        header = 16;
      } else if (size === 0) size = blob.size - p;
      if (size < header) return null;
      if (type === 'moof') return null; // fragmentado: usa o caminho antigo
      if (type === 'moov') {
        if (size > MAX_MOOV) return null;
        moov = await read(blob, p + header, p + size);
        // um MP4 fragmentado também tem moov (com mvex)
        if (children(moov, 0, moov.byteLength).some((b) => b.type === 'mvex')) return null;
        break;
      }
      p += size;
    }
    if (!moov) return null;
    const tracks = children(moov, 0, moov.byteLength)
      .filter((b) => b.type === 'trak')
      .map((b) => {
        try {
          return parseTrak(moov!, b);
        } catch {
          return null;
        }
      })
      .filter((t): t is Mp4Track => !!t && t.samples.length > 0);
    if (!tracks.length) return null;
    return { tracks, video: tracks.find((t) => t.type === 'video'), audio: tracks.find((t) => t.type === 'audio') };
  } catch {
    return null;
  }
}

/**
 * Lê os dados das amostras [from, to) em poucas leituras contíguas (até ~4 MB
 * cada). Devolve um mapa índice → bytes.
 */
export async function readSamples(blob: Blob, samples: Mp4Sample[], from: number, to: number, maxBytes = 4 * 1024 * 1024): Promise<Map<number, Uint8Array>> {
  const out = new Map<number, Uint8Array>();
  let i = from;
  while (i < to) {
    const start = samples[i]!.offset;
    let end = start + samples[i]!.size;
    let j = i + 1;
    while (j < to) {
      const s = samples[j]!;
      // só junta se estiver adiante e perto (dados de outra trilha entre eles são lidos e descartados)
      if (s.offset < start || s.offset + s.size - start > maxBytes) break;
      end = Math.max(end, s.offset + s.size);
      j++;
    }
    const buf = new Uint8Array(await blob.slice(start, end).arrayBuffer());
    for (let k = i; k < j; k++) {
      const s = samples[k]!;
      out.set(k, buf.subarray(s.offset - start, s.offset - start + s.size));
    }
    i = j;
  }
  return out;
}
