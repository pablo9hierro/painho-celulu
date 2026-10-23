/**
 * Ditado contínuo (comando de voz): liga e fica ouvindo até você desligar, sem
 * timeout. No celular usa o reconhecedor do Android (plugin Ditado); no PC
 * (só prévia) usa o reconhecimento de voz do navegador, se o Chrome tiver.
 */
import { Capacitor, registerPlugin } from '@capacitor/core';

interface DitadoPlugin {
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): Promise<{ ouvindo: boolean; disponivel: boolean }>;
  addListener(event: 'ditado-comando' | 'ditado-parcial' | 'ditado-status' | 'ditado-erro' | 'ditado-pronto', cb: (d: Record<string, unknown>) => void): Promise<{ remove: () => void }>;
}
const Native = registerPlugin<DitadoPlugin>('Ditado');
const isNative = Capacitor.isNativePlatform();

type SR = typeof window extends { webkitSpeechRecognition: infer T } ? T : never;
let webRec: InstanceType<NonNullable<SR>> | null = null;
let webWant = false;

function webAvailable(): boolean {
  return typeof window !== 'undefined' && !!(window as unknown as { webkitSpeechRecognition?: unknown; SpeechRecognition?: unknown }).webkitSpeechRecognition;
}

export interface DitadoHandlers {
  onComando: (texto: string) => void;
  onParcial?: (texto: string) => void;
  onStatus?: (ouvindo: boolean) => void;
  onErro?: (mensagem: string) => void;
  /** o microfone abriu de verdade e está pronto para captar a fala (confirma que não é só o loop) */
  onPronto?: () => void;
}

export const ditado = {
  disponivel: isNative || webAvailable(),
  /** é a escuta do navegador (prévia no PC): menos confiável, só para testar a tela */
  web: !isNative,

  async start(h: DitadoHandlers): Promise<() => void> {
    if (isNative) {
      const subs = await Promise.all([
        Native.addListener('ditado-comando', (d) => h.onComando(String(d.texto ?? ''))),
        Native.addListener('ditado-parcial', (d) => h.onParcial?.(String(d.texto ?? ''))),
        Native.addListener('ditado-status', (d) => h.onStatus?.(!!d.ouvindo)),
        Native.addListener('ditado-erro', (d) => h.onErro?.(String(d.mensagem ?? ''))),
        Native.addListener('ditado-pronto', () => h.onPronto?.()),
      ]);
      await Native.start();
      return () => {
        void Native.stop();
        subs.forEach((s) => s.remove());
      };
    }
    // PC: Web Speech API (Chrome). Reinicia sozinho a cada pausa, igual ao celular.
    if (!webAvailable()) {
      h.onErro?.('Este navegador não tem reconhecimento de voz (funciona no Chrome do celular/PC).');
      return () => undefined;
    }
    webWant = true;
    const Ctor = (window as unknown as { webkitSpeechRecognition: new () => InstanceType<NonNullable<SR>> }).webkitSpeechRecognition;
    const run = () => {
      if (!webWant) return;
      const r = new Ctor();
      webRec = r;
      (r as unknown as { lang: string; continuous: boolean; interimResults: boolean }).lang = 'pt-BR';
      (r as unknown as { continuous: boolean }).continuous = false;
      (r as unknown as { interimResults: boolean }).interimResults = true;
      (r as unknown as { onresult: (e: unknown) => void }).onresult = (e: unknown) => {
        const ev = e as { results: { isFinal: boolean; 0: { transcript: string } }[] };
        const last = ev.results[ev.results.length - 1];
        if (!last) return;
        if (last.isFinal) h.onComando(last[0].transcript.trim());
        else h.onParcial?.(last[0].transcript);
      };
      (r as unknown as { onstart: () => void }).onstart = () => h.onPronto?.();
      (r as unknown as { onend: () => void }).onend = () => {
        if (webWant) run();
        else h.onStatus?.(false);
      };
      (r as unknown as { onerror: () => void }).onerror = () => {
        if (webWant) run();
      };
      (r as unknown as { start: () => void }).start();
    };
    run();
    h.onStatus?.(true);
    return () => {
      webWant = false;
      (webRec as unknown as { stop?: () => void } | null)?.stop?.();
      webRec = null;
    };
  },
};
