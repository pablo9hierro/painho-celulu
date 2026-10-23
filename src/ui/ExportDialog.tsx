import { useEffect, useRef, useState } from 'react';
import { projectDuration } from '../core/timeline';
import { getEditor, useEditor } from '../state/store';
import { deviceStorage, exporter, type ExportProgress } from '../platform/api';
import { hasOutro, projectForExport, stopPlayback } from './commands';
import { outroAuto, setOutroAuto } from './frameLogos';

/** duração do encerramento automático (igual ao modelo pn-encerramento) */
const OUTRO_S = 3.5;
import { formatTime } from './Transport';
import { IconClose } from './icons';
import { useBackHandler } from '../platform/backButton';
import { keepAlive } from '../platform/keepAlive';

const QUALITY = [
  { id: 'high', label: 'Alta', crf: 16 },
  { id: 'std', label: 'Padrão', crf: 19 },
  { id: 'light', label: 'Leve', crf: 24 },
] as const;

export function ExportDialog({ onClose, onPost }: { onClose: () => void; onPost?: (videoFile: string, video: Blob) => void }) {
  const project = useEditor((s) => s.project)!;
  const duration = projectDuration(project);
  const [res, setRes] = useState<'full' | 'hd'>('full');
  const [quality, setQuality] = useState<(typeof QUALITY)[number]['id']>('std');
  const [fps, setFps] = useState<number>(project.fps);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [result, setResult] = useState<{ file: string; where: string; blob: Blob; url: string; seconds: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outro, setOutro] = useState(outroAuto);
  const willAddOutro = outro && duration > 0 && !hasOutro(project);
  const totalDuration = duration + (willAddOutro ? OUTRO_S : 0);
  const abort = useRef<AbortController | null>(null);
  // cada exportação tem um número; ao cancelar, o resultado da anterior é ignorado
  const run = useRef(0);
  const [running, setRunning] = useState(false);
  const started = useRef(0);

  // libera a prévia da memória ao fechar
  useEffect(() => () => {
    if (result) URL.revokeObjectURL(result.url);
  }, [result]);

  const scale = res === 'full' ? 1 : 720 / Math.min(project.width, project.height);
  const width = Math.round((project.width * scale) / 2) * 2;
  const height = Math.round((project.height * scale) / 2) * 2;

  const start = async () => {
    stopPlayback();
    setError(null);
    setResult(null);
    const ctrl = new AbortController();
    abort.current = ctrl;
    const my = ++run.current;
    setRunning(true);
    setProgress({ phase: 'preparing', frame: 0, total: 0, fps: 0 });
    started.current = performance.now();
    const alive = keepAlive();
    const report = (p: ExportProgress) => {
      if (run.current === my) setProgress(p);
    };
    try {
      // o encerramento entra só no vídeo exportado; o projeto salvo não muda
      const out = await projectForExport(project);
      if (run.current !== my) return;
      const { blob, fileName } = await exporter.exportVideo(
        out,
        getEditor().media,
        { width, height, fps, duration: projectDuration(out), crf: QUALITY.find((q) => q.id === quality)!.crf },
        report,
        ctrl.signal,
      );
      if (run.current !== my) return;
      // entrega à memória do dispositivo; o app não guarda cópia do vídeo final
      const where = await deviceStorage.saveVideo(blob, fileName);
      if (run.current !== my) return;
      setResult({ file: fileName, where, blob, url: URL.createObjectURL(blob), seconds: (performance.now() - started.current) / 1000 });
    } catch (e) {
      if (run.current !== my) return;
      if ((e as Error).name !== 'AbortError') setError((e as Error).message);
      setProgress(null);
    } finally {
      alive.release();
      if (run.current === my) {
        abort.current = null;
        setRunning(false);
      }
    }
  };

  // Cancelar: a tela volta na hora; a exportação em andamento para logo em seguida
  const cancel = () => {
    abort.current?.abort();
    abort.current = null;
    run.current++;
    setProgress(null);
    setRunning(false);
  };
  useEffect(() => () => abort.current?.abort(), []);

  const busy = running && !result;

  // botão voltar: fecha o diálogo (durante a exportação, não interrompe sem querer)
  useBackHandler(true, () => {
    if (!busy) onClose();
  });
  const pct = progress ? (progress.phase === 'encoding' ? 99 : progress.total ? Math.floor((progress.frame / progress.total) * 98) : 0) : 0;
  const eta = progress && progress.fps > 0 ? (progress.total - progress.frame) / progress.fps : null;

  return (
    <div className="modal-back" onPointerDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal" role="dialog" aria-label="Exportar vídeo" data-testid="export-dialog">
        <div className="modal-head">
          <h3>Exportar vídeo</h3>
          <button className="icon-btn" onClick={onClose} disabled={busy} aria-label="Fechar">
            <IconClose />
          </button>
        </div>

        {duration <= 0 ? (
          <p className="muted">A timeline está vazia.</p>
        ) : (
          <>
            {!busy && !result && (
              <div className="export-form">
                <div className="field">
                  <span>Resolução</span>
                  <div className="seg">
                    <button className={res === 'full' ? 'on' : ''} onClick={() => setRes('full')}>
                      {project.width}×{project.height}
                    </button>
                    <button className={res === 'hd' ? 'on' : ''} onClick={() => setRes('hd')}>
                      {Math.round((project.width * (720 / Math.min(project.width, project.height))) / 2) * 2}×
                      {Math.round((project.height * (720 / Math.min(project.width, project.height))) / 2) * 2}
                    </button>
                  </div>
                </div>
                <div className="field">
                  <span>Qualidade</span>
                  <div className="seg">
                    {QUALITY.map((q) => (
                      <button key={q.id} className={quality === q.id ? 'on' : ''} onClick={() => setQuality(q.id)}>
                        {q.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="field">
                  <span>Quadros por segundo</span>
                  <div className="seg">
                    {[24, 25, 30, 60].map((f) => (
                      <button key={f} className={fps === f ? 'on' : ''} onClick={() => setFps(f)}>
                        {f}
                      </button>
                    ))}
                  </div>
                </div>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={outro}
                    disabled={hasOutro(project)}
                    onChange={(e) => {
                      setOutro(e.target.checked);
                      setOutroAuto(e.target.checked);
                    }}
                    data-testid="export-outro"
                  />
                  {hasOutro(project) ? 'Encerramento @primeirasnoticias_ já está na timeline' : 'Encerramento @primeirasnoticias_ no final (+3,5 s)'}
                </label>
                <p className="muted small">
                  MP4 · H.264 + AAC · {formatTime(totalDuration, fps)} · {Math.round(totalDuration * fps)} quadros. Renderizado no seu computador com o mesmo motor do preview.
                </p>
                {error && <p className="error-text">{error}</p>}
                <button className="btn primary wide" onClick={() => void start()} data-testid="start-export">
                  Exportar MP4
                </button>
              </div>
            )}

            {busy && progress && (
              <div className="export-progress">
                <div className="bar big">
                  <div style={{ width: `${pct}%` }} />
                </div>
                <div className="row-between">
                  <span>
                    {progress.phase === 'preparing' && 'Preparando mídia…'}
                    {progress.phase === 'rendering' && `Quadro ${progress.frame} de ${progress.total}`}
                    {progress.phase === 'encoding' && 'Mixando áudio e finalizando…'}
                  </span>
                  <span className="muted">
                    {pct}%{eta !== null && progress.phase === 'rendering' ? ` · ~${Math.ceil(eta)} s` : ''}
                  </span>
                </div>
                <button className="btn" onClick={cancel} data-testid="cancel-export">
                  Cancelar
                </button>
              </div>
            )}

            {result && (
              <div className="export-done" data-testid="export-done">
                <video src={result.url} controls playsInline className="export-video" />
                <p className="small">
                  Salvo na memória do seu aparelho, em <strong>{result.where}</strong>: <strong>{result.file}</strong> · {result.seconds.toFixed(0)} s
                </p>
                <p className="muted small">O app não guarda cópia do vídeo final.</p>
                <div className="row-gap wrap">
                  {deviceStorage.share && (
                    <button className="btn primary" onClick={() => void deviceStorage.share!(result.file).catch(() => undefined)} data-testid="share-video">
                      Compartilhar
                    </button>
                  )}
                  <button className={`btn ${deviceStorage.share ? '' : 'primary'}`} onClick={() => void deviceStorage.saveVideo(result.blob, result.file)}>
                    Salvar novamente
                  </button>
                  <button className="btn ghost" onClick={() => setResult(null)}>
                    Nova exportação
                  </button>
                </div>
                {onPost && (
                  <button className="btn primary wide post-next" onClick={() => onPost(result.file, result.blob)} data-testid="go-post">
                    Publicar no Instagram · escrever a legenda
                  </button>
                )}
                <div>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
