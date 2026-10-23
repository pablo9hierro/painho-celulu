/**
 * Reserva do "Baixar vídeo": quando o Instagram não libera o vídeo direto, o
 * app abre os sites tipo SnapInsta (fastdl, sssinstagram, igram) num
 * navegador escondido do Android e pega o link do arquivo, um site depois do
 * outro até um dar certo.
 */
import { Capacitor, registerPlugin } from '@capacitor/core';
import { EXTRATOR_SITES, extratorScript } from '../news/extratorScript';

interface ExtratorPlugin {
  extrair(o: { site: string; script: string; timeoutMs?: number }): Promise<{ link: string; site: string }>;
}
const Native = registerPlugin<ExtratorPlugin>('Extrator');

export const extratorDisponivel = Capacitor.isNativePlatform();

/** link do arquivo do Reels pelos sites de download (ou erro com o que cada um respondeu) */
export async function linkPorSites(reel: string, steps: string[], onSite?: (host: string) => void): Promise<{ link: string; site: string }> {
  const falhas: string[] = [];
  for (const site of EXTRATOR_SITES) {
    const host = new URL(site).hostname;
    onSite?.(host);
    try {
      const r = await Native.extrair({ site, script: extratorScript(reel), timeoutMs: 45_000 });
      steps.push(`${host}: link ok`);
      return r;
    } catch (e) {
      const m = (e as Error).message;
      steps.push(`${host}: ${m}`);
      falhas.push(m);
    }
  }
  throw new Error(falhas.join(' · ') || 'nenhum site respondeu');
}
