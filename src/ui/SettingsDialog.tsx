/**
 * Configurações (um lugar só): chave da IA, acesso ao painel do site e
 * Instagram. Fica guardado no aparelho e continua lá quando o APK é
 * atualizado por cima.
 */
import { useEffect, useState } from 'react';
import { useBackHandler } from '../platform/backButton';
import { useEditor } from '../state/store';
import { aiReady, getAiKey, setAiKey } from '../news/client';
import { getIgConfig, getSiteConfig, instagramStatus, setIgConfig, setSiteConfig, siteTest, type IgStatus } from '../news/postadorClient';
import { IconClose } from './icons';

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const notify = useEditor((s) => s.notify);
  useBackHandler(true, onClose);
  const [ai, setAi] = useState(getAiKey);
  const [aiOk, setAiOk] = useState<boolean | null>(null);
  const [site, setSite] = useState(getSiteConfig);
  const [ig, setIg] = useState(getIgConfig);
  const [igSt, setIgSt] = useState<IgStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<Record<string, string>>({});
  useEffect(() => {
    void aiReady().then(setAiOk);
    void instagramStatus().then(setIgSt).catch(() => undefined);
  }, []);
  const d = (s: string | null | undefined) => (s ? new Date(s).toLocaleDateString('pt-BR') : '—');

  const saveAll = async () => {
    setAiKey(ai);
    setSiteConfig(site);
    setIgConfig(ig);
    setAiOk(await aiReady());
    notify('Configurações salvas neste aparelho.');
  };
  const test = async (what: 'site' | 'ig') => {
    await saveAll();
    setBusy(what);
    try {
      if (what === 'site') {
        const r = await siteTest();
        setMsg((m) => ({ ...m, site: `✓ Acesso OK: ${r.total} matérias na 1ª página do painel.` }));
      } else {
        const r = await instagramStatus();
        setIgSt(r);
        setMsg((m) => ({ ...m, ig: r.conta ? `✓ Conectado: @${r.conta.username}` : 'Não conectou: confira o ID e os tokens.' }));
      }
    } catch (e) {
      setMsg((m) => ({ ...m, [what]: `✗ ${(e as Error).message}` }));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="modal-back" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal post-modal" role="dialog" aria-label="Configurações" data-testid="settings-dialog">
        <div className="modal-head">
          <h3>Configurações</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Fechar">
            <IconClose />
          </button>
        </div>
        <p className="small muted">Tudo fica guardado só neste aparelho e continua aqui quando você atualiza o app.</p>

        <section className="tone-card">
          <strong>IA (escrever matérias)</strong>
          <input className="input" type="password" placeholder="Chave da IA (sk-or-... ou AIza...)" value={ai} onChange={(e) => setAi(e.target.value.trim())} data-testid="cfg-ai" />
          <span className="small muted">{aiOk ? '✓ IA pronta' : 'Sem chave: as matérias saem só como rascunho simples.'}</span>
        </section>

        <section className="tone-card">
          <strong>Site (painel WEBSG)</strong>
          <input className="input" placeholder="https://primeirasnoticias.com.br/websg/" value={site.base} onChange={(e) => setSite({ ...site, base: e.target.value.trim() })} />
          <input className="input" placeholder="Usuário" autoComplete="username" value={site.user} onChange={(e) => setSite({ ...site, user: e.target.value.trim() })} data-testid="cfg-site-user" />
          <input className="input" type="password" placeholder="Senha" autoComplete="current-password" value={site.pass} onChange={(e) => setSite({ ...site, pass: e.target.value })} data-testid="cfg-site-pass" />
          <button className="btn sm" disabled={!!busy} onClick={() => void test('site')} data-testid="cfg-site-test">
            {busy === 'site' ? 'Testando…' : 'Salvar e testar acesso'}
          </button>
          {msg.site && <span className="small">{msg.site}</span>}
        </section>

        <section className="tone-card">
          <strong>Instagram</strong>
          <input className="input" placeholder="ID da conta (1784...)" value={ig.userId} onChange={(e) => setIg({ ...ig, userId: e.target.value.trim() })} data-testid="cfg-ig-id" />
          <input className="input" type="password" placeholder="Token do Facebook (EAA...) — posta os Reels" value={ig.fbToken} onChange={(e) => setIg({ ...ig, fbToken: e.target.value.trim() })} />
          <input className="input" type="password" placeholder="Token do Instagram (IGAA...) — renova sozinho" value={ig.igToken} onChange={(e) => setIg({ ...ig, igToken: e.target.value.trim(), meta: {} })} />
          <label className="small muted">
            Convidar para collab em todo Reel (até 3, separados por vírgula)
            <input className="input" placeholder="@portalnewsjampa" value={ig.collab} onChange={(e) => setIg({ ...ig, collab: e.target.value })} data-testid="cfg-ig-collab" />
          </label>
          {igSt?.configurado && (
            <span className="small muted">
              Token do Instagram vale até {d(igSt.igVence)} (renova sozinho 10 dias antes) · acesso do token do Facebook até {d(igSt.fbAcessoVence)}
            </span>
          )}
          {igSt?.avisos.map((a, i) => (
            <span key={i} className="post-warn small">
              ⚠ {a}
            </span>
          ))}
          <button className="btn sm" disabled={!!busy} onClick={() => void test('ig')} data-testid="cfg-ig-test">
            {busy === 'ig' ? 'Conferindo…' : 'Salvar e conferir'}
          </button>
          {msg.ig && <span className="small">{msg.ig}</span>}
        </section>

        <button className="btn primary wide" onClick={() => void saveAll().then(onClose)} data-testid="cfg-save">
          Salvar
        </button>
      </div>
    </div>
  );
}
