/**
 * Frases da legenda (puro, sem tela): encosta cada frase da IA na voz de
 * verdade e dá o tempo de cada palavra.
 *
 * Melhor caso: o texto vem da IA (Gemini, que entende bem o português) e o
 * tempo de cada palavra vem do Whisper rodando no aparelho (`relogio`), casando
 * as duas listas de palavras. Sem o Whisper: tempo pelas sílabas, só nos
 * trechos com voz.
 */
import { alignSegments, wordTimes, wordTimesVoiced, type Regiao, type Segmento } from './transcribe';

export interface Frase {
  sp: number;
  ini: number;
  fim: number;
  /** tempo absoluto (s) de cada palavra */
  palavras: { w: string; t: number; e: number }[];
}

/** palavra com tempo absoluto (s) — o "relógio" que o Whisper devolve */
export interface PalavraTempo {
  w: string;
  t: number;
  e: number;
}

type Palavra = { w: string; t: number; e: number; sp: number };

/** Corta em frases curtas (até 7 palavras, quebrando de preferência na pontuação ou numa pausa). */
function emFrases(ws: Palavra[]): Frase[] {
  const out: Frase[] = [];
  let cur: Palavra[] = [];
  const fecha = () => {
    if (!cur.length) return;
    out.push({ sp: cur[0]!.sp, ini: cur[0]!.t, fim: cur[cur.length - 1]!.e, palavras: cur.map(({ w, t, e }) => ({ w, t, e })) });
    cur = [];
  };
  ws.forEach((w, i) => {
    const prox = ws[i + 1];
    // troca de quem fala ou pausa longa antes desta palavra: frase nova
    if (cur.length && (w.sp !== cur[0]!.sp || w.t - cur[cur.length - 1]!.e > 0.7)) fecha();
    cur.push(w);
    let resto = 0;
    for (let k = i + 1; k < ws.length && ws[k]!.sp === w.sp; k++) resto++;
    // "foi bom, véi." — a palavrinha que fecha a frase vem junto, não vai para a próxima
    let fechaJunto = false;
    for (let k = 1; k <= 2 && !fechaJunto; k++) {
      const pedaco = ws.slice(i + 1, i + 1 + k);
      if (pedaco.length < k || cur.length + k > 7 || pedaco.some((x) => x.sp !== w.sp || norm(x.w).length > 4)) break;
      if (pedaco[0]!.t - w.e >= 0.4) break;
      if (/[,;:]$/.test(pedaco[k - 1]!.w)) break;
      fechaJunto = /[.!?]$/.test(pedaco[k - 1]!.w);
    }
    const pontua = /[.!?,;:]$/.test(w.w) && cur.length >= 3 && resto >= 2 && !fechaJunto;
    if (cur.length >= 7 || pontua || !prox || prox.sp !== w.sp) fecha();
  });
  fecha();
  return out;
}

const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
/** mesma palavra (ou quase: "Gomes"/"Gome", "bem-vindo"/"bemvindo") */
const parecida = (a: string, b: string) => !!a && (a === b || (a.length > 3 && b.length > 3 && (a.startsWith(b.slice(0, 4)) || b.startsWith(a.slice(0, 4)))));

/**
 * Texto da IA com o tempo do Whisper: casa as palavras das duas listas (maior
 * sequência em comum) e, nas que não casaram, reparte o tempo entre as
 * vizinhas que casaram.
 */
