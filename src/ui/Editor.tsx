import { useEffect, useRef, useState } from 'react';
import { projects } from '../platform/api';
import { getEditor, useEditor, type Panel } from '../state/store';
import { preview } from '../engine/preview';
import { ensureFonts } from '../render/fonts';
import { FORMATS } from '../core/model';
import { projectDuration } from '../core/timeline';
import { Stage, captureThumb } from './stage/Stage';
import { Timeline } from './timeline/Timeline';
import { Inspector } from './inspector/Inspector';
import { SidePanel } from './panels/SidePanel';
import { ExportDialog } from './ExportDialog';
import { PostDialog } from './PostDialog';
import { Transport } from './Transport';
import {
  copySelection,
  deleteSelection,
  duplicateSelection,
  nudge,
  paste,
  seek,
  splitAtPlayhead,
  stepFrames,
  stopPlayback,
  togglePlay,
} from './commands';
import { importFiles, loadAllMedia } from './importer';
import { useBackHandler } from '../platform/backButton';
import { applyFrameLogos } from './frameLogos';
import { clearBackup, readBackup, writeBackup } from './projectBackup';
import {
  IconAudio,
  IconBack,
  IconBlur,
  IconBrand,
  IconExport,
  IconMedia,
  IconMic,
  IconRedo,
  IconText,
  IconUndo,
} from './icons';

const RAIL: { id: Panel; label: string; tip: string; icon: typeof IconMedia }[] = [
  { id: 'ia', label: 'IA', tip: 'Editar com IA: comando de voz ou texto', icon: IconMic },
  { id: 'media', label: 'Mídia', tip: 'Mídia: importar vídeos e imagens', icon: IconMedia },
  { id: 'brand', label: 'Marca', tip: 'Marca: logos para cobrir marcas d’água', icon: IconBrand },
  { id: 'text', label: 'Manchetes', tip: 'Manchetes e molduras da Primeiras Notícias', icon: IconText },
  { id: 'blur', label: 'Desfoque', tip: 'Desfoque: borrar ou pixelizar uma região', icon: IconBlur },
  { id: 'audio', label: 'Áudio', tip: 'Áudio: músicas e trilhas', icon: IconAudio },
];

function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

