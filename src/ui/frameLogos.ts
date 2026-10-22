/**
 * Logos usadas nas molduras: a horizontal (cabeçalho) e a redonda (marca grande
 * que passa no fundo). O usuário escolhe qual imagem é a padrão de cada tipo;
 * a escolha fica salva no aparelho e vale para todas as molduras.
 */
import type { MediaAsset } from '../core/model';
import { setLogoOverride } from '../render/brandAssets';
import { BUNDLED_BASIC, BUNDLED_LOGOS } from '../platform/bundledBrand';
import horizontalUrl from '../assets/pn-logo-horizontal.png';
import roundUrl from '../assets/pn-logo-round-fina.png';
import normalUrl from '../assets/pn-logo-normal.png';

export type FrameLogoKind = 'horizontal' | 'round' | 'outro';
export const BUILTIN = 'builtin';
export const BUILTIN_URL: Record<FrameLogoKind, string> = { horizontal: horizontalUrl, round: roundUrl, outro: normalUrl };

const key = (k: FrameLogoKind) => `pn-frame-logo-${k}`;

export function getFrameLogo(kind: FrameLogoKind): string {
  try {
    return localStorage.getItem(key(kind)) || BUILTIN;
  } catch {
    return BUILTIN;
  }
}

function urlFor(id: string, media: Record<string, MediaAsset>): string | null {
  if (id === BUILTIN) return null;
  // logos embutidas no app valem mesmo antes da lista de mídia carregar
  return media[id]?.url ?? [...BUNDLED_LOGOS, ...BUNDLED_BASIC].find((b) => b.id === id)?.url ?? null;
}

/** Aplica as logos escolhidas (chamado ao abrir o editor e ao trocar a padrão). */
export function applyFrameLogos(media: Record<string, MediaAsset>) {
  for (const kind of ['horizontal', 'round', 'outro'] as const) {
    void setLogoOverride(kind, urlFor(getFrameLogo(kind), media));
  }
}

export function setFrameLogo(kind: FrameLogoKind, id: string, media: Record<string, MediaAsset>) {
  try {
    localStorage.setItem(key(kind), id);
  } catch {
    /* sem armazenamento: vale só nesta sessão */
  }
  void setLogoOverride(kind, urlFor(id, media));
}

/** Encerramento automático no fim de toda exportação (ligado por padrão). */
const OUTRO_KEY = 'pn-outro-auto';
export function outroAuto(): boolean {
  try {
    return localStorage.getItem(OUTRO_KEY) !== '0';
  } catch {
    return true;
  }
}
export function setOutroAuto(on: boolean) {
  try {
    localStorage.setItem(OUTRO_KEY, on ? '1' : '0');
  } catch {
    /* sem armazenamento */
  }
}
