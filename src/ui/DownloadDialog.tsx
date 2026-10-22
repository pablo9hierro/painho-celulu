/**
 * Baixar vídeo por link (Reels do Instagram ou link direto). Deu certo: mostra
 * o vídeo e leva direto para a edição. Não deu: explica o motivo e oferece
 * importar o arquivo do aparelho (baixado pelo SnapInsta, por exemplo).
 */
import { useEffect, useRef, useState } from 'react';
import { useBackHandler } from '../platform/backButton';
import { deviceStorage, media as mediaApi, projects } from '../platform/api';
import { createProject, createVideoClip } from '../core/factory';
import { placeClip } from '../core/timeline';
import { downloadFromLink, type LinkDownloadError } from '../news/downloadClient';
import { waitReady } from './importer';
import { useEditor } from '../state/store';
import { IconClose } from './icons';

/** Envia o vídeo para a biblioteca e abre um projeto Reels com ele na timeline. */
async function editVideo(file: File): Promise<void> {
  const up = await mediaApi.upload(file);
  const m = await waitReady(up.id);
  if (m.status !== 'ready') throw new Error(m.error ?? 'Não foi possível processar o vídeo.');
  const name = `Matéria ${new Date().toLocaleDateString('pt-BR')} ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
  let p = createProject(name, 'reel');
  const main = p.tracks.find((t) => t.kind === 'visual');
  p = placeClip(p, createVideoClip(p, m, 0), main?.id);
  await projects.create(p);
  location.hash = `#/p/${p.id}`;
}

export function DownloadDialog({ onClose }: { onClose: () => void }) {
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState<'download' | 'edit' | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; steps: string[] } | null>(null);
  const [via, setVia] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const notify = useEditor((s) => s.notify);
  useBackHandler(true, () => !busy && onClose());
  useEffect(() => () => void (preview && URL.revokeObjectURL(preview)), [preview]);

  const take = (f: File, how: string) => {
    if (preview) URL.revokeObjectURL(preview);
    setFile(f);
    setVia(how);
    setPreview(URL.createObjectURL(f));
  };

  const download = async () => {
    if (!link.trim()) return;
    setBusy('download');
    setError(null);
    setFile(null);
    try {
      const r = await downloadFromLink(link.trim());
      take(r.file, r.via);
    } catch (e) {
      const err = e as LinkDownloadError;
      setError({ message: err.message, steps: err.steps ?? [] });
    } finally {
      setBusy(null);
    }
  };

  const paste = async () => {
    try {
      const t = await navigator.clipboard.readText();
      if (t) setLink(t.trim());
    } catch {
      /* sem permissão: o usuário cola manualmente */
    }
  };

  const edit = async () => {
    if (!file) return;
    setBusy('edit');
    try {
      await editVideo(file);
    } catch (e) {
      setError({ message: (e as Error).message, steps: [] });
      setBusy(null);
    }
  };

  return (
    <div className="modal-back" onPointerDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal post-modal" role="dialog" aria-label="Baixar vídeo" data-testid="download-dialog">
        <div className="modal-head">
          <h3>Baixar vídeo</h3>
          <button className="icon-btn" onClick={onClose} disabled={!!busy} aria-label="Fechar">
            <IconClose />
          </button>
        </div>
        <label className="field">
          <span>Link do Reels (ou link direto de um vídeo)</span>
          <div className="post-search">
            <input
              className="input"
              value={link}
              placeholder="https://www.instagram.com/reel/..."
              onChange={(e) => setLink(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void download()}
              inputMode="url"
              data-testid="dl-link"
            />
            <button className="btn" onClick={() => void paste()} type="button">
              Colar
            </button>
            <button className="btn primary" onClick={() => void download()} disabled={!!busy || !link.trim()} data-testid="dl-go">
              {busy === 'download' ? 'Baixando…' : 'Baixar'}
            </button>
          </div>
        </label>
        <p className="muted small">Funciona com Reels e posts de vídeo públicos. O Instagram às vezes limita downloads; se acontecer, o app avisa e você pode importar o arquivo.</p>

        {error && (
          <div className="post-warn" data-testid="dl-error">
            <p className="small" style={{ margin: 0 }}>
              {error.message}
            </p>
            {error.steps.length > 0 && (
              <details>
                <summary className="small muted">Detalhes</summary>
                <ul className="small muted">
                  {error.steps.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}

        {file && preview && (
          <div className="export-done" data-testid="dl-done">
            <video src={preview} controls playsInline className="export-video" />
            <p className="small muted">
              {file.name} · {(file.size / 1024 / 1024).toFixed(1)} MB{via ? ` · via ${via}` : ''} · arquivo conferido (não está corrompido)
            </p>
            <div className="row-gap wrap">
              <button className="btn primary" onClick={() => void edit()} disabled={!!busy} data-testid="dl-edit">
                {busy === 'edit' ? 'Abrindo…' : 'Editar este vídeo'}
              </button>
              <button
                className="btn"
                onClick={() =>
                  void deviceStorage
                    .saveVideo(file, file.name)
                    .then((where) => notify(`Salvo em ${where}`))
                    .catch((e: Error) => notify(e.message, 'error'))
                }
              >
                Salvar no aparelho
              </button>
            </div>
          </div>
        )}

        <div className="row-gap wrap">
          <button className="btn ghost" onClick={() => input.current?.click()} disabled={!!busy} data-testid="dl-import">
            Importar arquivo do aparelho
          </button>
        </div>
        <input
          ref={input}
          type="file"
          accept="video/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) {
              setError(null);
              take(f, 'arquivo');
            }
          }}
        />
      </div>
    </div>
  );
}
