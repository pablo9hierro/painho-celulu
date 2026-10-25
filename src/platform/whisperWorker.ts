/// <reference lib="webworker" />
/**
 * Whisper rodando no aparelho (fora da tela, para não travar o app): só para
 * saber EM QUE MOMENTO cada palavra é dita. O texto continua vindo da IA.
 * O modelo (~80 MB) é baixado uma vez e fica guardado no cache do app.
 */
import { env, pipeline } from '@huggingface/transformers';

env.allowLocalModels = false;
const MODELO = 'Xenova/whisper-base';

type Asr = (pcm: Float32Array, o: Record<string, unknown>) => Promise<{ chunks?: { text: string; timestamp: [number, number | null] }[] }>;
let asr: Promise<Asr> | null = null;

self.onmessage = async (ev: MessageEvent<{ id: number; pcm: Float32Array }>) => {
  const { id, pcm } = ev.data;
  const post = (m: Record<string, unknown>) => (self as unknown as Worker).postMessage({ id, ...m });
  try {
    if (!asr) {
      const vistos = new Map<string, [number, number]>();
      asr = pipeline('automatic-speech-recognition', MODELO, {
        dtype: 'q8',
        device: 'wasm',
        progress_callback: (p: { status: string; file?: string; loaded?: number; total?: number }) => {
          if (p.status !== 'progress' || !p.file) return;
          vistos.set(p.file, [p.loaded ?? 0, p.total ?? 0]);
          let a = 0;
          for (const [l] of vistos.values()) a += l;
          // o servidor nem sempre diz o tamanho: mostra quanto já veio (o total é ~80 MB)
          post({ baixando: Math.round(a / 1e6) });
        },
      }) as unknown as Promise<Asr>;
      asr.catch(() => (asr = null));
    }
    const f = await asr;
    post({ ouvindo: true });
    const out = await f(pcm, { language: 'portuguese', task: 'transcribe', return_timestamps: 'word', chunk_length_s: 30, stride_length_s: 5 });
    post({ palavras: (out.chunks ?? []).map((c) => ({ w: c.text.trim(), t: c.timestamp[0], e: c.timestamp[1] ?? c.timestamp[0] + 0.3 })) });
  } catch (e) {
    post({ erro: e instanceof Error ? e.message : String(e) });
  }
};
