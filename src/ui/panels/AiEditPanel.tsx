/**
 * Edição por voz (ou texto): botão de microfone liga e fica ouvindo até você
 * desligar — sem tempo limite. Cada frase falada entra numa lista de comandos;
 * dá pra ir editando o vídeo manualmente com o microfone ligado e só mandar
 * "Executar" quando quiser. A IA só lê a timeline (itens e, se já houver
 * legendas, o que é falado e quando) — ela não assiste ao vídeo.
 */
import { useEffect, useRef, useState } from 'react';
import { ditado } from '../../platform/ditado';
import { clearDone, describeAction, queueCommand, removeCommand, runQueue, useAiEditQueue } from '../aiEdit';
import { useEditor } from '../../state/store';
import { AiSpend } from '../AiSpend';
import { IconMic, IconTrash } from '../icons';

export function AiEditPanel() {
  const notify = useEditor((s) => s.notify);
  const queue = useAiEditQueue();
  const [ligado, setLigado] = useState(false);
  const [pronto, setPronto] = useState(false);
  const [parcial, setParcial] = useState('');
  const [texto, setTexto] = useState('');
  const [busy, setBusy] = useState(false);
  const stop = useRef<(() => void) | null>(null);

  useEffect(() => () => stop.current?.(), []);

  const toggle = async () => {
    if (ligado) {
      stop.current?.();
      stop.current = null;
      setLigado(false);
      setPronto(false);
      setParcial('');
      return;
    }
    if (!ditado.disponivel) {
      notify('Este aparelho não tem reconhecimento de voz.', 'error');
      return;
    }
    setPronto(false);
    stop.current = await ditado.start({
      onComando: (t) => {
        setParcial('');
        if (t) queueCommand(t);
      },
      onParcial: (t) => {
        setPronto(true);
        setParcial(t);
      },
      onPronto: () => setPronto(true),
      onStatus: setLigado,
      onErro: (m) => {
        notify(m, 'error');
        setPronto(false);
      },
    });
    setLigado(true);
  };

  const run = async () => {
    setBusy(true);
    try {
      await runQueue();
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const pendentes = queue.filter((c) => c.status === 'pendente').length;

  return (
    <section className="preset-section ai-edit" data-testid="ai-edit-panel">
      <p className="hint">
        Fale o que quer mudar no vídeo (corte, velocidade, manchete, zoom, desfoque). O microfone fica ligado até você desligar — pode continuar editando
        normalmente enquanto fala. {ditado.web && <strong> No PC é só uma prévia: o reconhecimento de verdade roda no app do celular.</strong>}
      </p>
      <button className={`btn wide mic-btn ${ligado ? 'primary on' : ''}`} onClick={() => void toggle()} data-testid="mic-toggle">
        <IconMic /> {ligado ? 'Microfone ligado (toque para desligar)' : 'Ligar microfone'}
      </button>
      {ligado && (
        <p className="small muted mic-live" data-testid="mic-parcial">
          {parcial ? `Ouvindo: "${parcial}"` : pronto ? 'Microfone aberto, pode falar…' : 'Abrindo o microfone…'}
        </p>
      )}
      <div className="post-search">
        <input
          className="input"
          placeholder="ou digite o comando aqui"
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && texto.trim()) {
              queueCommand(texto);
              setTexto('');
            }
          }}
          data-testid="ai-edit-text"
        />
        <button
          className="btn"
          disabled={!texto.trim()}
          onClick={() => {
            queueCommand(texto);
            setTexto('');
          }}
          data-testid="ai-edit-add"
        >
          Adicionar
        </button>
      </div>
      {queue.length > 0 && (
        <div className="ai-edit-queue" data-testid="ai-edit-queue">
          {queue.map((c) => (
            <div key={c.id} className={`ai-edit-cmd st-${c.status}`} data-testid="ai-edit-cmd">
              <span className="ai-edit-text">"{c.texto}"</span>
              <span className="small muted">
                {c.status === 'pendente' && 'na fila'}
                {c.status === 'rodando' && 'executando…'}
                {c.status === 'feito' && (c.acoes?.length ? c.acoes.map(describeAction).join(' · ') : 'feito')}
                {c.status === 'vazio' && (c.aviso || 'nada a fazer')}
                {c.status === 'erro' && `erro: ${c.erro}`}
              </span>
              <button className="icon-btn sm" aria-label="Remover comando" onClick={() => removeCommand(c.id)}>
                <IconTrash />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="row-gap">
        <button className="btn primary" disabled={busy || !pendentes} onClick={() => void run()} data-testid="ai-edit-run">
          {busy ? 'Executando…' : `Executar${pendentes ? ` (${pendentes})` : ''}`}
        </button>
        {queue.some((c) => c.status === 'feito') && (
          <button className="btn" onClick={clearDone} data-testid="ai-edit-clear">
            Limpar feitos
          </button>
        )}
      </div>
      <AiSpend compact />
    </section>
  );
}
