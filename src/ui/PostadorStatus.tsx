/**
 * "O que o Postador está fazendo agora": barra fina que aparece em QUALQUER tela
 * do app enquanto um trabalho roda (o trabalho continua mesmo trocando de tela).
 */
import { useEffect, useState } from 'react';
import { getAutopostStatus, onAutopostStatus, type AutoStatus } from '../news/autopostApp';

export function useAutopostStatus(): AutoStatus {
  const [s, setS] = useState(getAutopostStatus);
  useEffect(() => onAutopostStatus(setS), []);
  return s;
}

/** cartão com o passo atual, % e fila (usado na aba do Postador) */
export function PostadorStatusCard() {
  const s = useAutopostStatus();
  if (!s.job && !s.last) return null;
  return (
    <div className={`postador-status ${s.job ? 'on' : s.last?.ok ? 'ok' : 'err'}`} data-testid="postador-status">
      {s.job ? (
        <>
          <strong>⏳ {s.job}</strong>
          <span className="small">{s.step || 'Trabalhando…'}</span>
          {s.pct !== null && (
            <div className="postador-bar">
              <i style={{ width: `${Math.round(s.pct * 100)}%` }} />
            </div>
          )}
          {s.queue.length > 0 && <span className="small muted">Na fila: {s.queue.join(' · ')}</span>}
          <span className="small muted">Pode navegar pelo app ou sair dele: continua trabalhando.</span>
        </>
      ) : (
        <span className="small">{s.last!.ok ? '✓ ' : '⚠ '}{s.last!.msg}</span>
      )}
    </div>
  );
}

/** barra global (fora da aba do Postador) */
export function PostadorStatusBar() {
  const s = useAutopostStatus();
  if (!s.job) return null;
  return (
    <div className="postador-global" data-testid="postador-global">
      <span>⏳ {s.job}: {s.step}{s.pct !== null ? ` ${Math.round(s.pct * 100)}%` : ''}</span>
    </div>
  );
}
