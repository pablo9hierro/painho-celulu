/**
 * Serviço nativo do Postador automático (Android): notificação fixa, CPU
 * acordada e "tique" a cada 5 min mesmo com a tela bloqueada. No navegador
 * (prévia no PC) não faz nada.
 */
import { Capacitor, registerPlugin } from '@capacitor/core';

interface PostadorPlugin {
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): Promise<{ ligado: boolean; semEconomiaBateria: boolean }>;
  pedirBateria(): Promise<void>;
  aviso(o: { texto: string }): Promise<void>;
}
const Native = registerPlugin<PostadorPlugin>('Postador');
const isNative = Capacitor.isNativePlatform();

export const postadorNative = {
  disponivel: isNative,
  start: () => (isNative ? Native.start() : Promise.resolve()),
  stop: () => (isNative ? Native.stop() : Promise.resolve()),
  status: () => (isNative ? Native.status() : Promise.resolve({ ligado: false, semEconomiaBateria: true })),
  pedirBateria: () => (isNative ? Native.pedirBateria() : Promise.resolve()),
  /** texto da notificação fixa (também mantém o app trabalhando fora da tela) */
  aviso: (texto: string) => (isNative ? Native.aviso({ texto }).catch(() => undefined) : Promise.resolve()),
};
