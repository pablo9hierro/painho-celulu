/**
 * Relógio das palavras: o Whisper (no aparelho) diz quando cada palavra é
 * falada. Se falhar (sem internet na 1ª vez, aparelho fraco), quem chama segue
 * com o tempo pelas sílabas.
 */
import type { PalavraTempo } from '../news/frases';

let worker: Worker | null = null;
let seq = 0;

/** áudio mono 16 kHz → palavras com tempo (s, a partir de `inicio`) */
export function relogioPalavras(pcm: Float32Array, inicio: number, opts: { onStep?: (s: string) => void; signal?: AbortSignal } = {}): Promise<PalavraTempo[]> {
  return new Promise((resolve, reject) => {
    if (typeof Worker === 'undefined') return reject(new Error('sem worker'));
    worker ??= new Worker(new URL('./whisperWorker.ts', import.meta.url), { type: 'module' });
    const w = worker;
    const id = ++seq;
    const fim = () => {
      w.removeEventListener('message', onMsg);
      opts.signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      fim();
      // para o Whisper no meio: joga o worker fora (o modelo continua no cache)
      w.terminate();
      if (worker === w) worker = null;
      reject(new DOMException('cancelado', 'AbortError'));
    };
    const onMsg = (ev: MessageEvent<{ id: number; baixando?: number; ouvindo?: boolean; palavras?: PalavraTempo[]; erro?: string }>) => {
      const m = ev.data;
      if (m.id !== id) return;
      if (m.baixando !== undefined) opts.onStep?.(`Baixando o sincronizador de legenda (só na 1ª vez)… ${m.baixando} de ~80 MB`);
      else if (m.ouvindo) opts.onStep?.('Acertando o tempo de cada palavra…');
      else if (m.erro !== undefined) {
        fim();
        reject(new Error(m.erro));
      } else if (m.palavras) {
        fim();
        resolve(m.palavras.filter((p) => p.w && Number.isFinite(p.t)).map((p) => ({ w: p.w, t: p.t + inicio, e: p.e + inicio })));
      }
    };
    w.addEventListener('message', onMsg);
    opts.signal?.addEventListener('abort', onAbort);
    // cópia: o áudio original ainda vai para a IA
    const copia = pcm.slice();
    w.postMessage({ id, pcm: copia }, [copia.buffer]);
  });
}
