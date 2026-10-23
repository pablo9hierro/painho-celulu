/**
 * Postagem: busca as notícias sobre a pauta (back-end), mostra cada uma como
 * card, e escreve a legenda/matéria do Instagram com IA — só com dados das
 * fontes, conferidos — dentro do limite de caracteres do Instagram.
 */
import { useEffect, useState } from 'react';
import { useEditor } from '../state/store';
import { useBackHandler } from '../platform/backButton';
import { deviceStorage } from '../platform/api';
import { aiReady, findFromLinks, findNews, getAiKey, getFx, setAiKey, writeFromNews, type NewsPlan, type WriteResult } from '../news/client';
import { addSpend, brl, getSpend, type Fx } from '../news/cost';
import type { Article } from '../news/search';
import { IG_LIMIT } from '../news/writer';
import { plainCaption, styleCaption } from '../news/unicodeStyle';
import { censorCaption } from '../news/censor';
import { publishExported } from '../news/igPublish';
import { native } from '../news/client';
import { IconClip, IconClose } from './icons';
import { writeClipboard } from '../platform/clipboard';

interface Saved {
  query: string;
  text: string;
}

const storeKey = (id: string) => `pn-post-${id}`;
function load(id: string): Saved {
  try {
    return { query: '', text: '', ...(JSON.parse(localStorage.getItem(storeKey(id)) ?? '{}') as Partial<Saved>) };
  } catch {
    return { query: '', text: '' };
  }
}

const WINDOW_LABEL: Record<string, string> = { year: 'notícias do ano pedido', '1d': 'notícias das últimas 24 h', '3d': 'notícias dos últimos 3 dias', '7d': 'notícias dos últimos 7 dias', '30d': 'notícias dos últimos 30 dias', any: 'sem limite de data (pedido de notícia antiga)' };

/** "há 2 h", "há 3 dias" */
function ago(iso: string): string {
  const m = (Date.now() - new Date(iso).getTime()) / 60000;
  if (m < 60) return `há ${Math.max(1, Math.round(m))} min`;
  if (m < 1440) return `há ${Math.round(m / 60)} h`;
  const d = Math.round(m / 1440);
  return d < 60 ? `há ${d} dia${d > 1 ? 's' : ''}` : `há ${Math.round(d / 30)} meses`;
}

