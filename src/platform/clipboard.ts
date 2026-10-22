/**
 * Área de transferência que funciona no celular: no app usa o plugin nativo
 * (o WebView do Android bloqueia a leitura do navegador); no PC, o navegador.
 */
import { Capacitor } from '@capacitor/core';
import { Clipboard } from '@capacitor/clipboard';

export async function readClipboard(): Promise<string> {
  if (Capacitor.isNativePlatform()) {
    const r = await Clipboard.read();
    return (r.value ?? '').trim();
  }
  return ((await navigator.clipboard.readText()) ?? '').trim();
}

export async function writeClipboard(text: string): Promise<void> {
  if (Capacitor.isNativePlatform()) return Clipboard.write({ string: text });
  return navigator.clipboard.writeText(text);
}
