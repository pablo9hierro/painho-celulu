/**
 * Quanto a IA custou: nesta sessão (desde que o app abriu) e no total do
 * aparelho, em reais, por função. Atualiza na hora a cada uso.
 */
import { useEffect, useState } from 'react';
import { brl, getSpend, FALLBACK_RATE, usdBrl, type Spend } from '../news/cost';

let rate = FALLBACK_RATE;
let rateP: Promise<void> | null = null;

export function AiSpend({ compact = false }: { compact?: boolean }) {
  const [s, setS] = useState<Spend>(getSpend);
  const [r, setR] = useState(rate);
  useEffect(() => {
    const on = (e: Event) => setS((e as CustomEvent<Spend>).detail ?? getSpend());
    window.addEventListener('pn-ai-spend', on);
    rateP ??= usdBrl(async (u) => (await fetch(u)).json()).then((fx) => {
      rate = fx.rate;
    });
    void rateP.then(() => setR(rate));
    return () => window.removeEventListener('pn-ai-spend', on);
  }, []);
  const by = Object.entries(s.by).sort((a, b) => b[1] - a[1]);
  if (compact)
    return (
      <span className="ai-spend small muted" data-testid="ai-spend" title={by.map(([k, v]) => `${k}: ${brl(v, r)}`).join(' · ')}>
        IA nesta sessão: {brl(s.sessionUsd, r)} · total: {brl(s.usd, r)}
      </span>
    );
  return (
    <div className="ai-spend small" data-testid="ai-spend">
      <strong>Gasto com IA</strong>
      <span>
        Nesta sessão: <b>{brl(s.sessionUsd, r)}</b> ({s.sessionUses} uso{s.sessionUses === 1 ? '' : 's'}) · Total no aparelho: <b>{brl(s.usd, r)}</b> ({s.uses} uso{s.uses === 1 ? '' : 's'})
      </span>
      {by.length > 0 && <span className="muted">{by.map(([k, v]) => `${k}: ${brl(v, r)}`).join(' · ')}</span>}
    </div>
  );
}
