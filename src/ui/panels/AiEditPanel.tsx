/**
 * Edição por voz (ou texto): o microfone liga e desliga SÓ no seu dedo — grava
 * o tempo que quiser, sem cortar nas pausas. Ao desligar, a fala é transcrita
 * e cai no campo de texto, onde dá para corrigir/apagar à vontade antes de
 * adicionar o comando. Os comandos na fila também podem ser editados antes de
 * executar. A IA recebe a transcrição do vídeo com o tempo de cada palavra
 * (feita sozinha na primeira execução), para cortar no lugar certo.
 */
import { useEffect, useRef, useState } from 'react';
import { gravar, type Gravacao } from '../../platform/gravador';
import { transcribeWav } from '../../news/transcribe';
import { getAiKey } from '../../news/client';
import { wavBase64 } from '../captions';
import { clearDone, describeAction, editCommand, queueCommand, removeCommand, runQueue, useAiEditQueue } from '../aiEdit';
import { useEditor } from '../../state/store';
import { AiSpend } from '../AiSpend';
import { IconMic, IconTrash } from '../icons';

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export function AiEditPanel() {
  const notify = useEditor((s) => s.notify);
  const queue = useAiEditQueue();
  const [rec, setRec] = useState<Gravacao | null>(null);
  const [secs, setSecs] = useState(0);
  const [transcrevendo, setTranscrevendo] = useState(false);
  const [texto, setTexto] = useState('');
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState('');
  const recRef = useRef<Gravacao | null>(null);

  // ao sair do painel com o microfone ligado, desliga (sem transcrever)
  useEffect(() => () => void recRef.current?.stop(), []);
  useEffect(() => {
    if (!rec) return;
    const id = window.setInterval(() => setSecs(rec.seconds()), 250);
    return () => window.clearInterval(id);
  }, [rec]);

  const toggle = async () => {
    if (!rec) {
      try {
        const g = await gravar();
        recRef.current = g;
        setRec(g);
        setSecs(0);
      } catch (e) {
        notify((e as Error).message, 'error');
      }
      return;
    }
    const g = rec;
    setRec(null);
    recRef.current = null;
    const pcm = await g.stop();
    const dur = pcm.length / 16_000;
    if (dur < 0.5) return;
    const key = getAiKey();
    if (!key) {
      notify('Coloque a chave da IA em ⚙ Configurações.', 'error');
      return;
    }
    setTranscrevendo(true);
    try {
      const r = await transcribeWav(key, wavBase64(pcm), dur);
      const falado = r.segmentos.map((s) => s.texto).join(' ').trim();
      if (!falado) notify('Não deu para entender a fala. Tente de novo, mais perto do microfone.', 'error');
      else setTexto((cur) => (cur.trim() ? `${cur.trim()} ${falado}` : falado));
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally {
      setTranscrevendo(false);
    }
  };

  const add = () => {
    if (!texto.trim()) return;
    queueCommand(texto);
    setTexto('');
  };

  const run = async () => {
    setBusy(true);
    try {
      await runQueue(setStep);
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally {
      setBusy(false);
      setStep('');
    }
  };

  const pendentes = queue.filter((c) => c.status === 'pendente').length;

  return (
    <section className="preset-section ai-edit" data-testid="ai-edit-panel">
      <p className="hint">
        Toque no microfone, fale o que quer mudar (corte, velocidade, manchete, zoom, desfoque) pelo tempo que quiser e toque de novo para parar. O texto aparece
        abaixo para você corrigir antes de adicionar.
      </p>
      <button className={`btn wide mic-btn ${rec ? 'primary on' : ''}`} disabled={transcrevendo} onClick={() => void toggle()} data-testid="mic-toggle">
        <IconMic /> {rec ? `Gravando ${fmt(secs)} — toque para parar` : transcrevendo ? 'Transcrevendo a fala…' : 'Ligar microfone'}
      </button>
      <textarea
        className="input ai-edit-input"
        rows={3}
        placeholder="o que você falar aparece aqui (ou digite o comando)"
        value={texto}
        onChange={(e) => setTexto(e.target.value)}
        data-testid="ai-edit-text"
      />
      <button className="btn" disabled={!texto.trim()} onClick={add} data-testid="ai-edit-add">
        Adicionar à lista
      </button>
      {queue.length > 0 && (
        <div className="ai-edit-queue" data-testid="ai-edit-queue">
          {queue.map((c) => (
            <div key={c.id} className={`ai-edit-cmd st-${c.status}`} data-testid="ai-edit-cmd">
              {c.status === 'pendente' ? (
                <textarea className="input ai-edit-cmd-text" rows={2} value={c.texto} onChange={(e) => editCommand(c.id, e.target.value)} aria-label="Editar comando" data-testid="ai-edit-cmd-text" />
              ) : (
                <span className="ai-edit-text">"{c.texto}"</span>
              )}
              <span className="small muted">
                {c.status === 'pendente' && 'na fila (dá para editar o texto antes de executar)'}
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
      <div className="row-gap wrap">
        <button className="btn primary" disabled={busy || !pendentes} onClick={() => void run()} data-testid="ai-edit-run">
          {busy ? step || 'Executando…' : `Executar${pendentes ? ` (${pendentes})` : ''}`}
        </button>
        {queue.some((c) => c.status !== 'pendente') && (
          <button className="btn" onClick={clearDone} data-testid="ai-edit-clear">
            Limpar feitos
          </button>
        )}
      </div>
      <AiSpend compact />
    </section>
  );
}
