/**
 * Gravador do comando de voz: liga e desliga SÓ no dedo do jornalista — não
 * para sozinho em pausa, não tem limite de tempo, não fica apitando. Grava o
 * microfone direto (sem o reconhecedor do Android, que corta a cada pausa) e,
 * quando desliga, devolve o áudio inteiro em 16 kHz mono para transcrever.
 */
import { Capacitor, registerPlugin } from '@capacitor/core';

const RATE = 16_000;

interface PermPlugin {
  requestPermissions(o?: { permissions: string[] }): Promise<{ mic?: string }>;
}
const Perm = registerPlugin<PermPlugin>('Ditado');

export interface Gravacao {
  /** para e devolve o áudio (16 kHz mono) */
  stop(): Promise<Float32Array>;
  /** segundos gravados até agora */
  seconds(): number;
}

export async function gravar(): Promise<Gravacao> {
  if (Capacitor.isNativePlatform()) {
    const r = await Perm.requestPermissions({ permissions: ['mic'] }).catch(() => ({ mic: 'granted' }));
    if (r.mic && r.mic !== 'granted') throw new Error('Sem permissão do microfone. Libere em Ajustes do Android → Apps → PN Studio → Permissões.');
  }
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Este aparelho não deixa gravar o microfone pelo app.');
  // cancelamento de eco: dá para tocar o vídeo enquanto fala sem o som dele entrar forte na gravação
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  const ctx = new AudioContext();
  const src = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const parts: Float32Array[] = [];
  let total = 0;
  proc.onaudioprocess = (e) => {
    const d = e.inputBuffer.getChannelData(0);
    parts.push(new Float32Array(d));
    total += d.length;
  };
  // ligado num ganho zero: o ScriptProcessor só roda se estiver conectado à saída
  const mute = ctx.createGain();
  mute.gain.value = 0;
  src.connect(proc);
  proc.connect(mute);
  mute.connect(ctx.destination);
  const rate = ctx.sampleRate;
  return {
    seconds: () => total / rate,
    async stop() {
      proc.disconnect();
      src.disconnect();
      mute.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      await ctx.close().catch(() => undefined);
      const all = new Float32Array(total);
      let o = 0;
      for (const p of parts) {
        all.set(p, o);
        o += p.length;
      }
      // reamostra para 16 kHz (média das amostras de cada intervalo)
      const ratio = rate / RATE;
      const n = Math.floor(all.length / ratio);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const a = Math.floor(i * ratio);
        const b = Math.max(a + 1, Math.floor((i + 1) * ratio));
        let s = 0;
        for (let j = a; j < b && j < all.length; j++) s += all[j]!;
        out[i] = s / (b - a);
      }
      return out;
    },
  };
}
