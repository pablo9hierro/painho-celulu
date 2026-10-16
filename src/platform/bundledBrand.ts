/**
 * Logos oficiais que já vêm dentro do app, com a transparência original
 * (não passam por upload, então nada converte para JPG nem cria fundo).
 */
import type { MediaAsset } from '../core/model';
import horizontalUrl from '../assets/pn-logo-horizontal.png';
import normalUrl from '../assets/pn-logo-normal.png';
import azulUrl from '../assets/logos/pn-3d-azul.webp';
import sireneUrl from '../assets/logos/pn-3d-sirene.webp';
import luzesUrl from '../assets/logos/pn-3d-luzes.webp';
import vermelhoUrl from '../assets/logos/pn-3d-vermelho.webp';
import horizontalLuzesUrl from '../assets/logos/pn-horizontal-luzes.webp';
import horizontalAzulUrl from '../assets/logos/pn-horizontal-azul.webp';

function asset(id: string, name: string, url: string, width: number, height: number): MediaAsset {
  return {
    id,
    name,
    url,
    width,
    height,
    kind: 'image',
    brand: true,
    duration: 0,
    fps: 0,
    hasAudio: false,
    status: 'ready',
    thumbs: null,
    waveform: null,
    size: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

/** Logos 3D enviadas pela redação (PNG transparente → WebP com transparência). */
export const BUNDLED_LOGOS: MediaAsset[] = [
  asset('brand:pn-3d-azul', 'PN 3D azul', azulUrl, 1254, 1254),
  asset('brand:pn-3d-sirene', 'PN 3D sirene', sireneUrl, 1254, 1254),
  asset('brand:pn-3d-luzes', 'PN 3D luzes', luzesUrl, 1254, 1254),
  asset('brand:pn-3d-vermelho', 'PN 3D vermelho', vermelhoUrl, 1254, 1254),
  asset('brand:pn-horizontal-luzes', 'PN horizontal luzes', horizontalLuzesUrl, 1672, 941),
  asset('brand:pn-horizontal-azul', 'PN horizontal azul', horizontalAzulUrl, 1672, 941),
];

/** No app (modo local) as duas logos básicas também vêm embutidas; no PC elas vêm da pasta brand/. */
export const BUNDLED_BASIC: MediaAsset[] = [
  asset('brand:logo-horizontal', 'Logo horizontal', horizontalUrl, 1572, 516),
  asset('brand:logo-normal', 'Logo normal', normalUrl, 1214, 1058),
];

const BUNDLED_IDS = new Set([...BUNDLED_LOGOS, ...BUNDLED_BASIC].map((m) => m.id));
export const isBundledBrand = (m: { id: string }) => BUNDLED_IDS.has(m.id);

/**
 * Cópias das mesmas logos que estavam na pasta brand/ do PC: escondidas das
 * listas (para não aparecer duas vezes), mas continuam valendo em projetos que já as usam.
 */
const SUPERSEDED = new Set([
  ...['00_32_45', '00_32_52', '00_33_03', '00_32_57', '00_28_44'].map((s) => `Imagem do ChatGPT 15 de out. de 2026_ ${s}`),
  'Logo 3D Primeiras Notícias em Azul',
]);
export const isSupersededBrand = (m: { name: string }) => SUPERSEDED.has(m.name.replace(/\.png$/i, ''));
