/**
 * Remoção de fundo liso (ex.: logo PNG que virou JPG com fundo branco ao passar
 * pelo WhatsApp/galeria). Trabalha sobre os pixels RGBA, sem DOM, para poder
 * ser testada. Só age quando a borda da imagem é praticamente de uma cor só;
 * fotos e imagens que já têm transparência ficam intactas.
 */

/** distância de cor abaixo da qual o pixel é fundo puro (vira 100% transparente) */
const LOW = 16;
/** até esta distância o pixel ligado à borda ainda é fundo (sombra/brilho suave) */
const FILL = 60;

export interface CutoutOptions {
  /** fração mínima da borda com a cor do fundo para agir (padrão 0,88) */
  minBorder?: number;
}

function median(values: number[]): number {
  const s = values.slice().sort((a, b) => a - b);
  return s[s.length >> 1] ?? 0;
}

/** true se algum pixel já tem transparência. */
export function hasAlpha(px: Uint8ClampedArray): boolean {
  for (let i = 3; i < px.length; i += 4) if (px[i]! < 250) return true;
  return false;
}

/**
 * Torna transparente o fundo liso ligado às bordas. Altera `px` e retorna true
 * se removeu; false se a imagem não tem fundo liso (nada é alterado).
 */
export function removeFlatBackground(px: Uint8ClampedArray, w: number, h: number, opts: CutoutOptions = {}): boolean {
  if (w < 4 || h < 4 || hasAlpha(px)) return false;
  const border: number[] = [];
  const depth = Math.min(2, Math.floor(Math.min(w, h) / 4));
  for (let d = 0; d < depth; d++) {
    for (let x = 0; x < w; x++) border.push(d * w + x, (h - 1 - d) * w + x);
    for (let y = depth; y < h - depth; y++) border.push(y * w + d, y * w + (w - 1 - d));
  }
  const bg = [0, 1, 2].map((c) => median(border.map((p) => px[p * 4 + c]!))) as [number, number, number];
  const dist = new Uint8Array(w * h);
  for (let p = 0, i = 0; p < w * h; p++, i += 4) {
    const dr = px[i]! - bg[0];
    const dg = px[i + 1]! - bg[1];
    const db = px[i + 2]! - bg[2];
    dist[p] = Math.min(255, Math.round(Math.sqrt(dr * dr + dg * dg + db * db)));
  }
  const flat = border.filter((p) => dist[p]! < 30).length / border.length;
  if (flat < (opts.minBorder ?? 0.88)) return false;

  // preenche a partir das bordas tudo que ainda é "fundo"
  const filled = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let head = 0;
  let tail = 0;
  for (const p of border) {
    if (!filled[p] && dist[p]! < FILL) {
      filled[p] = 1;
      queue[tail++] = p;
    }
  }
  while (head < tail) {
    const p = queue[head++]!;
    const x = p % w;
    const n = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w];
    for (const q of n) {
      if (q < 0 || q >= w * h || filled[q] || dist[q]! >= FILL) continue;
      filled[q] = 1;
      queue[tail++] = q;
    }
  }

  // contorno (2 px fora da área preenchida): suaviza a borda do desenho
  const edge = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (filled[p]) continue;
      let near = false;
      for (let dy = -2; dy <= 2 && !near; dy++) {
        for (let dx = -2; dx <= 2 && !near; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < w && yy < h && filled[yy * w + xx]) near = true;
        }
      }
      if (near) edge[p] = 1;
    }
  }

  for (let p = 0, i = 0; p < w * h; p++, i += 4) {
    let a: number;
    if (filled[p]) a = Math.max(0, (dist[p]! - LOW) / (FILL - LOW));
    else if (edge[p]) a = Math.min(1, Math.max(0, (dist[p]! - LOW) / (FILL * 1.6 - LOW)));
    else continue;
    if (a <= 0) {
      px[i + 3] = 0;
      continue;
    }
    if (a < 1) {
      // tira a "mistura" com o fundo para não ficar halo claro em fundo escuro
      for (let c = 0; c < 3; c++) px[i + c] = Math.min(255, Math.max(0, Math.round(bg[c]! + (px[i + c]! - bg[c]!) / a)));
    }
    px[i + 3] = Math.round(a * 255);
  }
  return true;
}
