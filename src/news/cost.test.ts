import { beforeEach, describe, expect, it, vi } from 'vitest';
import { aiLogByDay, aiLogByWeek, getAiLog, getSpend, recordAi } from './cost';

const mem = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};
(globalThis as { window?: unknown }).window = globalThis;
(globalThis as { CustomEvent?: unknown }).CustomEvent = class { type: string; detail: unknown; constructor(t: string, o: { detail: unknown }) { this.type = t; this.detail = o.detail; } };
if (!(globalThis as { addEventListener?: unknown }).addEventListener) (globalThis as { addEventListener: () => void }).addEventListener = () => undefined;
(globalThis as { dispatchEvent?: unknown }).dispatchEvent = () => undefined;

describe('relatório de gasto com IA: acumulado, por função e por dia/semana', () => {
  beforeEach(() => mem.clear());

  it('acumula por função e guarda o histórico de cada disparo', () => {
    recordAi(0.001, 'texto');
    recordAi(0.002, 'legendas');
    recordAi(0.0005, 'texto');
    const s = getSpend();
    expect(s.uses).toBe(3);
    expect(s.by.texto).toBeCloseTo(0.0015, 4);
    expect(s.by.legendas).toBeCloseTo(0.002, 4);
    expect(getAiLog()).toHaveLength(3);
  });

  it('agrupa por dia e por semana', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-20T15:00:00-03:00')); // terça
    recordAi(0.001, 'texto');
    vi.setSystemTime(new Date('2026-10-21T15:00:00-03:00')); // quarta, mesma semana
    recordAi(0.002, 'texto');
    vi.setSystemTime(new Date('2026-10-27T15:00:00-03:00')); // terça seguinte
    recordAi(0.003, 'texto');
    vi.useRealTimers();
    const dias = aiLogByDay(getAiLog());
    expect(dias).toHaveLength(3);
    expect(dias[0]!.dia).toBe('2026-10-27'); // mais recente primeiro
    const semanas = aiLogByWeek(getAiLog());
    expect(semanas).toHaveLength(2);
    expect(semanas[0]!.uses).toBe(1); // semana da terça 27
    expect(semanas[1]!.uses).toBe(2); // semana de 20-21 (segunda a domingo)
  });
});
