import { useEffect, useRef, useState } from 'react';
import { FORMATS, type FormatId } from '../core/model';
import { createProject } from '../core/factory';
import { uid } from '../core/id';
import { projects, type ProjectSummary } from '../platform/api';
import { useEditor } from '../state/store';
import { IconDots, IconDownload, IconMedia, IconNews, IconPlus, IconSend, IconSettings, IconTrend } from './icons';
import { SettingsDialog } from './SettingsDialog';
import { DownloadDialog } from './DownloadDialog';
import { PostDialog } from './PostDialog';
import { PostadorDialog } from './PostadorDialog';
import { TrendsDialog } from './TrendsDialog';
import { confirmDialog, promptDialog } from './dialogs';
import { useBackHandler } from '../platform/backButton';

const FORMAT_ORDER: FormatId[] = ['reel', 'feed45', 'feed11', 'wide'];

function timeAgo(iso: string) {
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return 'agora';
  if (d < 3600) return `há ${Math.floor(d / 60)} min`;
  if (d < 86400) return `há ${Math.floor(d / 3600)} h`;
  return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
}

export function ProjectsScreen() {
  const [list, setList] = useState<ProjectSummary[] | null>(null);
  const [name, setName] = useState('');
  const [menu, setMenu] = useState<string | null>(null);
  // botão voltar fecha o menu de opções aberto
  useBackHandler(menu !== null, () => setMenu(null));
  const notify = useEditor((s) => s.notify);
  const [post, setPost] = useState<{ query?: string } | null>(null);
  const [trends, setTrends] = useState(false);
  const [dl, setDl] = useState(false);
  const [postador, setPostador] = useState(false);
  const [cfg, setCfg] = useState(false);
  const newRef = useRef<HTMLElement>(null);

  const refresh = () =>
    projects
      .list()
      .then(setList)
      .catch((e: Error) => {
        setList([]);
        notify(e.message, 'error');
      });

  useEffect(() => {
    void refresh();
  }, []);

  const create = async (format: FormatId) => {
    const n = name.trim() || `Matéria ${new Date().toLocaleDateString('pt-BR')} ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
    const p = createProject(n, format);
    try {
      await projects.create(p);
      location.hash = `#/p/${p.id}`;
    } catch (e) {
      notify((e as Error).message, 'error');
    }
  };

  const duplicate = async (id: string) => {
    const p = await projects.get(id);
    const copy = { ...p, id: uid(), name: `${p.name} (cópia)` };
    await projects.create(copy);
    setMenu(null);
    void refresh();
  };

  const rename = async (s: ProjectSummary) => {
    const p = await projects.get(s.id);
    const n = await promptDialog({ title: 'Renomear projeto', label: 'Nome da matéria', value: p.name, confirmLabel: 'Salvar' });
    setMenu(null);
    if (!n?.trim()) return;
    await projects.save({ ...p, name: n.trim() });
    void refresh();
  };

  const remove = async (id: string) => {
    setMenu(null);
    const ok = await confirmDialog({
      title: 'Excluir projeto?',
      message: 'O projeto será apagado. Os arquivos de mídia continuam na biblioteca.',
      confirmLabel: 'Excluir',
      danger: true,
    });
    if (!ok) return;
    await projects.remove(id);
    void refresh();
  };

  return (
    <div className="home" onClick={() => setMenu(null)}>
      <header className="home-top">
        <div className="wordmark">
          <span className="wm-a">Primeiras Notícias</span>
          <span className="wm-b">Studio</span>
        </div>
        <span className="row-gap">
          <span className="home-local">Local · seus arquivos não saem deste aparelho</span>
          <button className="icon-btn" onClick={() => setCfg(true)} aria-label="Configurações" title="Configurações (chaves e senhas)" data-testid="open-settings">
            <IconSettings />
          </button>
        </span>
      </header>

      <section className="home-hub" aria-label="O que você quer fazer?">
        <button className="hub-card" onClick={() => setDl(true)} data-testid="hub-download">
          <IconDownload />
          <strong>Baixar vídeo</strong>
          <span>Cole o link do Reels e já edite</span>
        </button>
        <button className="hub-card" onClick={() => newRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })} data-testid="hub-edit">
          <IconMedia />
          <strong>Editar vídeo</strong>
          <span>Novo projeto ou continue um recente</span>
        </button>
        <button className="hub-card" onClick={() => setPostador(true)} data-testid="hub-postador">
          <IconSend />
          <strong>Postador de notícias</strong>
          <span>Capture as notícias e poste no site; o Instagram sai sozinho</span>
        </button>
        <button className="hub-card" onClick={() => setTrends(true)} data-testid="hub-trends">
          <IconTrend />
          <strong>Trends do momento</strong>
          <span>Em alta, Reels virais e hashtags</span>
        </button>
        <button className="hub-card" onClick={() => setPost({})} data-testid="hub-news">
          <IconNews />
          <strong>Buscar e criar matéria</strong>
          <span>Pesquise a notícia e gere a legenda do Reels</span>
        </button>
      </section>
      {dl && <DownloadDialog onClose={() => setDl(false)} />}
      {postador && <PostadorDialog onClose={() => setPostador(false)} />}
      {cfg && <SettingsDialog onClose={() => setCfg(false)} />}
      {post && <PostDialog initialQuery={post.query} onClose={() => setPost(null)} />}
      {trends && (
        <TrendsDialog
          onClose={() => setTrends(false)}
          onCreateStory={(q) => {
            setTrends(false);
            setPost({ query: q });
          }}
        />
      )}

      <section className="home-new" ref={newRef}>
        <div className="home-new-head">
          <h2>Novo projeto</h2>
          <input
            className="input"
            placeholder="Nome da matéria (opcional)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
          />
        </div>
        <div className="format-row">
          {FORMAT_ORDER.map((f) => {
            const fm = FORMATS[f];
            const ratio = fm.width / fm.height;
            return (
              <button key={f} className="format-card" onClick={() => void create(f)} data-testid={`new-${f}`}>
                <span className="format-box">
                  <span className="format-shape" style={{ width: Math.round(ratio < 1 ? 60 * ratio : 60), height: Math.round(ratio < 1 ? 60 : 60 / ratio) }}>
                    <IconPlus />
                  </span>
                </span>
                <span className="format-label">{fm.label}</span>
                <span className="format-res">
                  {fm.width}×{fm.height}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="home-list">
        <h2>Recentes</h2>
        {list === null ? (
          <p className="muted">Carregando…</p>
        ) : list.length === 0 ? (
          <p className="muted">Nenhum projeto ainda. Escolha um formato acima para começar.</p>
        ) : (
          <div className="project-grid">
            {list.map((p) => (
              <div key={p.id} className="project-card">
                <a href={`#/p/${p.id}`} className="project-thumb" data-format={p.format}>
                  {p.thumb ? <img src={p.thumb} alt="" /> : <span className="muted">sem prévia</span>}
                </a>
                <div className="project-meta">
                  <a href={`#/p/${p.id}`} className="project-name" title={p.name}>
                    {p.name}
                  </a>
                  <span className="muted small">
                    {FORMATS[p.format]?.short ?? p.format} · {timeAgo(p.updatedAt)}
                  </span>
                </div>
                <button
                  className="icon-btn project-menu-btn"
                  aria-label="Opções"
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenu(menu === p.id ? null : p.id);
                  }}
                >
                  <IconDots />
                </button>
                {menu === p.id && (
                  <div className="menu" onClick={(e) => e.stopPropagation()}>
                    <button onClick={() => void rename(p)}>Renomear</button>
                    <button onClick={() => void duplicate(p.id)}>Duplicar</button>
                    <button className="danger" onClick={() => void remove(p.id)}>
                      Excluir
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
