/**
 * Carimbo da logo nas manchetes: tamanho e posição valem para TODAS as
 * manchetes do app. O jornalista ajusta (controle deslizante + arrastar) e o
 * valor fica salvo no aparelho; depois pode virar o padrão fixo do app.
 */
export interface StampConfig {
  /** largura da logo em fração da largura da manchete (0,15 = 15%) */
  size: number;
  /** centro da logo em fração da manchete (0 = esquerda/topo, 1 = direita/base) */
  x: number;
  y: number;
}

/** padrão do app (o de antes dos ajustes manuais: 15%, posição 88% / 55%) */
export const STAMP_DEFAULT: StampConfig = { size: 0.15, x: 0.88, y: 0.55 };

const KEY = 'pn-stamp-config-v2';
const listeners = new Set<() => void>();
let current: StampConfig | null = null;
let version = 0;

const clamp = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

export function getStamp(): StampConfig {
  if (current) return current;
  let saved: Partial<StampConfig> = {};
  try {
    saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<StampConfig>;
  } catch {
    saved = {};
  }
  current = {
    size: clamp(saved.size, 0.05, 0.8, STAMP_DEFAULT.size),
    x: clamp(saved.x, -0.2, 1.2, STAMP_DEFAULT.x),
    y: clamp(saved.y, -0.5, 1.5, STAMP_DEFAULT.y),
  };
  return current;
}

export function setStamp(v: Partial<StampConfig> | null) {
  current = v ? { ...getStamp(), ...v } : { ...STAMP_DEFAULT };
  try {
    if (v) localStorage.setItem(KEY, JSON.stringify(current));
    else localStorage.removeItem(KEY);
  } catch {
    /* sem armazenamento: vale nesta sessão */
  }
  version++;
  listeners.forEach((l) => l());
}

export const stampVersion = () => version;
export function onStampChange(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
