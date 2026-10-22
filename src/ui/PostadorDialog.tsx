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
import { fetchPhoto, findPautas, getIgConfig, getSiteConfig, instagramStatus, setIgConfig, setSiteConfig, siteDelete, siteList, sitePublish, siteTest, writeSite, type IgStatus } from '../news/postadorClient';
import { native } from '../news/client';
import { autopostReport, getAutoConfig, setAutoConfig, startAutopostClock, tick, type AutoConfig } from '../news/autopostApp';
import { postadorNative } from '../platform/postadorNative';
import { aiReady, getAiKey, getFx, setAiKey } from '../news/client';
import { addSpend, brl, type Fx } from '../news/cost';
import { loadTones, resolveTone, saveTones, tonesForAi, type Tone } from '../news/tones';
import { createStoryVideo } from './storyVideo';
import { waitReady } from './importer';
import { confirmDialog } from './dialogs';
import { IconClose, IconTrash, IconUpload } from './icons';

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
  useBackHandler(true, () => !busy && onClose());
  return (
    <div className="modal-back" onPointerDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal post-modal postador" role="dialog" aria-label="Postador de notícias" data-testid="postador-dialog">
        <div className="modal-head">
          <h3>Postador de notícias</h3>
          <button className="icon-btn" onClick={onClose} disabled={!!busy} aria-label="Fechar">
            <IconClose />
          </button>
        </div>
        <div className="seg postador-tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)} disabled={!!busy} data-testid={`postador-tab-${t.id}`}>
              {t.label}
            </button>
          ))}
        </div>
        {tab === 'pautas' && <PautasTab busy={busy} setBusy={setBusy} />}
        {tab === 'site' && <SiteTab busy={busy} setBusy={setBusy} />}
        {tab === 'tons' && <TonesTab />}
        {tab === 'auto' && <AutoTab />}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ pautas

