import { useEditor, getEditor, setAutoKey } from '../state/store';
import { projectDuration } from '../core/timeline';
import { seek, splitAtPlayhead, togglePlay } from './commands';
import { IconEnd, IconExitFullscreen, IconFullscreen, IconKeyframe, IconPause, IconPlay, IconSafe, IconSettings, IconSplit, IconStart } from './icons';

export function formatTime(t: number, fps = 30) {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const f = Math.floor((t - Math.floor(t)) * fps + 1e-6);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(f).padStart(2, '0')}`;
}

export function Transport({ onOpenInspector }: { onOpenInspector: () => void }) {
  const time = useEditor((s) => s.time);
  const playing = useEditor((s) => s.playing);
  const fps = useEditor((s) => s.project?.fps ?? 30);
  const duration = useEditor((s) => (s.project ? projectDuration(s.project) : 0));
  const safeZones = useEditor((s) => s.safeZones);
  const autoKey = useEditor((s) => s.autoKey);
  const hasSelection = useEditor((s) => s.selection.length > 0);
  const full = useEditor((s) => s.previewFull);

  return (
    <div className="transport">
      <div className="tc">
        <span className="tc-now" data-testid="timecode">
          {formatTime(time, fps)}
        </span>
        <span className="tc-sep">/</span>
        <span className="tc-dur">{formatTime(duration, fps)}</span>
      </div>
      <div className="transport-center">
        <button className="icon-btn" onClick={() => seek(0)} aria-label="Início" title="Início (Home)">
          <IconStart />
        </button>
        <button className="play-btn" onClick={togglePlay} aria-label={playing ? 'Pausar' : 'Reproduzir'} title="Reproduzir/pausar (Espaço)" data-testid="play">
          {playing ? <IconPause /> : <IconPlay />}
        </button>
        <button className="icon-btn" onClick={() => seek(duration)} aria-label="Fim" title="Fim (End)">
          <IconEnd />
        </button>
      </div>
      <div className="transport-right">
        {!full && (
          <>
            <button className="icon-btn transport-split" onClick={splitAtPlayhead} title="Dividir na agulha (S)" aria-label="Dividir">
              <IconSplit />
            </button>
            <button
              className={`icon-btn autokey-btn ${autoKey ? 'on' : ''}`}
              onClick={() => {
                setAutoKey(!autoKey);
                getEditor().notify(
                  autoKey ? 'Movimento desligado: mexer no item muda ele no clipe todo.' : 'Movimento ligado: ponha a agulha num ponto e mexa no item — ele se move até ali (nós ◆ na timeline).',
                );
              }}
              title="Movimento (como o Pan/Crop do Vegas): mexer no item grava um nó na agulha"
              aria-label="Movimento"
              aria-pressed={autoKey}
              data-testid="autokey"
            >
              <IconKeyframe />
            </button>
            <button
              className={`icon-btn ${safeZones ? 'on' : ''}`}
              onClick={() => getEditor().set('safeZones', !safeZones)}
              title="Mostrar área segura do Instagram"
              aria-label="Área segura"
            >
              <IconSafe />
            </button>
            <button className="icon-btn show-sm" disabled={!hasSelection} onClick={onOpenInspector} aria-label="Ajustes do item" title="Ajustes do item selecionado">
              <IconSettings />
            </button>
          </>
        )}
        <button
          className="icon-btn"
          onClick={() => getEditor().set('previewFull', !full)}
          title={full ? 'Sair da tela cheia (Esc)' : 'Assistir em tela cheia'}
          aria-label={full ? 'Sair da tela cheia' : 'Tela cheia'}
          data-testid="fullscreen"
        >
          {full ? <IconExitFullscreen /> : <IconFullscreen />}
        </button>
      </div>
    </div>
  );
}
