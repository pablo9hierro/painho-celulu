/**
 * Seleção da plataforma. A interface React é a mesma em todo lugar; o que muda
 * é quem atende por baixo:
 * - LOCAL (app Android, build com VITE_PLATFORM=local, ou ?local=1): tudo no
 *   próprio aparelho — IndexedDB, processamento de mídia no app e exportação
 *   por WebCodecs. Não precisa de servidor nem de internet.
 * - SERVIDOR (PC em desenvolvimento): API Node local com SQLite e FFmpeg.
 */
import { Capacitor } from '@capacitor/core';
import type { Exporter, MediaService, ProjectStore } from './types';
import { serverExporter, serverHealth, serverMedia, serverProjects } from './server';
import { localMedia } from './local/localMedia';
import { localProjects } from './local/localProjects';
import { localExporter } from '../engine/webcodecsExporter';
import { withCutout } from './imagePrep';

export type { ExportProgress, ExportSettings, ProjectSummary } from './types';
export { deviceStorage } from './device';

function detectLocal(): boolean {
  if (Capacitor.isNativePlatform()) return true;
  if (import.meta.env.VITE_PLATFORM === 'local') return true;
  try {
    if (new URLSearchParams(location.search).get('local') === '1') sessionStorage.setItem('pn-local', '1');
    return sessionStorage.getItem('pn-local') === '1';
  } catch {
    return false;
  }
}

export const IS_LOCAL = detectLocal();

export const projects: ProjectStore = IS_LOCAL ? localProjects : serverProjects;
// todo upload de imagem remove fundo liso (logo que virou JPG com fundo branco)
export const media: MediaService = withCutout(IS_LOCAL ? localMedia : serverMedia);
export const exporter: Exporter = IS_LOCAL ? localExporter : serverExporter;

export async function health(): Promise<{ ok: boolean; ffmpeg: string | null; error: string | null }> {
  if (IS_LOCAL) {
    const ok = typeof VideoEncoder !== 'undefined';
    return { ok, ffmpeg: null, error: ok ? null : 'Este aparelho não suporta exportação de vídeo (WebCodecs). Atualize o Chrome/Android System WebView.' };
  }
  return serverHealth();
}