function PautasTab({ busy, setBusy }: { busy: string | null; setBusy: (b: string | null) => void }) {
  const notify = useEditor((s) => s.notify);
  const [q, setQ] = useState('');
  const [cities, setCities] = useState<string[]>([...CITIES]);
  const [pautas, setPautas] = useState<Pauta[] | null>(null);
  const [open, setOpen] = useState<Pauta | null>(null);
  const [prompt, setPrompt] = useState('');
  const [story, setStory] = useState<SiteStory | null>(null);
  const [publicar, setPublicar] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fx, setFx] = useState<Fx | null>(null);
  const [ai, setAi] = useState<boolean | null>(null);
  const [keyDraft, setKeyDraft] = useState(getAiKey());
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
      });
      notify(tone ? `Post em vídeo criado com a trilha "${tone.track.name}" (${tone.tone.name}).` : 'Post em vídeo criado.');
      location.hash = `#/p/${id}`;
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  };

  const send = async () => {
    if (!story || !open) return;
    setBusy('send');
    setError(null);
    try {
      const f = await photo(story, open);
      const r = await sitePublish({
        titulo: story.titulo,
        subtitulo: story.subtitulo,
        minititulo: story.minititulo,
        categoria: story.categoria,
        palavrasChave: story.palavrasChave,
        html: story.html,
        foto: f ? { data: new Uint8Array(await f.arrayBuffer()), type: f.type, name: f.name } : null,
        publicar,
      });
      notify(r.id ? `Enviada ao site: notícia nº ${r.id}${publicar ? ' (publicada)' : ' (em revisão)'}.` : 'Enviada ao site. Confira no painel.');
    } catch (e) {
      setError((e as Error).message);
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
            <button key={p.id} className="post-card pauta-card" onClick={() => { setOpen(p); setStory(null); }} data-testid="postador-pauta">
              <span className="pauta-rank">{i + 1}</span>
              <span className="post-card-body">
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
              </span>
            </button>
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
                <div className="post-key">
                  <span className="small">Cole a chave da IA (OpenRouter sk-or-... ou Google AIza...). Fica só neste aparelho:</span>
                  <div className="post-search">
                    <input className="input" type="password" value={keyDraft} onChange={(e) => setKeyDraft(e.target.value)} />
                    <button className="btn" onClick={() => { setAiKey(keyDraft); void aiReady().then(setAi); }}>Salvar chave</button>
                  </div>
                </div>
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
              <div className="row-gap wrap">
                <button className="btn primary" onClick={() => void video()} disabled={!!busy} data-testid="postador-video">
                  {busy === 'video' ? 'Montando o vídeo…' : 'Criar post em vídeo'}
                </button>
                <button className="btn" onClick={() => void send()} disabled={!!busy} data-testid="postador-send">
                  {busy === 'send' ? 'Enviando…' : publicar ? 'Publicar no site' : 'Enviar ao site (revisão)'}
                </button>
                <label className="check-row small">
                  <input type="checkbox" checked={publicar} onChange={(e) => setPublicar(e.target.checked)} /> já publicar
                </label>
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
  const [cfg, setCfg] = useState(getSiteConfig);
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
      <div className="site-cfg">
        <label className="field">
          <span>Endereço do painel</span>
          <input className="input" value={cfg.base} placeholder="https://primeirasnoticias.com.br/websg/" onChange={(e) => setCfg({ ...cfg, base: e.target.value })} />
        </label>
        <label className="field">
          <span>Usuário</span>
          <input className="input" value={cfg.user} autoComplete="username" onChange={(e) => setCfg({ ...cfg, user: e.target.value })} data-testid="site-user" />
        </label>
        <label className="field">
          <span>Senha</span>
          <input className="input" type="password" value={cfg.pass} autoComplete="current-password" onChange={(e) => setCfg({ ...cfg, pass: e.target.value })} data-testid="site-pass" />
        </label>
        <div className="row-gap wrap">
          <button className="btn" onClick={() => { setSiteConfig(cfg); notify('Acesso do painel salvo neste aparelho.'); }}>
            Salvar
          </button>
          <button className="btn primary" disabled={!!busy} onClick={() => void run('test', async () => { setSiteConfig(cfg); const r = await siteTest(); notify(`Acesso OK: ${r.total} matérias na 1ª página do painel.`); })} data-testid="site-test">
            {busy === 'test' ? 'Testando…' : 'Testar acesso'}
          </button>
        </div>
        <p className="small muted">Fica guardado só neste aparelho. No PC, se deixar vazio, o app usa WEBSG_USER/WEBSG_PASS do .env.local.</p>
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
  const audio = useRef<HTMLAudioElement | null>(null);
  const update = (t: Tone[]) => {
    setTones(t);
    saveTones(t);
  };
  useEffect(() => () => audio.current?.pause(), []);

  const upload = async (toneId: string, files: File[]) => {
    setUploading(toneId);
    try {
      for (const f of files) {
        const up = await mediaApi.upload(f);
        const m = await waitReady(up.id);
        if (m.status !== 'ready') throw new Error(m.error ?? `Não foi possível ler ${f.name}`);
        setTones((cur) => {
          const next = cur.map((t) => (t.id === toneId ? { ...t, tracks: [...t.tracks, { mediaId: m.id, name: f.name.replace(/\.[^.]+$/, '') }] } : t));
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
        Opcional. Crie um tom (ex.: Policial, Economia) e coloque áudios com nomes que digam o clima (ex.: "tensão grave", "suspense leve"). Ao escrever a matéria, a IA identifica o tom e escolhe o áudio que mais combina para o post em vídeo.
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
      {tones.length === 0 && <p className="small muted">Nenhum tom ainda: os posts saem sem trilha.</p>}
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
            <div key={k.mediaId + i} className="tone-track">
              <button className="btn sm" onClick={() => void play(k.mediaId)}>{playing === k.mediaId ? '■' : '▶'}</button>
              <input className="input" value={k.name} aria-label="Nome do áudio" onChange={(e) => update(tones.map((x) => (x.id === t.id ? { ...x, tracks: x.tracks.map((y, j) => (j === i ? { ...y, name: e.target.value } : y)) } : x)))} />
              <button className="icon-btn sm" aria-label="Tirar áudio do tom" title="Tirar do tom (o arquivo continua na biblioteca)" onClick={() => update(tones.map((x) => (x.id === t.id ? { ...x, tracks: x.tracks.filter((_, j) => j !== i) } : x)))}>
                <IconTrash />
              </button>
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

/** Instagram: situação dos tokens (renovação automática) e, no app, onde colar os tokens */
function InstagramBox() {
  const [st, setSt] = useState<IgStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [cfg, setCfg] = useState(getIgConfig);
  const load = () => {
    setErr(null);
    instagramStatus().then(setSt).catch((e: Error) => setErr(e.message));
  };
  useEffect(load, []);
  const d = (s: string | null) => (s ? new Date(s).toLocaleDateString('pt-BR') : '—');
  return (
    <div className="tone-card" data-testid="ig-box">
      <strong>Instagram</strong>
      {err && <p className="error-text">{err}</p>}
      {st && !st.configurado && <p className="muted">Instagram não configurado{native ? ': cole os tokens abaixo.' : ' no PC (.env.local).'}</p>}
      {st?.conta && (
        <p>
          Conectado: <strong>@{st.conta.username}</strong>
          {st.conta.followers_count ? ` · ${st.conta.followers_count.toLocaleString('pt-BR')} seguidores` : ''}
        </p>
      )}
      {st?.configurado && (
        <p className="muted">
          Token do Instagram renovado em {d(st.igRenovadoEm)} (vale até {d(st.igVence)}; renova sozinho 10 dias antes de vencer) · acesso do token do Facebook vence em {d(st.fbAcessoVence)}
        </p>
      )}
      {st?.avisos.map((a, i) => (
        <p key={i} className="post-warn small">
          ⚠ {a}
        </p>
      ))}
      {native && (
        <>
          <input className="input" placeholder="ID da conta do Instagram (1784...)" value={cfg.userId} onChange={(e) => setCfg({ ...cfg, userId: e.target.value.trim() })} />
          <input className="input" type="password" placeholder="Token do Facebook (EAA...) — posta os Reels" value={cfg.fbToken} onChange={(e) => setCfg({ ...cfg, fbToken: e.target.value.trim() })} />
          <input className="input" type="password" placeholder="Token do Instagram (IGAA...) — renova sozinho" value={cfg.igToken} onChange={(e) => setCfg({ ...cfg, igToken: e.target.value.trim(), meta: {} })} />
          <button className="btn sm" onClick={() => { setIgConfig(cfg); load(); }}>
            Salvar e conferir
          </button>
        </>
      )}
    </div>
  );
}

function AutoTab() {
  const notify = useEditor((s) => s.notify);
  const [cfg, setCfg] = useState<AutoConfig>(getAutoConfig);
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
  const save = async (c: AutoConfig) => {
    setCfg(c);
    setAutoConfig(c);
    if (c.ativo) {
      await postadorNative.start().catch((e: Error) => notify(e.message, 'error'));
      startAutopostClock();
    } else await postadorNative.stop();
    refresh();
  };
  const run = async (what: 'postar' | 'estatistica') => {
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
    <div className="auto-tab small">
      <InstagramBox />
      <div className="tone-card" data-testid="auto-box">
        <strong>Postador automático (neste celular)</strong>
        {!postadorNative.disponivel && <p className="post-warn small">No PC é só para ver como fica: a postagem automática roda no app do celular.</p>}
        <label className="check-row">
          <input type="checkbox" checked={cfg.ativo} onChange={(e) => void save({ ...cfg, ativo: e.target.checked })} data-testid="auto-on" />
          Ligado (roda sozinho, mesmo com a tela bloqueada)
        </label>
        <label className="check-row">
          <input type="checkbox" checked={cfg.valendo} onChange={(e) => void save({ ...cfg, valendo: e.target.checked })} data-testid="auto-real" />
          Publicar de verdade no site e no Instagram (desligado = ensaio)
        </label>
        <label className="check-row">
          <input type="checkbox" checked={cfg.sitePublicar} onChange={(e) => void save({ ...cfg, sitePublicar: e.target.checked })} />
          No site, já como "Publicado" (desligado = "Revisão")
        </label>
        <label className="field">
          <span>Máximo de posts por dia</span>
          <input className="input" type="number" min={1} max={12} value={cfg.maxDia} onChange={(e) => void save({ ...cfg, maxDia: Math.max(1, Math.min(12, Number(e.target.value) || 4)) })} />
        </label>
        {postadorNative.disponivel && nat && (
          <p className={nat.ligado && nat.semEconomiaBateria ? 'muted' : 'post-warn small'}>
            Serviço: {nat.ligado ? 'ligado ✓' : 'desligado'} · bateria: {nat.semEconomiaBateria ? 'sem restrição ✓' : 'com economia (pode parar com a tela bloqueada)'}
          </p>
        )}
        <div className="row-gap wrap">
          {postadorNative.disponivel && nat && !nat.semEconomiaBateria && (
            <button className="btn sm" onClick={() => void postadorNative.pedirBateria().then(refresh)}>
              Liberar bateria sem restrição
            </button>
          )}
          <button className="btn sm" disabled={!!busy} onClick={() => void run('estatistica')}>
            {busy === 'estatistica' ? 'Lendo…' : 'Atualizar estatística'}
          </button>
          <button className="btn sm primary" disabled={!!busy} onClick={() => void run('postar')} data-testid="auto-post-now">
            {busy === 'postar' ? 'Postando…' : cfg.valendo ? 'Postar agora' : 'Testar agora (ensaio)'}
          </button>
        </div>
      </div>
      <p>
        <strong>Próximos horários (Brasília):</strong> {rep.slots.join(' · ')}
        <br />
        <span className="muted">Base: {rep.source}. Se o celular estiver dormindo ou falhar, tenta de novo por até 1h30 depois do horário (3 tentativas).</span>
      </p>
      <p>
        Matérias postadas: {rep.stories} · medidas (36 h+): {rep.measured}
      </p>
      {rep.rules && <pre className="auto-rules">{rep.rules}</pre>}
      {rep.log.length > 0 && (
        <details open>
          <summary className="muted">O que ele fez</summary>
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