export function casarTempos(segs: Segmento[], relogio: PalavraTempo[]): Palavra[] {
  const g = segs.flatMap((s) => s.texto.split(/\s+/).filter(Boolean).map((w) => ({ w, s })));
  if (!g.length) return [];
  const A = g.map((x) => norm(x.w));
  const B = relogio.map((x) => norm(x.w));
  // onde a IA acha que cada palavra está (pelas sílabas dentro da frase dela)
  const peso = (w: string) => Math.max(1, (norm(w).match(/[aeiouy]+/g) ?? []).length);
  const esperado = g.map((x) => {
    const ws = g.filter((y) => y.s === x.s);
    const pos = ws.indexOf(x);
    const tot = ws.reduce((t, y) => t + peso(y.w), 0);
    const antes = ws.slice(0, pos).reduce((t, y) => t + peso(y.w), 0);
    return x.s.inicio + ((x.s.fim - x.s.inicio) * antes) / tot;
  });
  // casa o máximo de palavras; entre dois jeitos iguais, fica com o mais perto do tempo da IA
  // (a mesma frase repetida no áudio, um "é" de outra frase...). Longe demais (>3 s da frase): não casa.
  const nota = (i: number, j: number) => {
    const tw = relogio[j]!.t;
    if (!parecida(A[i]!, B[j]!) || tw < g[i]!.s.inicio - 3 || tw > g[i]!.s.fim + 3) return 0;
    return 1 - Math.min(0.5, 0.08 * Math.abs(tw - esperado[i]!));
  };
  const L = Array.from({ length: A.length + 1 }, () => new Float64Array(B.length + 1));
  for (let i = A.length - 1; i >= 0; i--)
    for (let j = B.length - 1; j >= 0; j--) {
      const n = nota(i, j);
      L[i]![j] = Math.max(L[i + 1]![j]!, L[i]![j + 1]!, n ? L[i + 1]![j + 1]! + n : 0);
    }
  const ini: (number | null)[] = new Array(A.length).fill(null);
  const fim: (number | null)[] = new Array(A.length).fill(null);
  let i = 0;
  let j = 0;
  while (i < A.length && j < B.length) {
    const n = nota(i, j);
    if (n && L[i]![j]! === L[i + 1]![j + 1]! + n) {
      ini[i] = relogio[j]!.t;
      fim[i] = relogio[j]!.e;
      i++;
      j++;
    } else if (L[i + 1]![j]! >= L[i]![j + 1]!) i++;
    else j++;
  }
  // o ouvinte entendeu pouco (áudio ruim, saiu do ar no meio): não confia nele, quem chama usa a voz/sílabas
  if (ini.filter((x) => x !== null).length < A.length * 0.35) return [];
  // as que não casaram: entre as vizinhas casadas (pelo peso de cada palavra) ou, na ponta, pelo tempo da IA
  for (let k = 0; k < A.length; k++) {
    if (ini[k] !== null) continue;
    let a = k - 1;
    while (a >= 0 && ini[a] === null) a--;
    let b = k + 1;
    while (b < A.length && ini[b] === null) b++;
    const doGemini = (x: number) => esperado[x]!;
    if (a >= 0 && b < A.length) {
      // reparte o vão entre a última casada (a partir do fim dela) e a próxima
      let de = fim[a]! > ini[a]! ? Math.min(fim[a]!, ini[b]!) : ini[a]!;
      let ate = ini[b]!;
      // vão grande (pausa no meio): quem é da frase da próxima fica colado nela, quem é da anterior
      // fica logo depois dela, no ritmo normal da fala (~0,2 s por sílaba), em vez de espalhar no silêncio
      const SIL = 0.2;
      let x0 = a + 1;
      let x1 = b - 1;
      let fala = 0;
      for (let x = x0; x <= x1; x++) fala += peso(g[x]!.w) * SIL;
      if (ate - de > fala * 1.5) {
        while (x1 >= x0 && g[x1]!.s === g[b]!.s && g[x1]!.s !== g[a]!.s) {
          fim[x1] = ate;
          ate -= peso(g[x1]!.w) * SIL;
          ini[x1] = ate;
          x1--;
        }
        while (x0 <= x1 && g[x0]!.s === g[a]!.s && g[x0]!.s !== g[b]!.s) {
          ini[x0] = de;
          de += peso(g[x0]!.w) * SIL;
          fim[x0] = de;
          x0++;
        }
      }
      let tot = 0;
      for (let x = x0; x <= x1; x++) tot += peso(g[x]!.w);
      let acc = 0;
      for (let x = x0; x <= x1; x++) {
        ini[x] = de + ((ate - de) * acc) / tot;
        acc += peso(g[x]!.w);
        fim[x] = de + ((ate - de) * acc) / tot;
      }
    } else if (a >= 0) {
      // depois da última casada: anda no ritmo da IA a partir dela
      const desvio = ini[a]! - doGemini(a);
      for (let x = a + 1; x < A.length; x++) ini[x] = doGemini(x) + desvio;
    } else if (b < A.length) {
      const desvio = ini[b]! - doGemini(b);
      for (let x = 0; x < b; x++) ini[x] = Math.max(0, doGemini(x) + desvio);
    } else for (let x = 0; x < A.length; x++) ini[x] = doGemini(x);
  }
  // nunca volta no tempo; o fim de cada palavra é o começo da próxima (ou o fim que o Whisper ouviu)
  for (let k = 1; k < A.length; k++) ini[k] = Math.max(ini[k]!, ini[k - 1]! + 0.04);
  return g.map((x, k) => {
    const prox = k + 1 < A.length ? ini[k + 1]! : Infinity;
    const ouvido = fim[k] !== null && fim[k]! > ini[k]! ? fim[k]! : ini[k]! + 0.45;
    // pausa entre palavras: a palavra some no fim dela (até 0,3 s depois), não fica esperando a próxima
    const e = prox - ouvido > 0.3 ? ouvido + 0.3 : Math.min(prox, Math.max(ouvido, ini[k]! + 0.12));
    return { w: x.w, t: +ini[k]!.toFixed(3), e: +Math.max(e, ini[k]! + 0.08).toFixed(3), sp: x.s.falante };
  });
}

/** Frases curtas com o tempo de cada palavra (pelo Whisper, se tiver; senão encostado na voz). */
export function frases(segs: Segmento[], regs: Regiao[], relogio: PalavraTempo[] = []): Frase[] {
  // só confia no relógio se ele cobriu boa parte do texto
  if (relogio.length >= 3) {
    const ws = casarTempos(segs, relogio);
    if (ws.length) return emFrases(ws);
  }
  const al = regs.length ? alignSegments(segs, regs) : segs;
  const ws: Palavra[] = [];
  for (const s of al) {
    const wt = regs.length ? wordTimesVoiced(s.texto, s.inicio, s.fim, regs) : wordTimes(s.texto, (s.fim - s.inicio) * 0.95);
    wt.forEach((w, i) => ws.push({ w: w.w, t: s.inicio + w.t, e: i + 1 < wt.length ? s.inicio + wt[i + 1]!.t : s.fim, sp: s.falante }));
  }
  return emFrases(ws);
}
