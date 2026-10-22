/**
 * Muda a velocidade do áudio SEM mudar o tom da voz (WSOLA: sobreposição de
 * janelas alinhadas por correlação). É o mesmo efeito do player (preservesPitch)
 * e do atempo do FFmpeg — acelerar/desacelerar não deixa a voz fina ou grossa.
 *
 * `speed` > 1 acelera (saída mais curta), < 1 desacelera.
 */
export function timeStretch(channels: Float32Array[], speed: number, sampleRate: number): Float32Array[] {
  const inLen = channels[0]?.length ?? 0;
  if (!inLen || Math.abs(speed - 1) < 1e-3) return channels;
  const N = Math.max(256, Math.round((sampleRate * 0.04) / 2) * 2); // janela de ~40 ms
  const Hs = N / 2; // passo de síntese
  const Ha = Hs * speed; // passo de análise
  const tol = Math.round(sampleRate * 0.012); // busca de ±12 ms
  const outLen = Math.max(1, Math.floor(inLen / speed));
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);

  // sinal mono reduzido (÷4) só para a busca de alinhamento (rápido)
  const D = 4;
  const monoLen = Math.ceil(inLen / D);
  const mono = new Float32Array(monoLen);
  for (let i = 0; i < monoLen; i++) {
    let s = 0;
    for (const ch of channels) s += ch[i * D] ?? 0;
    mono[i] = s;
  }
  const out = channels.map(() => new Float32Array(outLen + N));
  const norm = new Float32Array(outLen + N);
  const cmpLen = Math.floor(Hs / D);
  let prev = 0;
  for (let k = 0; ; k++) {
    const outPos = k * Hs;
    if (outPos >= outLen) break;
    let pos = Math.round(k * Ha);
    if (k > 0) {
      // procura perto da posição nominal o trecho que melhor continua o anterior
      const ref = Math.floor((prev + Hs) / D);
      let best = pos;
      let bestScore = -Infinity;
      for (let d = -tol; d <= tol; d += D) {
        const cand = pos + d;
        if (cand < 0 || cand + N > inLen) continue;
        const c0 = Math.floor(cand / D);
        let score = 0;
        for (let j = 0; j < cmpLen; j++) score += (mono[ref + j] ?? 0) * (mono[c0 + j] ?? 0);
        if (score > bestScore) {
          bestScore = score;
          best = cand;
        }
      }
      pos = best;
    }
    if (pos + N > inLen) pos = Math.max(0, inLen - N);
    for (let c = 0; c < channels.length; c++) {
      const src = channels[c]!;
      const dst = out[c]!;
      for (let i = 0; i < N; i++) dst[outPos + i]! += (src[pos + i] ?? 0) * win[i]!;
    }
    for (let i = 0; i < N; i++) norm[outPos + i]! += win[i]!;
    prev = pos;
  }
  return out.map((o) => {
    const r = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) r[i] = o[i]! / Math.max(norm[i]!, 1e-3);
    return r;
  });
}
