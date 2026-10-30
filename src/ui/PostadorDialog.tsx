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
import { autopostReport, BLOG_HOUR, BLOG_LOTE, getAutoConfig, instagramList, instagramRanking, runJob, setAutoConfig, startAutopostClock, type Job } from '../news/autopostApp';
import { PostadorStatusCard, useAutopostStatus } from './PostadorStatus';
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
import { morePhotos, postToBlog } from '../news/blogPost';
import { ensureDefaultTones, trackUrl } from '../news/defaultTones';
import { releases } from '../news/release';
import { videoTexts } from '../news/videoTexts';
import { aiChat } from '../news/openrouter';
import { getAiKey, native, nativePost } from '../news/client';

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
  const [selecionadas, setSelecionadas] = useState<Set<string>>(new Set());
  /** pautas que a IA marcou como release/institucional (não vão para o site) */
  const [rel, setRel] = useState<Set<string>>(new Set());
  /** postagem em lote: quantas já foram e quantas faltam */
  const [lote, setLote] = useState<{ feitas: number; total: number } | null>(null);
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
      setRel(new Set());
      // release de prefeitura/órgão: marca na lista e tira do "Marcar todas"
      void releases(
        aiChat(getAiKey(), native ? nativePost : undefined),
        r.pautas.map((p) => ({ id: p.id, titulo: p.title, texto: p.blocks.filter((b) => b.type === 'p').map((b) => b.text ?? '').join(' ') })),
      ).then(setRel);
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
      await ensureDefaultTones();
      const tones = loadTones();
      const tone = resolveTone(tones, story.tom, story.audio, `${story.titulo} ${story.paragrafos.join(' ')}`, story.categoria);
      if (!tone) throw new Error('Nenhuma música nos tons: o post não sai sem música.');
      // título curto e direto + subtítulo inteiro (sem reticências)
      const vt = await videoTexts(aiChat(getAiKey()), { titulo: story.titulo, subtitulo: story.subtitulo, texto: story.paragrafos.join(' '), palavras: story.palavrasChave, destaque: story.destaque }, { tone: false });
      const id = await createStoryVideo({
        kicker: story.categoria || story.minititulo || 'Notícia',
        title: vt.titulo,
        subtitle: vt.subtitulo,
        keywords: [vt.destaque ?? '', ...story.palavrasChave].filter(Boolean),
        photo: await photo(story, open),
        // mais fotos da matéria: slide, uma atrás da outra
        morePhotos: await morePhotos(story.imagens, open.url),
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

  /** posta uma a uma, na ordem; não para se uma falhar, segue para as próximas */
  const postMany = async (ids: string[]) => {
    const alvo = ids.filter((id) => post[id]?.ok !== true);
    if (!alvo.length) return;
    setBusy('postall');
    setLote({ feitas: 0, total: alvo.length });
    for (let i = 0; i < alvo.length; i++) {
      const p = pautas?.find((x) => x.id === alvo[i]);
      if (!p) continue;
      const set = (msg: string, ok?: boolean) => setPost((m) => ({ ...m, [p.id]: { msg, ok } }));
      try {
        const r = await postToBlog(p, { prompt, onStep: (m) => set(m) });
        if (r.story.costUsd) addSpend(r.story.costUsd);
        set(`✓ No site${r.siteId ? ` (nº ${r.siteId})` : ''}, publicada`, true);
      } catch (e) {
        set(`✗ ${(e as Error).message}`, false);
      }
      setLote({ feitas: i + 1, total: alvo.length });
    }
    setSelecionadas((s) => new Set([...s].filter((id) => !alvo.includes(id))));
    notify(`${alvo.length} matéria(s) postada(s) no site.`);
    setLote(null);
    setBusy(null);
  };

  const postaveis = (pautas ?? []).filter((p) => post[p.id]?.ok !== true && !rel.has(p.id));
  const toggleSel = (id: string) => setSelecionadas((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const marcarTodas = () => setSelecionadas(selecionadas.size === postaveis.length ? new Set() : new Set(postaveis.map((p) => p.id)));

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
        <>
          {postaveis.length > 0 && (
            <div className="row-gap pauta-lote" data-testid="postador-lote-bar">
              <button className="btn sm" onClick={marcarTodas} disabled={busy === 'postall'} data-testid="postador-marcar-todas">
                {selecionadas.size === postaveis.length ? 'Desmarcar todas' : `Marcar todas (${postaveis.length})`}
              </button>
              <button
                className="btn sm primary"
                disabled={!selecionadas.size || busy === 'postall'}
                onClick={() => void postMany([...selecionadas])}
                data-testid="postador-enviar-selecionadas"
              >
                {busy === 'postall' && lote ? `Postando ${lote.feitas} de ${lote.total}…` : `Enviar selecionadas (${selecionadas.size})`}
              </button>
            </div>
          )}
          <div className="post-cards" data-testid="postador-list">
            {pautas.map((p, i) => (
              <div key={p.id} className="post-card pauta-card" data-testid="postador-pauta">
                {post[p.id]?.ok !== true && !rel.has(p.id) && (
                  <input
                    type="checkbox"
                    className="pauta-check"
                    checked={selecionadas.has(p.id)}
                    onChange={() => toggleSel(p.id)}
                    disabled={busy === 'postall'}
                    aria-label={`Selecionar "${p.title}"`}
                    data-testid="postador-check"
                  />
                )}
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
                  {rel.has(p.id) && <span className="small post-warn" data-testid="postador-release">Release/institucional: não entra no site</span>}
                  {post[p.id] && <span className={`small ${post[p.id]!.ok === false ? 'error-text' : ''}`} data-testid="postador-post-status">{post[p.id]!.msg}</span>}
                </span>
                <button className="btn sm primary pauta-post" disabled={!!busy || post[p.id]?.ok === true} onClick={() => void postSite(p)} data-testid="postador-post">
                  {busy === `post:${p.id}` ? 'Postando…' : post[p.id]?.ok ? 'Postada ✓' : 'Postar no site'}
                </button>
              </div>
            ))}
          </div>
        </>
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
      const a = new Audio(await trackUrl(mediaId));
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
  const live = useAutopostStatus();
  const [lista, setLista] = useState<Awaited<ReturnType<typeof instagramList>> | null>(null);
  const [ranking, setRanking] = useState<Awaited<ReturnType<typeof instagramRanking>> | null>(null);
  const [rankBusy, setRankBusy] = useState(false);
  const [qtd, setQtd] = useState(2);
  const loadRanking = async () => {
    setRankBusy(true);
    try {
      setRanking(await instagramRanking());
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally {
      setRankBusy(false);
    }
  };
  const [listErr, setListErr] = useState<string | null>(null);
  const [listBusy, setListBusy] = useState(false);
  const refresh = () => {
    setRep(autopostReport());
    void postadorNative.status().then(setNat);
  };
  const loadList = async () => {
    setListBusy(true);
    setListErr(null);
    try {
      setLista(await instagramList());
    } catch (e) {
      setListErr((e as Error).message);
    } finally {
      setListBusy(false);
    }
  };
  useEffect(() => {
    refresh();
    const id = window.setInterval(refresh, 4000);
    return () => window.clearInterval(id);
  }, []);
  // log e lista acompanham o trabalho ao vivo
  useEffect(() => {
    setRep(autopostReport());
    if (!live.job && live.last && lista) void loadList();
  }, [live.step, live.job]);
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
    } else if (!live.job) await postadorNative.stop();
    refresh();
  };
  /** manda para a fila (continua fora da tela); o resultado aparece no status */
  const run = (job: Job) => {
    notify(live.job ? 'Entrou na fila: começa quando terminar o trabalho atual.' : 'Começou. Pode navegar pelo app: continua trabalhando.');
    runJob(job).catch(() => undefined);
  };
  return (
    <div className="auto-tab">
      <PostadorStatusCard />
      <button className={`btn wide auto-switch ${on ? 'primary' : ''}`} onClick={() => void toggle()} data-testid="auto-switch">
        {on ? 'AUTOMÁTICO LIGADO ✓ (toque para desligar)' : 'AUTOMÁTICO DESLIGADO (toque para ligar)'}
      </button>
      {!postadorNative.disponivel && <p className="post-warn small">No PC é só para ver como fica: o automático roda no app do celular.</p>}
      {postadorNative.disponivel && nat && !nat.semEconomiaBateria && (
        <p className="post-warn small">
          O celular ainda economiza bateria no app e pode parar fora da tela.{' '}
          <button className="btn sm" onClick={() => void postadorNative.pedirBateria().then(refresh)}>Liberar</button>
        </p>
      )}
      <div className="tone-card" data-testid="auto-box">
        <strong>📰 Blog</strong>
        <span className="small">De manhã, às {BLOG_HOUR}h, publica de uma vez o lote do dia: até {BLOG_LOTE} melhores notícias novas que ainda não estão no site.</span>
        <span className="small muted">Hoje: {rep.blogHoje} publicada(s)</span>
        {rep.ultimoSinal && <span className="small muted" data-testid="auto-sinal">Último sinal do celular: {new Date(rep.ultimoSinal).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>}
        <button className="btn sm" onClick={() => run({ kind: 'blog' })} data-testid="auto-blog-now">
          Publicar uma agora
        </button>
      </div>
      <div className="tone-card" data-testid="ig-box">
        <strong>📱 Instagram</strong>
        <span className="small">
          Manual: a IA ranqueia as matérias do blog por impacto/polêmica (crime, política, bombástico; release e nota institucional ficam de fora), com Guarabira, João Pessoa e Campina na frente. Você escolhe quantas postar.
        </span>
        <span className="small muted">Hoje: {rep.instagramHoje} Reels</span>
        <button className="btn sm" disabled={rankBusy} onClick={() => void loadRanking()} data-testid="ig-rank-load">
          {rankBusy ? 'Avaliando as matérias…' : ranking ? 'Atualizar ranking' : 'Ver ranking'}
        </button>
        {ranking && ranking.length === 0 && <p className="small muted" data-testid="ig-rank-vazio">Nada forte o bastante agora (nota mínima 7/10). Não posta por postar.</p>}
        {ranking && ranking.length > 0 && (
          <>
            <ol className="ig-rank small" data-testid="ig-rank">
              {ranking.map((r, i) => (
                <li key={r.item.id} className={i < qtd ? 'vai' : ''}>
                  <b>{r.item.title}</b>
                  <span className="muted"> · {r.porque}</span>
                </li>
              ))}
            </ol>
            <div className="row-gap wrap">
              <span className="small">Quantas postar:</span>
              <button className="btn sm" disabled={qtd <= 1} onClick={() => setQtd((q) => Math.max(1, q - 1))} aria-label="Menos uma" data-testid="ig-qtd-menos">
                −
              </button>
              <b data-testid="ig-qtd">{Math.min(qtd, ranking.length)}</b>
              <button className="btn sm" disabled={qtd >= ranking.length} onClick={() => setQtd((q) => Math.min(ranking.length, q + 1))} aria-label="Mais uma" data-testid="ig-qtd-mais">
                +
              </button>
              <button
                className="btn sm primary"
                onClick={() => {
                  run({ kind: 'lote', itens: ranking.slice(0, Math.min(qtd, ranking.length)).map((r) => r.item) });
                  setRanking(null);
                }}
                data-testid="ig-lote"
              >
                Postar lote ({Math.min(qtd, ranking.length)})
              </button>
            </div>
          </>
        )}
        <div className="row-between">
          <strong className="small">Matérias publicadas no blog</strong>
          <button className="btn sm" disabled={listBusy} onClick={() => void loadList()} data-testid="ig-list-load">
            {listBusy ? 'Carregando…' : lista ? 'Atualizar' : 'Mostrar lista'}
          </button>
        </div>
        {listErr && <p className="error-text small">{listErr}</p>}
        {lista && lista.length === 0 && <p className="small muted">Nenhuma matéria publicada encontrada.</p>}
        {lista && (
          <div className="post-cards" data-testid="ig-list">
            {lista.map((n) => (
              <div key={n.id} className="post-card" data-testid="ig-item">
                <span className="post-card-body">
                  <strong>{n.title}</strong>
                  <span className="small muted">
                    nº {n.id}{n.status && !/public/i.test(n.status) ? ` · ${n.status}` : ''}
                    {typeof n.views === 'number' ? ` · ${n.views} visualizações` : ''}
                    {n.perHour !== null ? ` · ${n.perHour.toFixed(0)}/h` : ''}
                    {n.date ? ` · ${new Date(n.date).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}` : ''}
                  </span>
                </span>
                {n.noInstagram ? (
                  <span className="small ok-text">✓ no Instagram</span>
                ) : (
                  <button className="btn sm primary" onClick={() => run({ kind: 'instagram', item: n })} data-testid="ig-post">
                    Postar no Instagram
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      <p className="small muted">
        Chaves e senhas: <button className="btn sm" onClick={openSettings} data-testid="auto-open-settings">⚙ Configurações</button>
      </p>
      {rep.log.length > 0 && (
        <details open>
          <summary className="small muted">O que ele fez</summary>
          <ul className="small muted" data-testid="auto-log">
            {rep.log.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
