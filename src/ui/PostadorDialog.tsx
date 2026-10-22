/**
 * Postador de notícias (igual no app e no PC):
 * - PAUTAS: captura João Pessoa, Bayeux, Campina Grande (nunca Cabedelo e Santa Rita) e as
 *   nacionais em alta (ou uma busca livre), ranqueia até 20 com trends,
 *   fotos que dá para baixar e conteúdo; a IA escreve a matéria do site com
 *   as imagens nos lugares, o trecho do título a destacar e o tom/áudio;
 *   daí: post em vídeo (abre no editor) e/ou envio ao site.
 * - SITE: acesso ao painel (WEBSG), buscar e apagar matérias.
 * - TONS: emblemas (Policial, Economia...) com áudios nomeados; a IA escolhe.
 * - AUTOMAÇÃO: horários de disparo e o que o aprendizado já descobriu.
 */
import { useEffect, useRef, useState } from 'react';
import { useEditor } from '../state/store';
import { useBackHandler } from '../platform/backButton';
import { media as mediaApi } from '../platform/api';
import { CITIES, type Pauta } from '../news/pautas';
import type { SiteStory } from '../news/siteWriter';
import type { SiteNews } from '../news/websg';
import { fetchPhoto, findPautas, siteDelete, siteList, siteTest, writeSite } from '../news/postadorClient';
import { autopostReport, getAutoConfig, setAutoConfig, startAutopostClock, tick } from '../news/autopostApp';
import { postadorNative } from '../platform/postadorNative';
import { aiReady, getFx } from '../news/client';
import { addSpend, brl, type Fx } from '../news/cost';
import { loadTones, noteTrackUse, resolveTone, saveTones, tonesForAi, TRECHO_S, type Tone } from '../news/tones';
import { createStoryVideo } from './storyVideo';
import { waitReady } from './importer';
import { confirmDialog } from './dialogs';
import { IconClose, IconSettings, IconTrash, IconUpload } from './icons';
import { SettingsDialog } from './SettingsDialog';
import { MusicTrim } from './MusicTrim';
import { postToBlog } from '../news/blogPost';
import { ensureDefaultTones } from '../news/defaultTones';

type Tab = 'pautas' | 'site' | 'tons' | 'auto';
const TABS: { id: Tab; label: string }[] = [
  { id: 'pautas', label: 'Pautas' },
  { id: 'site', label: 'Site' },
  { id: 'tons', label: 'Tons' },
  { id: 'auto', label: 'Automação' },
];

/** relatório que o cron publica a cada rodada (branch autopost-dados do repositório) */

function ago(iso: string | null): string {
  if (!iso) return 'sem data';
  const m = (Date.now() - new Date(iso).getTime()) / 60000;
  if (m < 60) return `há ${Math.max(1, Math.round(m))} min`;
  if (m < 1440) return `há ${Math.round(m / 60)} h`;
  return `há ${Math.round(m / 1440)} dia(s)`;
}

export function PostadorDialog({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('pautas');
  const [busy, setBusy] = useState<string | null>(null);
  const [cfgOpen, setCfgOpen] = useState(false);
  useBackHandler(!cfgOpen, () => !busy && onClose());
  return (
    <div className="modal-back" onPointerDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal post-modal postador" role="dialog" aria-label="Postador de notícias" data-testid="postador-dialog">
        <div className="modal-head">
          <h3>Postador de notícias</h3>
          <span className="row-gap">
            <button className="icon-btn" onClick={() => setCfgOpen(true)} aria-label="Configurações" title="Configurações (chaves e senhas)" data-testid="postador-settings">
              <IconSettings />
            </button>
            <button className="icon-btn" onClick={onClose} disabled={!!busy} aria-label="Fechar">
              <IconClose />
            </button>
          </span>
        </div>
        <div className="seg postador-tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)} disabled={!!busy} data-testid={`postador-tab-${t.id}`}>
              {t.label}
            </button>
          ))}
        </div>
        {tab === 'pautas' && <PautasTab busy={busy} setBusy={setBusy} openSettings={() => setCfgOpen(true)} />}
        {tab === 'site' && <SiteTab busy={busy} setBusy={setBusy} />}
        {tab === 'tons' && <TonesTab />}
        {tab === 'auto' && <AutoTab openSettings={() => setCfgOpen(true)} />}
      </div>
      {cfgOpen && <SettingsDialog onClose={() => setCfgOpen(false)} />}
    </div>
  );
}

