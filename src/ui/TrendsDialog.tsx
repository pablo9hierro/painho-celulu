/**
 * Trends do momento: o que está sendo buscado e noticiado agora (Brasil),
 * Reels virais, ranking de hashtags e busca de uma hashtag. Fontes públicas
 * e gratuitas; cada item diz de onde veio o número. "Criar matéria" abre a
 * Postagem já com o assunto.
 */
import { useEffect, useState } from 'react';
import { useBackHandler } from '../platform/backButton';
import { findHashtag, findTrends } from '../news/client';
import type { HashtagLookup, TrendsResult } from '../news/trends';
import { IconClose } from './icons';

type Tab = 'searches' | 'news' | 'reels' | 'hashtags';
const TABS: { id: Tab; label: string }[] = [
  { id: 'searches', label: 'Em alta' },
  { id: 'news', label: 'Notícias' },
  { id: 'reels', label: 'Reels virais' },
  { id: 'hashtags', label: 'Hashtags' },
];

const fmt = (n: number) => (n >= 1000 ? `${Math.round(n / 100) / 10} mil` : String(n));
const open = (url: string) => window.open(url, '_blank', 'noopener');

export function TrendsDialog({ onClose, onCreateStory }: { onClose: () => void; onCreateStory: (query: string) => void }) {
  const [data, setData] = useState<TrendsResult | null>(null);
  const [tab, setTab] = useState<Tab>('searches');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [section, setSection] = useState('Todas');
  const [tag, setTag] = useState('');
  const [lookup, setLookup] = useState<HashtagLookup | null>(null);
  const [tagBusy, setTagBusy] = useState(false);
  useBackHandler(true, onClose);

  const load = async (refresh = false) => {
    setBusy(true);
    setError(null);
    try {
      setData(await findTrends(refresh));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const searchTag = async () => {
    if (!tag.trim()) return;
    setTagBusy(true);
    try {
      setLookup(await findHashtag(tag));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setTagBusy(false);
    }
  };

  const sections = data ? ['Todas', ...new Set(data.headlines.map((h) => h.section))] : ['Todas'];
  const headlines = data ? data.headlines.filter((h) => section === 'Todas' || h.section === section) : [];

  return (
    <div className="modal-back" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal post-modal" role="dialog" aria-label="Trends do momento" data-testid="trends-dialog">
        <div className="modal-head">
          <h3>Trends do momento</h3>
          <div className="row-gap">
            <button className="btn sm" onClick={() => void load(true)} disabled={busy} data-testid="trends-refresh">
              {busy ? 'Capturando…' : 'Atualizar'}
            </button>
            <button className="icon-btn" onClick={onClose} aria-label="Fechar">
              <IconClose />
            </button>
          </div>
        </div>
        <p className="muted small">
          Fontes públicas: Google Trends Brasil (buscas), Google Notícias (cobertura dos veículos) e Reddit (Reels mais votados). O Instagram não libera dados públicos de tendência.
          {data && ` · Capturado às ${new Date(data.capturedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`}
        </p>
        {data && data.failed.length > 0 && <p className="post-warn small">Não respondeu agora: {data.failed.join(', ')}. O resto da lista vale normalmente.</p>}
        {error && <p className="error-text">{error}</p>}

        <div className="seg trends-tabs">
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)} data-testid={`trends-tab-${t.id}`}>
              {t.label}
            </button>
          ))}
        </div>

        {!data && busy && <p className="muted">Capturando o que está em alta…</p>}

        {data && tab === 'searches' && (
          <ol className="trend-list" data-testid="trends-searches">
            {data.searches.map((s, i) => (
              <li key={s.term} className="trend-item">
                <span className="trend-rank">{i + 1}</span>
                <span className="trend-body">
                  <strong>{s.term}</strong>
                  <span className="small muted">~{fmt(s.traffic)} buscas no Google{s.news[0] ? ` · ${s.news[0].source}` : ''}</span>
                  {s.news[0] && <span className="small">{s.news[0].title}</span>}
                </span>
                <span className="trend-actions">
                  <button className="btn sm" onClick={() => onCreateStory(s.term)}>
                    Criar matéria
                  </button>
                  {s.news[0] && (
                    <button className="btn sm ghost" onClick={() => open(s.news[0]!.url)}>
                      Abrir
                    </button>
                  )}
                </span>
              </li>
            ))}
            {!data.searches.length && <p className="muted">Sem dados do Google Trends agora. Toque em Atualizar.</p>}
          </ol>
        )}

        {data && tab === 'news' && (
          <>
            <div className="chip-row">
              {sections.map((s) => (
                <button key={s} className={`chip ${section === s ? 'on' : ''}`} onClick={() => setSection(s)}>
                  {s}
                </button>
              ))}
            </div>
            <ol className="trend-list" data-testid="trends-news">
              {headlines.map((h, i) => (
                <li key={h.url} className="trend-item">
                  <span className="trend-rank">{i + 1}</span>
                  <span className="trend-body">
                    <strong>{h.title}</strong>
                    <span className="small muted">
                      {h.section} · {h.source} · {h.coverage > 1 ? `${h.coverage} veículos cobrindo` : '1 veículo'}
                      {h.date ? ` · ${new Date(h.date).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}` : ''}
                    </span>
                  </span>
                  <span className="trend-actions">
                    <button className="btn sm" onClick={() => onCreateStory(h.title)}>
                      Criar matéria
                    </button>
                    <button className="btn sm ghost" onClick={() => open(h.url)}>
                      Abrir
                    </button>
                  </span>
                </li>
              ))}
            </ol>
          </>
        )}

        {data && tab === 'reels' && (
          <ol className="trend-list" data-testid="trends-reels">
            {data.reels.map((r) => (
              <li key={r.url} className="trend-item">
                <span className="trend-rank">{r.rank}</span>
                <span className="trend-body">
                  <strong>{r.title}</strong>
                  <span className="small muted">
                    {r.region} · {r.rank}º mais votado ({r.community}){r.date ? ` · ${new Date(r.date).toLocaleDateString('pt-BR')}` : ''}
                  </span>
                  <span className="small reel-link">{r.url}</span>
                </span>
                <span className="trend-actions">
                  <button className="btn sm" onClick={() => open(r.url)}>
                    Abrir Reels
                  </button>
                  <button className="btn sm ghost" onClick={() => void navigator.clipboard?.writeText(r.url).catch(() => undefined)}>
                    Copiar link
                  </button>
                </span>
              </li>
            ))}
            {!data.reels.length && <p className="muted">Nenhum Reels capturado agora (o Reddit limita pedidos seguidos). Tente Atualizar em alguns minutos.</p>}
          </ol>
        )}

        {data && tab === 'hashtags' && (
          <>
            <div className="post-search">
              <input className="input" value={tag} placeholder="#hashtag ou assunto (ex.: #Paraíba)" onChange={(e) => setTag(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void searchTag()} data-testid="trends-tag-input" />
              <button className="btn primary" onClick={() => void searchTag()} disabled={tagBusy || !tag.trim()} data-testid="trends-tag-search">
                {tagBusy ? 'Buscando…' : 'Ver hashtag'}
              </button>
            </div>
            {lookup && (
              <div className="tag-lookup" data-testid="trends-tag-result">
                <strong>{lookup.tag}</strong>
                <span className="small muted">
                  {lookup.recent} notícias nas últimas 48 h · {lookup.outlets} veículos
                </span>
                {lookup.related.length > 0 && <span className="small">Relacionadas: {lookup.related.map((r) => r.tag).join(' ')}</span>}
                <button className="btn sm" onClick={() => onCreateStory(lookup.tag.replace(/^#/, '').replace(/([a-zà-ú])([A-ZÀ-Ú])/g, '$1 $2'))}>
                  Criar matéria sobre isso
                </button>
              </div>
            )}
            <ol className="trend-list" data-testid="trends-hashtags">
              {data.hashtags.map((h, i) => (
                <li key={h.tag} className="trend-item">
                  <span className="trend-rank">{i + 1}</span>
                  <span className="trend-body">
                    <strong>{h.tag}</strong>
                    <span className="small muted">
                      pontuação {Math.round(h.score)} · citada {h.mentions}x nas capturas
                    </span>
                  </span>
                  <span className="trend-actions">
                    <button className="btn sm ghost" onClick={() => void navigator.clipboard?.writeText(h.tag).catch(() => undefined)}>
                      Copiar
                    </button>
                  </span>
                </li>
              ))}
            </ol>
            {data.hashtags.length > 0 && (
              <button className="btn sm" onClick={() => void navigator.clipboard?.writeText(data.hashtags.slice(0, 10).map((h) => h.tag).join(' ')).catch(() => undefined)}>
                Copiar as 10 primeiras
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