async function copy(text: string): Promise<boolean> {
  try {
    await writeClipboard(text);
    return true;
  } catch {
    // reserva para WebViews sem a API de área de transferência
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

export function PostDialog({ onClose, videoFile, video, initialQuery }: { onClose: () => void; videoFile?: string; video?: Blob; initialQuery?: string }) {
  const projectId = useEditor((s) => s.project?.id ?? 'sem-projeto');
  const notify = useEditor((s) => s.notify);
  const saved = load(projectId);
  const [query, setQuery] = useState(initialQuery ?? saved.query);
  const [articles, setArticles] = useState<Article[] | null>(null);
  const [plan, setPlan] = useState<NewsPlan | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [prompt, setPrompt] = useState('');
  const [text, setText] = useState(saved.text);
  const [info, setInfo] = useState<WriteResult | null>(null);
  const [busy, setBusy] = useState<'search' | 'write' | 'links' | null>(null);
  const [links, setLinks] = useState('');
  const [linksErr, setLinksErr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ai, setAi] = useState<boolean | null>(null);
  const [keyDraft, setKeyDraft] = useState(getAiKey());
  const [bold, setBold] = useState(true);
  // custos da IA (em dólar; mostrados em reais pela cotação do dia)
  const [fx, setFx] = useState<Fx | null>(null);
  const [cost, setCost] = useState<{ search: number; write: number }>({ search: 0, write: 0 });
  const [spend, setSpend] = useState(getSpend);
  const [copied, setCopied] = useState<string | null>(null);
  const [publicando, setPublicando] = useState<string | null>(null);
  const [publicado, setPublicado] = useState<string | null>(null);
  // o Instagram conta caracteres (letra em negrito Unicode = 1)
  const count = [...text].length;

  useBackHandler(true, () => !busy && onClose());
  useEffect(() => {
    void getFx().then(setFx);
    void aiReady().then(setAi);
    // veio das Trends com o assunto: já busca
    if (initialQuery) void search();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // guarda pauta e texto deste projeto no aparelho
  useEffect(() => {
    try {
      localStorage.setItem(storeKey(projectId), JSON.stringify({ query, text }));
    } catch {
      /* sem armazenamento */
    }
  }, [projectId, query, text]);

  const search = async () => {
    if (!query.trim()) return;
    setBusy('search');
    setError(null);
    try {
      const { articles: list, plan: p } = await findNews(query);
      // mantém os links colados à mão (uma busca nova não some com eles)
      setArticles((cur) => {
        const colados = (cur ?? []).filter((a) => a.via === 'link');
        return [...colados, ...list.filter((a) => !colados.some((c) => c.url === a.url))];
      });
      setPlan(p);
      if (p?.costUsd) {
        setCost((c) => ({ ...c, search: c.search + p.costUsd! }));
        setSpend(addSpend(p.costUsd));
      }
      // já marca as mais relevantes que dá para ler por completo (mantém os links já marcados)
      const readable = list.filter((a) => a.readable).slice(0, 4);
      setPicked((s) => new Set([...[...s].filter((u) => (articles ?? []).some((a) => a.url === u && a.via === 'link')), ...(readable.length ? readable : list.slice(0, 3)).map((a) => a.url)]));
      if (!list.length) setError('Nenhuma notícia encontrada. Tente outras palavras (nome da cidade, do bairro, da operação...).');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const write = async () => {
    const chosen = (articles ?? []).filter((a) => picked.has(a.url));
    if (!chosen.length) return setError('Marque ao menos uma notícia.');
    setBusy('write');
    setError(null);
    try {
      const r = await writeFromNews(query, chosen, prompt);
      setInfo(r);
      if (r.costUsd) {
        setCost((c) => ({ ...c, write: c.write + r.costUsd }));
        setSpend(addSpend(r.costUsd));
      }
      // palavras sensíveis disfarçadas para a Meta não derrubar o post
      if (r.text) setText(bold ? styleCaption(censorCaption(r.text)) : censorCaption(r.text));
      else setError('Não foi possível escrever a partir dessas notícias.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  /** usa um ou mais links colados (de qualquer portal) como fonte, pra escrever "inspirado neles" */
  const useLinks = async () => {
    const urls = links.split(/\s+/).filter(Boolean).slice(0, 8);
    if (!urls.length) return;
    setBusy('links');
    setLinksErr(null);
    try {
      const { articles: found, falhas } = await findFromLinks(urls);
      if (found.length) {
        setArticles((cur) => {
          const base = cur ?? [];
          const semDuplicata = found.filter((a) => !base.some((b) => b.url === a.url));
          return [...semDuplicata, ...base];
        });
        setPicked((s) => new Set([...s, ...found.map((a) => a.url)]));
        setLinks('');
      }
      if (falhas.length) setLinksErr(falhas.join(' · '));
      if (!found.length && !falhas.length) setLinksErr('Nenhum link válido.');
    } catch (e) {
      setLinksErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const toggle = (url: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(url)) n.delete(url);
      else n.add(url);
      return n;
    });

  return (
    <div className="modal-back" onPointerDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal post-modal" role="dialog" aria-label="Postagem" data-testid="post-dialog">
        <div className="modal-head">
          <h3>Postagem · matéria para o Instagram</h3>
          <button className="icon-btn" onClick={onClose} disabled={!!busy} aria-label="Fechar">
            <IconClose />
          </button>
        </div>

        <label className="field">
          <span>Pauta (palavras-chave da notícia)</span>
          <div className="post-search">
            <input
              className="input"
              value={query}
              placeholder="ex.: mulher morta Rocam abordagem Pirpirituba 15 de outubro de 2026"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void search()}
              data-testid="post-query"
            />
            <button className="btn primary" onClick={() => void search()} disabled={!!busy || !query.trim()} data-testid="post-search">
              {busy === 'search' ? 'Buscando…' : 'Buscar notícias'}
            </button>
          </div>
        </label>

        {error && <p className="error-text">{error}</p>}

        <label className="field">
          <span>Ou cole o link de uma ou mais matérias (de qualquer portal, um por linha) para se inspirar</span>
          <div className="post-search">
            <textarea
              className="input post-links"
              rows={2}
              value={links}
              placeholder={'https://...\nhttps://...'}
              onChange={(e) => setLinks(e.target.value)}
              data-testid="post-links"
            />
            <button className="btn" onClick={() => void useLinks()} disabled={!!busy || !links.trim()} data-testid="post-links-add">
              {busy === 'links' ? 'Lendo…' : 'Usar estes links'}
            </button>
          </div>
          <span className="small muted">Funciona sozinho ou junto da busca por palavras-chave acima — os dois juntam na mesma lista.</span>
          {linksErr && <span className="error-text small">{linksErr}</span>}
        </label>

        {plan && (
          <p className="small muted" data-testid="post-plan">
            Entendi como: <strong>{plan.queries.join(' · ')}</strong> — {plan.year ? `notícias de ${plan.year}` : WINDOW_LABEL[plan.used]}
            {plan.used !== plan.recency ? ' (ampliado: veio pouca notícia na janela menor)' : ''}. Mais novas primeiro.
          </p>
        )}
        {plan?.missing && plan.missing.length > 0 && (
          <p className="post-warn small" data-testid="post-missing">
            Nenhuma notícia encontrada cita <strong>{plan.missing.join(', ')}</strong>. As da lista podem ser de outro lugar ou caso — confira antes de usar.
          </p>
        )}
        {articles && articles.length > 0 && (
          <div className="post-cards" data-testid="post-cards">
            {articles.map((a) => (
              <label key={a.url} className={`post-card ${picked.has(a.url) ? 'on' : ''}`} data-testid="post-card">
                <input type="checkbox" checked={picked.has(a.url)} onChange={() => toggle(a.url)} />
                <span className="post-card-body">
                  <strong>{a.title}</strong>
                  <span className="muted small">
                    {a.source}
                    {a.date ? ` · ${new Date(a.date).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })} (${ago(a.date)})` : ' · sem data'}
                    {a.readable ? ' · texto completo' : ' · só manchete'}
                    {a.via === 'link' ? ' · link colado' : ''}
                  </span>
                  {a.snippet && <span className="small">{a.snippet}</span>}
                  <a href={a.url} target="_blank" rel="noreferrer" className="small" onClick={(e) => e.stopPropagation()}>
                    Abrir matéria
                  </a>
                </span>
              </label>
            ))}
          </div>
        )}

        {articles && articles.length > 0 && (
          <>
            <label className="field">
              <span>Pedido para a IA (opcional)</span>
              <input className="input" value={prompt} placeholder="ex.: foque na ação da polícia e no que diz a família" onChange={(e) => setPrompt(e.target.value)} data-testid="post-prompt" />
            </label>
            {ai === false && (
              <div className="post-key">
                <span className="small">Para escrever com IA (Gemini Flash), cole a chave — da OpenRouter (sk-or-...) ou do Google AI Studio (AIza...). Fica guardada só neste aparelho:</span>
                <div className="post-search">
                  <input className="input" type="password" value={keyDraft} placeholder="sk-or-... ou AIza..." onChange={(e) => setKeyDraft(e.target.value)} />
                  <button
                    className="btn"
                    onClick={() => {
                      setAiKey(keyDraft);
                      void aiReady().then(setAi);
                    }}
                  >
                    Salvar chave
                  </button>
                </div>
                <span className="muted small">Sem a chave, o app monta um rascunho simples a partir das manchetes.</span>
              </div>
            )}
            <button className="btn primary wide" onClick={() => void write()} disabled={!!busy || picked.size === 0} data-testid="post-write">
              {busy === 'write' ? 'Lendo as matérias, escrevendo e conferindo os dados…' : 'Escrever matéria'}
            </button>
          </>
        )}

        <label className="field">
          <span className="row-between">
            <span className="row-gap">
              Legenda do Reels
              <button
                type="button"
                className="icon-btn sm clip-btn"
                title="Copiar a legenda inteira"
                aria-label="Copiar legenda"
                disabled={!text.trim()}
                onClick={(e) => {
                  e.preventDefault();
                  void copy(text).then((ok) => setCopied(ok ? 'Legenda copiada. Cole na descrição do Reels.' : 'Não foi possível copiar.'));
                }}
                data-testid="post-clip"
              >
                <IconClip />
              </button>
            </span>
            <span className={`small ${count > IG_LIMIT ? 'error-text' : 'muted'}`} data-testid="post-count">
              {count} / {IG_LIMIT}
            </span>
          </span>
          <textarea className="input post-text" rows={12} value={text} onChange={(e) => setText(e.target.value)} data-testid="post-text" />
        </label>
        <label className="check-row">
          <input
            type="checkbox"
            checked={bold}
            onChange={(e) => {
              const on = e.target.checked;
              setBold(on);
              setText((cur) => (on ? styleCaption(cur) : plainCaption(cur)));
            }}
            data-testid="post-bold"
          />
          Negrito no título e nos créditos (letras especiais; o Instagram não tem negrito próprio)
        </label>

        {info?.hashtags && info.hashtags.length > 0 && (
          <div className="post-tags" data-testid="post-tags">
            <span className="small muted">Hashtags escolhidas pelo que está em alta e pelo assunto:</span>
            <div className="chip-row">
              {info.hashtags.map((h) => (
                <span key={h.tag} className="chip on" title={h.why}>
                  {h.tag}
                </span>
              ))}
            </div>
          </div>
        )}
        {info && (
          <div className="post-info" data-testid="post-info">
            {info.unverified.length > 0 && (
              <p className="post-warn">
                ⚠ Confira nas fontes antes de postar: <strong>{info.unverified.join(', ')}</strong>
              </p>
            )}
            <details>
              <summary className="small muted">Como foi feito {info.model ? `· ${info.model}` : '· sem IA'}</summary>
              <ul className="small muted">
                {info.steps.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
                {info.sources.map((s) => (
                  <li key={s.url}>
                    {s.source}: {s.chars ? `${s.chars} caracteres lidos` : 'só manchete'}
                  </li>
                ))}
              </ul>
            </details>
          </div>
        )}

        {fx && (cost.search > 0 || cost.write > 0 || spend.uses > 0) && (
          <div className="ai-cost small" data-testid="ai-cost">
            <strong>Custo da IA (Gemini 2.5 Flash Lite)</strong>
            {(cost.search > 0 || cost.write > 0) && (
              <span>
                Entender a busca: {brl(cost.search, fx.rate)} · escrever e conferir a matéria: {brl(cost.write, fx.rate)} · <strong>total: {brl(cost.search + cost.write, fx.rate)}</strong>
              </span>
            )}
            <span className="muted">
              Gasto total com IA neste aparelho: {brl(spend.usd, fx.rate)} ({spend.uses} uso{spend.uses === 1 ? '' : 's'}) · dólar a {fx.rate.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
              {fx.approx ? ' (cotação aproximada, sem conexão com a cotação do dia)' : ''}
            </span>
          </div>
        )}
        {copied && (
          <p className="small muted" data-testid="post-copied">
            {copied}
          </p>
        )}
        <div className="row-gap wrap">
          <button className="btn primary" disabled={!text.trim()} onClick={() =>
              void copy(text).then((ok) => {
                const msg = ok ? 'Legenda copiada. Cole na descrição do Reels.' : 'Não foi possível copiar.';
                setCopied(msg);
                notify(msg, ok ? 'info' : 'error');
              })
            } data-testid="post-copy">
            Copiar legenda
          </button>
          {video && (
            <button
              className="btn primary"
              disabled={!text.trim() || !!publicando || !!publicado}
              onClick={async () => {
                if (!native) {
                  notify('Publicar direto funciona no app do celular. No PC, copie a legenda e poste pelo Instagram.', 'error');
                  return;
                }
                setPublicando('Preparando…');
                try {
                  const r = await publishExported(video, text, setPublicando);
                  setPublicado(r.comentario ? 'Publicado no Instagram ✓ (descrição também no comentário)' : 'Publicado no Instagram ✓');
                  notify('Reels publicado no Instagram.');
                } catch (e) {
                  notify((e as Error).message, 'error');
                } finally {
                  setPublicando(null);
                }
              }}
              data-testid="post-publish-ig"
            >
              {publicando ?? publicado ?? 'Publicar no Instagram agora'}
            </button>
          )}
          {videoFile && deviceStorage.share && (
            <button
              className="btn"
              disabled={!text.trim()}
              onClick={async () => {
                await copy(text);
                notify('Legenda copiada: cole no Instagram ao postar o vídeo.');
                await deviceStorage.share!(videoFile).catch(() => undefined);
              }}
            >
              Copiar e compartilhar vídeo
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