export function Editor({ projectId }: { projectId: string }) {
  const project = useEditor((s) => s.project);
  const saveState = useEditor((s) => s.saveState);
  const panel = useEditor((s) => s.panel);
  const canUndo = useEditor((s) => s.past.length > 0);
  const canRedo = useEditor((s) => s.future.length > 0);
  const selectionCount = useEditor((s) => s.selection.length);
  const [error, setError] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [post, setPost] = useState<{ videoFile?: string; video?: Blob } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const saveTimer = useRef<number | null>(null);
  const previewFull = useEditor((s) => s.previewFull);
  const stageAreaRef = useRef<HTMLElement>(null);

  // botão voltar do celular: fecha o que estiver aberto, um passo por vez;
  // sem nada aberto, o App volta para a lista de projetos
  useBackHandler(true, () => {
    const s = getEditor();
    if (s.previewFull) return void s.set('previewFull', false), true;
    if (s.editingTextId) return void s.set('editingTextId', null), true;
    if (inspectorOpen) return void setInspectorOpen(false), true;
    if (s.panel && window.matchMedia('(max-width: 899px)').matches) return void s.set('panel', null), true;
    if (s.tool !== 'select') return void s.set('tool', 'select'), true;
    if (s.selection.length) return void s.select([]), true;
    return false;
  });

  // prévia em tela cheia: usa a API de tela cheia quando existe (e cobre a janela como reserva)
  useEffect(() => {
    if (previewFull) {
      getEditor().select([]);
      getEditor().set('editingTextId', null);
      stageAreaRef.current?.requestFullscreen?.().catch(() => undefined);
    } else if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    }
  }, [previewFull]);
  useEffect(() => {
    const on = () => {
      if (!document.fullscreenElement && getEditor().previewFull) getEditor().set('previewFull', false);
    };
    document.addEventListener('fullscreenchange', on);
    return () => {
      document.removeEventListener('fullscreenchange', on);
      getEditor().set('previewFull', false);
    };
  }, []);

  // carregamento
  useEffect(() => {
    let alive = true;
    const s = getEditor();
    s.close();
    if (window.matchMedia('(max-width: 899px)').matches) s.set('panel', null);
    Promise.all([projects.get(projectId), loadAllMedia(), ensureFonts()])
      .then(([p]) => {
        if (!alive) return;
        // havia uma cópia de segurança (app fechado antes de terminar de salvar): usa ela
        const backup = readBackup(p.id);
        getEditor().load(backup ?? p);
        if (backup) getEditor().set('saveState', 'dirty');
        // logos padrão das molduras escolhidas pelo usuário
        applyFrameLogos(getEditor().media);
      })
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
      stopPlayback();
    };
  }, [projectId]);

  // mídia → motor do preview
  useEffect(() => useEditor.subscribe((s) => preview.setMedia(s.media)), []);
  // a lista de logos pode chegar depois do projeto: reaplica as escolhidas
  // (moldura e encerramento) sempre que a mídia muda
  useEffect(
    () =>
      useEditor.subscribe((s, prev) => {
        if (s.media !== prev.media) applyFrameLogos(s.media);
      }),
    [],
  );
  useEffect(() => preview.setMedia(getEditor().media), []);

  // sincronização do preview com tempo/projeto
  useEffect(
    () =>
      useEditor.subscribe((s, prev) => {
        if (!s.project) return;
        if (s.time !== prev.time || s.project !== prev.project || s.playing !== prev.playing || s.media !== prev.media) {
          preview.sync(s.project, s.time, s.playing);
        }
      }),
    [],
  );

  // salvamento automático (não salva no meio de um gesto)
  useEffect(() => {
    const save = () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
      const cur = getEditor();
      if (!cur.project || (cur.saveState !== 'dirty' && cur.saveState !== 'error')) return;
      const snapshot = cur.project;
      cur.set('saveState', 'saving');
      projects
        .save(snapshot, captureThumb())
        .then(() => {
          if (getEditor().project === snapshot) {
            getEditor().set('saveState', 'saved');
            clearBackup(snapshot.id);
          } else getEditor().set('saveState', 'dirty');
        })
        .catch((e: Error) => {
          getEditor().set('saveState', 'error');
          getEditor().set('saveError', e.message);
          // tenta de novo sozinho (ex.: servidor reiniciando, armazenamento ocupado)
          saveTimer.current = window.setTimeout(save, 3000);
        });
    };
    const unsub = useEditor.subscribe((s) => {
      if (s.saveState !== 'dirty' || s.gestureBase || !s.project) return;
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(save, 700);
    });
    // app indo para segundo plano / fechando: salva NA HORA (no celular o
    // aplicativo pode ser encerrado antes do tempo do salvamento automático)
    const now = () => {
      const s = getEditor();
      if (!s.project || s.saveState === 'saved') return;
      // cópia instantânea primeiro (o salvamento normal pode ser cortado ao fechar)
      writeBackup(s.gestureBase ?? s.project);
      if (!s.gestureBase && (s.saveState === 'dirty' || s.saveState === 'error')) save();
    };
    const onVis = () => document.visibilityState === 'hidden' && now();
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pagehide', now);
    return () => {
      unsub();
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pagehide', now);
      // saindo do editor (voltar para a lista): não perde a última alteração
      now();
    };
  }, []);

  // aviso ao fechar com alterações pendentes
  useEffect(() => {
    const on = (e: BeforeUnloadEvent) => {
      if (getEditor().saveState !== 'saved') e.preventDefault();
    };
    window.addEventListener('beforeunload', on);
    return () => window.removeEventListener('beforeunload', on);
  }, []);

  // atalhos de teclado
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (isTyping(e)) return;
      const s = getEditor();
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (mod && k === 'z' && !e.shiftKey) {
        e.preventDefault();
        s.undo();
      } else if ((mod && k === 'z' && e.shiftKey) || (mod && k === 'y')) {
        e.preventDefault();
        s.redo();
      } else if (mod && k === 'd') {
        e.preventDefault();
        duplicateSelection();
      } else if (mod && k === 'c') {
        copySelection();
      } else if (mod && k === 'v') {
        paste();
      } else if (mod && k === 'a') {
        e.preventDefault();
        s.select(s.project?.clips.map((c) => c.id) ?? []);
      } else if (k === ' ') {
        e.preventDefault();
        togglePlay();
      } else if (k === 'delete' || k === 'backspace') {
        e.preventDefault();
        deleteSelection(e.shiftKey);
      } else if (k === 'f' && !mod) {
        s.set('previewFull', !s.previewFull);
      } else if (k === 's' && !mod) {
        splitAtPlayhead();
      } else if (k === 'escape') {
        if (s.previewFull) s.set('previewFull', false);
        else if (s.tool !== 'select') s.set('tool', 'select');
        else s.select([]);
      } else if (k === 'home') {
        seek(0);
      } else if (k === 'end') {
        if (s.project) seek(projectDuration(s.project));
      } else if (k === ',' || k === 'j') {
        stepFrames(e.shiftKey ? -10 : -1);
      } else if (k === '.' || k === 'l') {
        stepFrames(e.shiftKey ? 10 : 1);
      } else if (k.startsWith('arrow')) {
        e.preventDefault();
        const d = e.shiftKey ? 10 : 1;
        if (s.selection.length && s.project?.clips.some((c) => s.selection.includes(c.id) && c.type !== 'audio')) {
          nudge(k === 'arrowleft' ? -d : k === 'arrowright' ? d : 0, k === 'arrowup' ? -d : k === 'arrowdown' ? d : 0);
        } else if (k === 'arrowleft' || k === 'arrowright') {
          stepFrames((k === 'arrowleft' ? -1 : 1) * (e.shiftKey ? 10 : 1));
        }
      } else if (k === '+' || k === '=') {
        s.setZoom(s.zoom * 1.25);
      } else if (k === '-') {
        s.setZoom(s.zoom / 1.25);
      }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);

  // abre o inspector automaticamente no celular ao selecionar
  useEffect(() => {
    if (selectionCount === 0) setInspectorOpen(false);
  }, [selectionCount]);

  if (error) {
    return (
      <div className="center-msg">
        <p>{error}</p>
        <a href="#/" className="btn">
          Voltar aos projetos
        </a>
      </div>
    );
  }
  if (!project) return <div className="center-msg muted">Abrindo projeto…</div>;

  const togglePanel = (id: Panel) => getEditor().set('panel', panel === id ? null : id);

  return (
    <div
      className={`editor ${panel ? 'has-panel' : ''}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files') && !e.dataTransfer.types.includes('application/x-pn-media')) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragOver(false);
      }}
      onDrop={(e) => {
        // arrastar da biblioteca não é importar arquivo novo
        if (!e.dataTransfer.files.length || e.dataTransfer.types.includes('application/x-pn-media')) return;
        e.preventDefault();
        setDragOver(false);
        void importFiles(e.dataTransfer.files, true);
      }}
    >
      <header className="topbar">
        <a href="#/" className="icon-btn" aria-label="Projetos" title="Projetos">
          <IconBack />
        </a>
        <ProjectName />
        <span className="chip-format">{FORMATS[project.format].short}</span>
        <span className={`save-state ${saveState}`} title={useEditor.getState().saveError ?? ''}>
          {saveState === 'saved' ? 'Salvo' : saveState === 'saving' ? 'Salvando…' : saveState === 'error' ? 'Erro ao salvar' : 'Alterado'}
        </span>
        <div className="topbar-spacer" />
        <button className="icon-btn" disabled={!canUndo} onClick={() => getEditor().undo()} title="Desfazer (Ctrl+Z)" aria-label="Desfazer">
          <IconUndo />
        </button>
        <button className="icon-btn" disabled={!canRedo} onClick={() => getEditor().redo()} title="Refazer (Ctrl+Shift+Z)" aria-label="Refazer">
          <IconRedo />
        </button>
        <button className="btn primary" onClick={() => setExportOpen(true)} data-testid="open-export" data-tip="Exportar o vídeo final em MP4 para o aparelho">
          <IconExport /> <span className="hide-sm">Exportar</span>
        </button>
      </header>

      <nav className="rail" aria-label="Ferramentas">
        {RAIL.map(({ id, label, tip, icon: Icon }) => (
          <button key={id} className={`rail-btn ${panel === id ? 'active' : ''}`} onClick={() => togglePanel(id)} data-testid={`rail-${id}`} data-tip={tip}>
            <Icon />
            <span>{label}</span>
          </button>
        ))}
      </nav>

      {panel && <SidePanel panel={panel} onClose={() => getEditor().set('panel', null)} />}

      <main className={`stage-area ${previewFull ? 'full' : ''}`} ref={stageAreaRef}>
        <Stage />
        <Transport onOpenInspector={() => setInspectorOpen(true)} />
      </main>

      <aside className={`inspector ${inspectorOpen ? 'open' : ''}`}>
        <Inspector onClose={() => setInspectorOpen(false)} />
      </aside>

      <section className="timeline-area">
        <Timeline />
      </section>

      {dragOver && <div className="drop-overlay">Solte para importar e adicionar à timeline</div>}
      {exportOpen && (
        <ExportDialog
          onClose={() => setExportOpen(false)}
          onPost={(videoFile, video) => {
            setExportOpen(false);
            setPost({ videoFile, video });
          }}
        />
      )}
      {post && <PostDialog videoFile={post.videoFile} video={post.video} onClose={() => setPost(null)} />}
    </div>
  );
}

function ProjectName() {
  const name = useEditor((s) => s.project?.name ?? '');
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      className="project-title"
      value={draft ?? name}
      aria-label="Nome do projeto"
      onFocus={() => setDraft(name)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        const n = draft?.trim();
        if (n && n !== name) getEditor().apply((p) => ({ ...p, name: n }));
        setDraft(null);
      }}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      maxLength={120}
    />
  );
}