// ------------------------------------------------------------------ pautas

function PautasTab({ busy, setBusy, openSettings }: { busy: string | null; setBusy: (b: string | null) => void; openSettings: () => void }) {
  const notify = useEditor((s) => s.notify);
  const [q, setQ] = useState('');
  const [cities, setCities] = useState<string[]>([...CITIES]);
  const [pautas, setPautas] = useState<Pauta[] | null>(null);
  const [open, setOpen] = useState<Pauta | null>(null);
  const [prompt, setPrompt] = useState('');
  const [story, setStory] = useState<SiteStory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fx, setFx] = useState<Fx | null>(null);
  const [ai, setAi] = useState<boolean | null>(null);
  /** andamento/resultado do "Postar no site" de cada notícia */
  const [post, setPost] = useState<Record<string, { msg: string; ok?: boolean }>>({});
  useEffect(() => {
    void getFx().then(setFx);
    void aiReady().then(setAi);
  }, []);

  const capture = async () => {
    setBusy('capture');
    setError(null);
    setOpen(null);
    setStory(null);
    try {
      const r = await findPautas(q, cities);
      setPautas(r.pautas);
      if (!r.pautas.length) setError('Nenhuma pauta encontrada agora. Tente outra busca ou mais cidades.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const write = async (p: Pauta) => {
    setBusy('write');
    setError(null);
    try {
      const s = await writeSite(p, prompt, tonesForAi(loadTones()));
      setStory(s);
      if (s.costUsd) addSpend(s.costUsd);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  /** primeira foto da matéria que realmente baixar */
  const photo = async (s: SiteStory, p: Pauta): Promise<File | null> => {
    for (const im of s.imagens) {
      try {
        return await fetchPhoto(im.src, p.url);
      } catch {
        /* tenta a próxima */
      }
    }
    return null;
  };

  const video = async () => {
    if (!story || !open) return;
    setBusy('video');
    setError(null);
    try {
      const tones = loadTones();
      const tone = resolveTone(tones, story.tom, story.audio, `${story.titulo} ${story.paragrafos.join(' ')}`, story.categoria);
      const id = await createStoryVideo({
        kicker: story.categoria || story.minititulo || 'Notícia',
        title: story.titulo,
        subtitle: story.subtitulo,
        keywords: [story.destaque ?? '', ...story.palavrasChave].filter(Boolean),
        photo: await photo(story, open),
        audioId: tone?.track.mediaId ?? null,
        audioStart: tone?.track.inicio,
        audioDur: tone?.track.dur ?? TRECHO_S,
      });
      if (tone) noteTrackUse(tone.track.name);
      notify(tone ? `Post em vídeo criado com a trilha "${tone.track.name}" (${tone.tone.name}).` : 'Post em vídeo criado.');
      location.hash = `#/p/${id}`;
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  };

  /** escreve (se precisar), publica no site e põe na fila do Instagram */
  const postSite = async (p: Pauta, s?: SiteStory) => {
    setBusy(`post:${p.id}`);
    setError(null);
    const set = (msg: string, ok?: boolean) => setPost((m) => ({ ...m, [p.id]: { msg, ok } }));
    try {
      const r = await postToBlog(p, { prompt, story: s, onStep: (m) => set(m) });
      if (r.story.costUsd) addSpend(r.story.costUsd);
      set(`✓ No site${r.siteId ? ` (nº ${r.siteId})` : ''}, publicada`, true);
      notify(r.siteId ? `Postada no site: notícia nº ${r.siteId}.` : 'Postada no site.');
    } catch (e) {
      set(`✗ ${(e as Error).message}`, false);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <label className="field">
        <span>Busca livre (opcional) — vazio: as notícias do dia das cidades + nacionais em alta</span>
        <div className="post-search">
          <input className="input" value={q} placeholder="ex.: operação polícia Bayeux hoje" onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void capture()} data-testid="postador-q" />
          <button className="btn primary" onClick={() => void capture()} disabled={!!busy} data-testid="postador-capture">
            {busy === 'capture' ? 'Capturando…' : 'Capturar pautas'}
          </button>
        </div>
      </label>
      <div className="chip-row">
        {CITIES.map((c) => (
          <button key={c} className={`chip ${cities.includes(c) ? 'on' : ''}`} onClick={() => setCities((s) => (s.includes(c) ? s.filter((x) => x !== c) : [...s, c]))}>
            {c}
          </button>
        ))}
      </div>
      {busy === 'capture' && <p className="small muted">Lendo as matérias, conferindo se as fotos baixam e ranqueando… (leva uns 20 s)</p>}
      <p className="small muted">Regra: só entram notícias de até 12 h e com pelo menos uma foto que dá para baixar (vira a capa do post).</p>
      {error && <p className="error-text">{error}</p>}

      {pautas && !open && (
        <div className="post-cards" data-testid="postador-list">
          {pautas.map((p, i) => (
            <div key={p.id} className="post-card pauta-card" data-testid="postador-pauta">
              <span className="pauta-rank">{i + 1}</span>
              <span className="post-card-body" role="button" tabIndex={0} onClick={() => { setOpen(p); setStory(null); }}>
                <strong>{p.title}</strong>
                <span className="muted small">
                  {p.source} · {ago(p.date)}
                  {p.city ? ` · ${p.city}` : ' · nacional'}
                  {p.coverage > 1 ? ` · ${p.coverage} veículos` : ''}
                </span>
                <span className="small">
                  <b>{p.score} pts</b> · {p.paragraphs} parágrafos · fotos {p.imagesOk}✓{p.images - p.imagesOk > 0 ? ` ${p.images - p.imagesOk}✗` : ''}
                  {p.videos ? ` · ${p.videos} vídeo(s)` : ''}
                  {p.trendHits ? ' · em alta' : ''}
                </span>
                {post[p.id] && <span className={`small ${post[p.id]!.ok === false ? 'error-text' : ''}`} data-testid="postador-post-status">{post[p.id]!.msg}</span>}
              </span>
              <button className="btn sm primary pauta-post" disabled={!!busy || post[p.id]?.ok === true} onClick={() => void postSite(p)} data-testid="postador-post">
                {busy === `post:${p.id}` ? 'Postando…' : post[p.id]?.ok ? 'Postada ✓' : 'Postar no site'}
              </button>
            </div>
          ))}
        </div>
      )}

      {open && (
        <div className="pauta-open" data-testid="postador-open">
          <button className="btn sm ghost" onClick={() => { setOpen(null); setStory(null); }} disabled={!!busy}>
            ← Voltar ao ranking
          </button>
          <h4>{open.title}</h4>
          <p className="small muted">
            {open.source} · {ago(open.date)} · <a href={open.url} target="_blank" rel="noreferrer">abrir a matéria</a>
          </p>
          <p className="small">Por que está aqui: {open.reasons.join(' · ')}</p>
          {!story && (
            <details className="pauta-blocks" open>
              <summary className="small muted">Conteúdo capturado (na ordem da matéria)</summary>
              {open.blocks.slice(0, 40).map((b, i) =>
                b.type === 'p' ? (
                  <p key={i} className="small">{b.text}</p>
                ) : b.type === 'img' ? (
                  <figure key={i} className={b.ok ? '' : 'img-bad'}>
                    <img src={b.src} alt={b.caption ?? ''} loading="lazy" referrerPolicy="no-referrer" />
                    <figcaption className="small muted">{b.ok ? '✓ dá para baixar' : '✗ não baixa (fica de fora)'}{b.caption ? ` · ${b.caption}` : ''}</figcaption>
                  </figure>
                ) : (
                  <p key={i} className="small">🎬 Vídeo ({b.kind}): {b.src}</p>
                ),
              )}
            </details>
          )}
          {!story && (
            <>
              <label className="field">
                <span>Pedido para a IA (opcional)</span>
                <input className="input" value={prompt} placeholder="ex.: destaque o que disse a polícia" onChange={(e) => setPrompt(e.target.value)} />
              </label>
              {ai === false && (
                <p className="post-warn small">
                  Sem a chave da IA. <button className="btn sm" onClick={openSettings}>Abrir Configurações</button>
                </p>
              )}
              <button className="btn primary wide" onClick={() => void write(open)} disabled={!!busy} data-testid="postador-write">
                {busy === 'write' ? 'Escrevendo, conferindo fatos e escolhendo o tom…' : 'Escrever matéria para o site'}
              </button>
            </>
          )}
          {story && (
            <div className="site-story" data-testid="postador-story">
              <div className="row-gap wrap small">
                <span className="chip on">{story.categoria}</span>
                {story.minititulo && <span className="chip">{story.minititulo}</span>}
                {story.destaque && <span className="chip" title="Trecho destacado no post em vídeo">destaque: “{story.destaque}”</span>}
                {story.tom && <span className="chip" title="Tom e trilha escolhidos pela IA">tom: {story.tom}{story.audio ? ` · ${story.audio}` : ''}</span>}
              </div>
              <h4>{story.titulo}</h4>
              {story.subtitulo && <p className="muted">{story.subtitulo}</p>}
              <div className="site-html" dangerouslySetInnerHTML={{ __html: story.html }} />
              {story.palavrasChave.length > 0 && <p className="small muted">Palavras-chave: {story.palavrasChave.join(', ')}</p>}
              {story.unverified.length > 0 && <p className="post-warn small">⚠ Confira na fonte antes de publicar: <strong>{story.unverified.join(', ')}</strong></p>}
              <details>
                <summary className="small muted">Como foi feito {story.model ? `· ${story.model}` : '· sem IA'}{fx && story.costUsd ? ` · custo ${brl(story.costUsd, fx.rate)}` : ''}</summary>
                <ul className="small muted">
                  {story.steps.map((s, i) => <li key={i}>{s}</li>)}
                </ul>
              </details>
              {post[open.id] && <p className={`small ${post[open.id]!.ok === false ? 'error-text' : ''}`}>{post[open.id]!.msg}</p>}
              <div className="row-gap wrap">
                <button className="btn" onClick={() => void video()} disabled={!!busy} data-testid="postador-video">
                  {busy === 'video' ? 'Montando o vídeo…' : 'Criar post em vídeo'}
                </button>
                <button className="btn primary" onClick={() => void postSite(open, story)} disabled={!!busy || post[open.id]?.ok === true} data-testid="postador-send">
                  {busy === `post:${open.id}` ? 'Postando…' : post[open.id]?.ok ? 'Postada ✓' : 'Postar no site'}
                </button>
                <button className="btn ghost" onClick={() => setStory(null)} disabled={!!busy}>
                  Escrever de novo
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------------ site

function SiteTab({ busy, setBusy }: { busy: string | null; setBusy: (b: string | null) => void }) {
  const notify = useEditor((s) => s.notify);
  const [q, setQ] = useState('');
  const [list, setList] = useState<SiteNews[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (what: string, fn: () => Promise<void>) => {
    setBusy(what);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <div className="row-gap wrap">
        <button className="btn sm" disabled={!!busy} onClick={() => void run('test', async () => { const r = await siteTest(); notify(`Acesso OK: ${r.total} matérias na 1ª página do painel.`); })} data-testid="site-test">
          {busy === 'test' ? 'Testando…' : 'Testar acesso ao painel'}
        </button>
        <span className="small muted">Usuário e senha ficam em ⚙ Configurações.</span>
      </div>
      <label className="field">
        <span>Matérias do site</span>
        <div className="post-search">
          <input className="input" value={q} placeholder="buscar pelo título ou número" onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void run('list', async () => setList(await siteList(q)))} />
          <button className="btn" disabled={!!busy} onClick={() => void run('list', async () => setList(await siteList(q)))} data-testid="site-search">
            {busy === 'list' ? 'Buscando…' : 'Buscar'}
          </button>
        </div>
      </label>
      {error && <p className="error-text">{error}</p>}
      {list && (
        <div className="post-cards">
          {list.length === 0 && <p className="small muted">Nada encontrado nas 3 primeiras páginas do painel.</p>}
          {list.map((n) => (
            <div key={n.id} className="post-card">
              <span className="post-card-body">
                <strong>
                  #{n.id} · {n.title}
                </strong>
                <span className="muted small">
                  {n.date ?? ''}
                  {n.status ? ` · ${n.status}` : ''}
                  {typeof n.views === 'number' ? ` · ${n.views.toLocaleString('pt-BR')} acessos` : ''}
                  {n.url && (
                    <>
                      {' · '}
                      <a href={n.url} target="_blank" rel="noreferrer">abrir</a>
                    </>
                  )}
                </span>
              </span>
              <button
                className="icon-btn"
                aria-label="Apagar do site"
                title="Apagar do site"
                disabled={!!busy}
                onClick={async () => {
                  const ok = await confirmDialog({ title: `Apagar a notícia nº ${n.id} do site?`, message: `"${n.title}" sai do site Primeiras Notícias. Não dá para desfazer pelo app.`, confirmLabel: 'Apagar do site', danger: true });
                  if (ok) void run('del', async () => { await siteDelete(n.id); setList((l) => (l ?? []).filter((x) => x.id !== n.id)); notify(`Notícia nº ${n.id} apagada do site.`); });
                }}
              >
                <IconTrash />
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------------ tons

const uid = () => Math.random().toString(36).slice(2, 10);

function TonesTab() {
  const notify = useEditor((s) => s.notify);
  const [tones, setTones] = useState<Tone[]>(loadTones);
  const [name, setName] = useState('');
  const [uploading, setUploading] = useState<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [trimming, setTrimming] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const update = (t: Tone[]) => {
    setTones(t);
    saveTones(t);
  };
  useEffect(() => () => audio.current?.pause(), []);
  const [seeding, setSeeding] = useState(false);
  useEffect(() => {
    setSeeding(true);
    void ensureDefaultTones()
      .then(() => setTones(loadTones()))
      .catch((e: Error) => notify(`Tons padrão: ${e.message}`, 'error'))
      .finally(() => setSeeding(false));
  }, []);

  const upload = async (toneId: string, files: File[]) => {
    setUploading(toneId);
    try {
      for (const f of files) {
        const up = await mediaApi.upload(f);
        const m = await waitReady(up.id);
        if (m.status !== 'ready') throw new Error(m.error ?? `Não foi possível ler ${f.name}`);
        setTrimming(`${toneId}:${m.id}`);
        setTones((cur) => {
          const next = cur.map((t) => (t.id === toneId ? { ...t, tracks: [...t.tracks, { mediaId: m.id, name: f.name.replace(/\.[^.]+$/, ''), inicio: 0, dur: TRECHO_S }] } : t));
          saveTones(next);
          return next;
        });
      }
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally {
      setUploading(null);
    }
  };

  const play = async (mediaId: string) => {
    audio.current?.pause();
    if (playing === mediaId) return setPlaying(null);
    try {
      const m = await mediaApi.get(mediaId);
      const a = new Audio(m.url);
      audio.current = a;
      a.onended = () => setPlaying(null);
      await a.play();
      setPlaying(mediaId);
    } catch {
      notify('Esse áudio não está mais na biblioteca.', 'error');
    }
  };

  return (
    <>
      <p className="small muted">
        Opcional. Crie um tom (ex.: Policial, Economia) e coloque áudios com nomes que digam o clima (ex.: "tensão grave", "suspense leve"). Ao escrever a matéria, a IA identifica o tom e escolhe o áudio que mais combina para o post em vídeo. Em "✂ Trecho", deslize na faixa para escolher os melhores 15 ou 20 segundos da música (o post tem esse tamanho).
      </p>
      <div className="post-search">
        <input className="input" value={name} placeholder="Nome do novo tom (ex.: Policial)" onChange={(e) => setName(e.target.value)} data-testid="tone-name" onKeyDown={(e) => {
          if (e.key === 'Enter' && name.trim()) {
            update([...tones, { id: uid(), name: name.trim(), hint: '', tracks: [] }]);
            setName('');
          }
        }} />
        <button className="btn primary" disabled={!name.trim()} onClick={() => { update([...tones, { id: uid(), name: name.trim(), hint: '', tracks: [] }]); setName(''); }} data-testid="tone-add">
          Criar tom
        </button>
      </div>
      {seeding && <p className="small muted">Carregando os tons que vêm no app (Urgente, Policial, Geral)…</p>}
      {tones.length === 0 && !seeding && <p className="small muted">Nenhum tom ainda: os posts saem sem trilha.</p>}
      {tones.map((t) => (
        <div key={t.id} className="tone-card" data-testid="tone-card">
          <div className="row-between">
            <input className="input tone-title" value={t.name} onChange={(e) => update(tones.map((x) => (x.id === t.id ? { ...x, name: e.target.value } : x)))} aria-label="Nome do tom" />
            <button className="icon-btn" aria-label="Excluir tom" title="Excluir o tom (os áudios continuam na biblioteca)" onClick={async () => {
              if (await confirmDialog({ title: `Excluir o tom "${t.name}"?`, message: 'Os arquivos de áudio continuam na biblioteca de mídia.', confirmLabel: 'Excluir tom', danger: true })) update(tones.filter((x) => x.id !== t.id));
            }}>
              <IconTrash />
            </button>
          </div>
          <input className="input small" value={t.hint} placeholder="Quando usar (opcional): ex.: crimes, prisões, operações" onChange={(e) => update(tones.map((x) => (x.id === t.id ? { ...x, hint: e.target.value } : x)))} />
          {t.tracks.map((k, i) => (
            <div key={k.mediaId + i} className="tone-track-wrap">
            <div className="tone-track">
              <button className="btn sm" onClick={() => void play(k.mediaId)}>{playing === k.mediaId ? '■' : '▶'}</button>
              <input className="input" value={k.name} aria-label="Nome do áudio" onChange={(e) => update(tones.map((x) => (x.id === t.id ? { ...x, tracks: x.tracks.map((y, j) => (j === i ? { ...y, name: e.target.value } : y)) } : x)))} />
              <button className="icon-btn sm" aria-label="Tirar áudio do tom" title="Tirar do tom (o arquivo continua na biblioteca)" onClick={() => update(tones.map((x) => (x.id === t.id ? { ...x, tracks: x.tracks.filter((_, j) => j !== i) } : x)))}>
                <IconTrash />
              </button>
            </div>
            <button className="btn sm tone-trim-btn" onClick={() => setTrimming(trimming === `${t.id}:${k.mediaId}:${i}` ? null : `${t.id}:${k.mediaId}:${i}`)} data-testid="tone-trim">
              ✂ Trecho {Math.floor((k.inicio ?? 0) / 60)}:{String(Math.floor((k.inicio ?? 0) % 60)).padStart(2, '0')} · {k.dur ?? TRECHO_S}s
            </button>
            {(trimming === `${t.id}:${k.mediaId}:${i}` || trimming === `${t.id}:${k.mediaId}`) && (
              <MusicTrim
                mediaId={k.mediaId}
                inicio={k.inicio ?? 0}
                dur={k.dur ?? TRECHO_S}
                onChange={(v) => update(tones.map((x) => (x.id === t.id ? { ...x, tracks: x.tracks.map((y, j) => (j === i ? { ...y, ...v } : y)) } : x)))}
              />
            )}
            </div>
          ))}
          <label className="btn sm tone-upload">
            <IconUpload /> {uploading === t.id ? 'Enviando…' : 'Adicionar áudios'}
            <input type="file" accept="audio/*" multiple hidden disabled={!!uploading} onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              e.target.value = '';
              if (files.length) void upload(t.id, files);
            }} />
          </label>
        </div>
      ))}
    </>
  );
}

// ------------------------------------------------------------------ automação

function AutoTab({ openSettings }: { openSettings: () => void }) {
  const notify = useEditor((s) => s.notify);
  const [on, setOn] = useState(getAutoConfig().ativo);
  const [rep, setRep] = useState(autopostReport);
  const [nat, setNat] = useState<{ ligado: boolean; semEconomiaBateria: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = () => {
    setRep(autopostReport());
    void postadorNative.status().then(setNat);
  };
  useEffect(() => {
    refresh();
    const id = window.setInterval(refresh, 5000);
    return () => window.clearInterval(id);
  }, []);
  const toggle = async () => {
    const next = !on;
    setOn(next);
    setAutoConfig({ ativo: next });
    if (next) {
      await postadorNative.start().catch((e: Error) => notify(e.message, 'error'));
      startAutopostClock();
      // celular: precisa rodar com a tela bloqueada
      const s = await postadorNative.status();
      if (postadorNative.disponivel && !s.semEconomiaBateria) await postadorNative.pedirBateria();
    } else await postadorNative.stop();
    refresh();
  };
  const run = async (what: 'blog' | 'instagram') => {
    setBusy(what);
    try {
      await tick(what);
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally {
      setBusy(null);
      refresh();
    }
  };
  return (
    <div className="auto-tab">
      <button className={`btn wide auto-switch ${on ? 'primary' : ''}`} onClick={() => void toggle()} data-testid="auto-switch">
        {on ? 'AUTOMÁTICO LIGADO ✓ (toque para desligar)' : 'AUTOMÁTICO DESLIGADO (toque para ligar)'}
      </button>
      {!postadorNative.disponivel && <p className="post-warn small">No PC é só para ver como fica: o automático roda no app do celular.</p>}
      {postadorNative.disponivel && on && nat && !nat.semEconomiaBateria && (
        <p className="post-warn small">
          O celular ainda economiza bateria no app e pode parar com a tela bloqueada.{' '}
          <button className="btn sm" onClick={() => void postadorNative.pedirBateria().then(refresh)}>Liberar</button>
        </p>
      )}
      <div className="tone-card" data-testid="auto-box">
        <strong>📰 Blog</strong>
        <span className="small">De hora em hora, das 6h às 23h, pega a melhor notícia nova e publica no site.</span>
        <span className="small muted">Hoje: {rep.blogHoje} publicada(s)</span>
        <button className="btn sm" disabled={!!busy} onClick={() => void run('blog')} data-testid="auto-blog-now">
          {busy === 'blog' ? 'Publicando…' : 'Publicar uma agora'}
        </button>
      </div>
      <div className="tone-card">
        <strong>📱 Instagram</strong>
        <span className="small">
          Nos horários de pico (<b>{rep.slots.join(' · ')}</b>) posta como Reels a matéria do blog que teve <b>mais visualizações</b>. Não posta todas.
        </span>
        <span className="small muted">Hoje: {rep.instagramHoje} Reels</span>
        <button className="btn sm" disabled={!!busy} onClick={() => void run('instagram')} data-testid="auto-ig-now">
          {busy === 'instagram' ? 'Postando…' : 'Postar a melhor agora'}
        </button>
      </div>
      <p className="small muted">
        Chaves e senhas: <button className="btn sm" onClick={openSettings} data-testid="auto-open-settings">⚙ Configurações</button>
      </p>
      {rep.log.length > 0 && (
        <details open>
          <summary className="small muted">O que ele fez</summary>
          <ul className="small muted">
            {rep.log.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
