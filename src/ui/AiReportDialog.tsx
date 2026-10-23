/**
 * Relatório de gasto com IA: acumulado, por dia/semana e cada disparo
 * (quando, para quê, quanto custou). Tudo guardado só neste aparelho.
 */
import { useEffect, useMemo, useState } from 'react';
import { aiLogByDay, aiLogByWeek, brl, FALLBACK_RATE, getAiLog, getSpend, usdBrl, type AiCall } from '../news/cost';
import { useBackHandler } from '../platform/backButton';
import { IconClose } from './icons';

const WHAT_LABEL: Record<string, string> = {
  texto: 'Escrever matéria',
  'post em vídeo': 'Título/legenda do post em vídeo',
  legendas: 'Transcrever e gerar legendas',
  'editar vídeo': 'Editar vídeo por comando de IA',
  outros: 'Outros',
};

export function AiReportDialog({ onClose }: { onClose: () => void }) {
  useBackHandler(true, onClose);
  const [log, setLog] = useState<AiCall[]>(getAiLog);
  const [rate, setRate] = useState(FALLBACK_RATE);
  const [modo, setModo] = useState<'dia' | 'semana'>('dia');
  const spend = getSpend();

  useEffect(() => {
    void usdBrl(async (u) => (await fetch(u)).json()).then((fx) => setRate(fx.rate));
    const on = () => setLog(getAiLog());
    window.addEventListener('pn-ai-spend', on);
    return () => window.removeEventListener('pn-ai-spend', on);
  }, []);

  const porPeriodo = useMemo(() => (modo === 'dia' ? aiLogByDay(log) : aiLogByWeek(log)), [log, modo]);
  const porFuncao = useMemo(() => {
    const by = new Map<string, { usd: number; uses: number }>();
    for (const c of log) {
      const cur = by.get(c.what) ?? { usd: 0, uses: 0 };
      by.set(c.what, { usd: cur.usd + c.usd, uses: cur.uses + 1 });
    }
    return [...by.entries()].sort((a, b) => b[1].usd - a[1].usd);
  }, [log]);
  const recentes = [...log].reverse().slice(0, 60);

  return (
    <div className="modal-back" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal post-modal ai-report" role="dialog" aria-label="Relatório de IA" data-testid="ai-report-dialog">
        <div className="modal-head">
          <h3>Relatório de IA</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Fechar">
            <IconClose />
          </button>
        </div>
        <div className="modal-body">
          <p className="hint">Quanto a IA gastou neste aparelho: acumulado, por dia/semana e cada disparo. Guardado só aqui, ninguém mais vê.</p>

          <div className="ai-report-total" data-testid="ai-report-total">
            <strong>Total acumulado: {brl(spend.usd, rate)}</strong>
            <span className="small muted">{spend.uses} disparo(s) no total · {log.length} no histórico detalhado</span>
          </div>

          {porFuncao.length > 0 && (
            <section className="preset-section">
              <h4>Por função</h4>
              <div className="ai-report-rows">
                {porFuncao.map(([what, v]) => (
                  <div key={what} className="ai-report-row" data-testid="ai-report-funcao">
                    <span>{WHAT_LABEL[what] ?? what}</span>
                    <span>
                      {brl(v.usd, rate)} · {v.uses}×
                    </span>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="preset-section">
            <div className="row-between">
              <h4>Ao longo do tempo</h4>
              <div className="seg sm" role="tablist">
                <button className={modo === 'dia' ? 'on' : ''} onClick={() => setModo('dia')} data-testid="ai-report-dia">
                  Por dia
                </button>
                <button className={modo === 'semana' ? 'on' : ''} onClick={() => setModo('semana')} data-testid="ai-report-semana">
                  Por semana
                </button>
              </div>
            </div>
            {porPeriodo.length === 0 && <p className="small muted">Nenhum uso de IA registrado ainda.</p>}
            <div className="ai-report-rows" data-testid="ai-report-periodo">
              {porPeriodo.slice(0, 30).map((p) => (
                <div key={'dia' in p ? p.dia : p.semana} className="ai-report-row">
                  <span>{new Date((('dia' in p ? p.dia : p.semana) as string) + 'T12:00:00').toLocaleDateString('pt-BR')}</span>
                  <span>
                    {brl(p.usd, rate)} · {p.uses}×
                  </span>
                </div>
              ))}
            </div>
          </section>

          <section className="preset-section">
            <h4>Últimos disparos</h4>
            {recentes.length === 0 && <p className="small muted">Nenhum disparo ainda.</p>}
            <div className="ai-report-rows" data-testid="ai-report-recentes">
              {recentes.map((c, i) => (
                <div key={i} className="ai-report-row small">
                  <span>
                    {new Date(c.at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} · {WHAT_LABEL[c.what] ?? c.what}
                  </span>
                  <span>{brl(c.usd, rate)}</span>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
