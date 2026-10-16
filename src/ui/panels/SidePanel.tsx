import { useEffect, useRef, useState } from 'react';
import type { AudioClip, MediaAsset, Project, TextClip, VideoClip } from '../../core/model';
import { HEADLINE_PRESETS, type PresetCategory } from '../../core/presets';
import { FRAMES, insertFrame, frameWindow, getFrame } from '../../core/frames';
import { createTextClip, createProject } from '../../core/factory';
import { drawHeadline } from '../../render/headlines';
import { ensureFonts } from '../../render/fonts';
import { ensureBrandAssets } from '../../render/brandAssets';
import { renderFrame } from '../../render/renderer';
import { IS_LOCAL, media as mediaApi } from '../../platform/api';
import { getEditor, useEditor, type Panel } from '../../state/store';
import { addMedia, addOutro, addText, applyFrameCmd } from '../commands';
import { BUILTIN, BUILTIN_URL, getFrameLogo, outroAuto, setFrameLogo, setOutroAuto, type FrameLogoKind } from '../frameLogos';
import { ACCEPT_ATTR, importFiles, onUploads, refreshBrand, type UploadProgress } from '../importer';
import { formatTime } from '../Transport';
import { confirmDialog } from '../dialogs';

/** arrastar para a timeline só com mouse; no toque, arrastar disparava inserção dupla */
const FINE_POINTER = typeof matchMedia === 'function' && matchMedia('(pointer: fine)').matches;
import { IconClose, IconTrash, IconUpload } from '../icons';

const TITLES: Record<Panel, string> = {
  media: 'Mídia',
  brand: 'Marca',
  text: 'Manchetes e molduras',
  blur: 'Desfoque',
  audio: 'Áudio',
};

export function SidePanel({ panel, onClose }: { panel: Panel; onClose: () => void }) {
  return (
    <aside className="side-panel" data-testid={`panel-${panel}`}>
      <div className="panel-head">
        <h3>{TITLES[panel]}</h3>
        <button className="icon-btn" onClick={onClose} aria-label="Fechar painel">
          <IconClose />
        </button>
      </div>
      <div className="panel-body">
        {panel === 'media' && <MediaPanel kinds={['video', 'image']} />}
        {panel === 'audio' && <MediaPanel kinds={['audio']} />}
        {panel === 'brand' && <BrandPanel />}
        {panel === 'text' && <TextPanel />}
        {panel === 'blur' && <BlurPanel />}
      </div>
    </aside>
  );
}

function useUploads() {
  const [list, setList] = useState<UploadProgress[]>([]);
  useEffect(() => {
    const off = onUploads(setList);
    return () => {
      off();
    };
  }, []);
  return list;
}

function MediaPanel({ kinds }: { kinds: MediaAsset['kind'][] }) {
  const all = useEditor((s) => s.media);
  const uploads = useUploads();
  const input = useRef<HTMLInputElement>(null);
  const list = Object.values(all)
    .filter((m) => !m.brand && kinds.includes(m.kind))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const remove = async (m: MediaAsset) => {
    const used = getEditor().project?.clips.some((c) => ('mediaId' in c && c.mediaId === m.id) || (c.type === 'sponsors' && c.mediaIds.includes(m.id)));
    const ok = await confirmDialog({
      title: 'Excluir arquivo?',
      message: used ? `"${m.name}" está em uso neste projeto. Os trechos que usam este arquivo ficarão vazios.` : `"${m.name}" será removido da biblioteca.`,
      confirmLabel: 'Excluir',
      danger: true,
    });
    if (!ok) return;
    await mediaApi.remove(m.id);
    getEditor().removeMedia(m.id);
  };

  return (
    <>
      <button className="btn wide" onClick={() => input.current?.click()} data-testid="import-btn">
        <IconUpload /> Importar {kinds.includes('audio') && kinds.length === 1 ? 'áudio' : 'vídeo ou imagem'}
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        accept={kinds.includes('audio') && kinds.length === 1 ? 'audio/*' : ACCEPT_ATTR}
        onChange={(e) => {
          if (e.target.files) void importFiles(e.target.files, false);
          e.target.value = '';
        }}
        data-testid="file-input"
      />
      <p className="hint">Toque em um item para inserir na agulha, ou arraste para a timeline.</p>
      {uploads.map((u) => (
        <div key={u.name} className="upload-row">
          <span className="ellipsis">{u.name}</span>
          <div className="bar">
            <div style={{ width: `${Math.round(u.progress * 100)}%` }} />
          </div>
        </div>
      ))}
      <div className={kinds.includes('audio') && kinds.length === 1 ? 'audio-list' : 'media-grid'}>
        {list.map((m) => (
          <div
            key={m.id}
            className={`media-item ${m.status}`}
            draggable={m.status === 'ready' && FINE_POINTER}
            onDragStart={(e) => {
              e.dataTransfer.setData('application/x-pn-media', m.id);
              e.dataTransfer.effectAllowed = 'copy';
            }}
            onClick={() => addMedia(m)}
            title={m.name}
            data-testid="media-item"
          >
            <div className="media-thumb">
              {m.kind === 'image' && <img src={m.url} alt="" loading="lazy" draggable={false} />}
              {m.kind === 'video' && m.thumbs && (
                <span
                  className="thumb-sprite"
                  style={{ backgroundImage: `url(${m.thumbs.url})`, backgroundSize: `${m.thumbs.count * 100}% 100%`, backgroundPosition: `${(Math.min(1, m.thumbs.count - 1) / Math.max(1, m.thumbs.count - 1)) * 100}% 0` }}
                />
              )}
              {m.kind === 'audio' && <span className="audio-glyph">♪</span>}
              {m.status === 'processing' && <span className="media-status">processando…</span>}
              {m.status === 'error' && <span className="media-status err" title={m.error}>erro</span>}
              {m.kind !== 'image' && m.status === 'ready' && <span className="media-dur">{formatTime(m.duration).slice(0, 5)}</span>}
            </div>
            <div className="media-name ellipsis">{m.name}</div>
            <button
              className="media-del"
              aria-label="Excluir"
              onClick={(e) => {
                e.stopPropagation();
                void remove(m);
              }}
            >
              <IconTrash />
            </button>
          </div>
        ))}
      </div>
      {list.length === 0 && uploads.length === 0 && <p className="muted small">Nenhum arquivo ainda.</p>}
    </>
  );
}

/** logos oficiais embutidas no app (não podem ser excluídas) */
const isBundledBrand = (m: MediaAsset) => m.id === 'brand:logo-horizontal' || m.id === 'brand:logo-normal';

/** Exclui uma imagem enviada na Marca (some também das logos da moldura/encerramento). */
async function removeBrandAsset(m: MediaAsset): Promise<boolean> {
  const used = getEditor().project?.clips.some((c) => ('mediaId' in c && c.mediaId === m.id) || (c.type === 'sponsors' && c.mediaIds.includes(m.id)));
  const ok = await confirmDialog({
    title: 'Excluir imagem?',
    message: used ? `"${m.name}" está em uso neste projeto. Os itens que usam esta imagem ficarão vazios.` : `"${m.name}" será removida das suas imagens.`,
    confirmLabel: 'Excluir',
    danger: true,
  });
  if (!ok) return false;
  try {
    await mediaApi.removeBrand(m.id);
  } catch (e) {
    getEditor().notify((e as Error).message, 'error');
    return false;
  }
  for (const kind of ['horizontal', 'round', 'outro'] as const) {
    if (getFrameLogo(kind) === m.id) setFrameLogo(kind, BUILTIN, getEditor().media);
  }
  getEditor().removeMedia(m.id);
  return true;
}

function BrandPanel() {
  const all = useEditor((s) => s.media);
  const input = useRef<HTMLInputElement>(null);
  const list = Object.values(all).filter((m) => m.brand);
  return (
    <>
      <p className="hint">
        Logos e selos da redação. As logos oficiais já vêm no app; envie outras imagens (PNG ou JPG) por aqui
        {IS_LOCAL ? '' : <> ou coloque na pasta <code>brand/</code> do projeto</>}. Ao inserir, a logo vai para o canto superior — arraste e redimensione sobre a marca d'água que precisa cobrir.
      </p>
      <div className="row-gap">
        <button className="btn" onClick={() => input.current?.click()}>
          <IconUpload /> Enviar imagem
        </button>
        {!IS_LOCAL && (
          <button className="btn ghost" onClick={() => void refreshBrand()}>
            Atualizar lista
          </button>
        )}
      </div>
      <input
        ref={input}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={async (e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          for (const f of files) {
            try {
              await mediaApi.uploadBrand(f);
            } catch (err) {
              getEditor().notify((err as Error).message, 'error');
            }
          }
          await refreshBrand();
        }}
      />
      <div className="media-grid brand-grid">
        {list.map((m) => (
          <div
            key={m.id}
            className="media-item ready"
            onClick={() => addMedia(m)}
            draggable={FINE_POINTER}
            onDragStart={(e) => e.dataTransfer.setData('application/x-pn-media', m.id)}
            title={m.name}
          >
            <div className="media-thumb checker">
              <img src={m.url} alt="" draggable={false} />
            </div>
            <div className="media-name ellipsis">{m.name}</div>
            {!isBundledBrand(m) && (
              <button
                className="media-del"
                aria-label="Excluir"
                title="Excluir imagem"
                onClick={(e) => {
                  e.stopPropagation();
                  void removeBrandAsset(m);
                }}
                data-testid="brand-del"
              >
                <IconTrash />
              </button>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

const CATS: { id: PresetCategory; label: string }[] = [
  { id: 'manchete', label: 'Manchetes' },
  { id: 'tarja', label: 'Tarjas e GC' },
  { id: 'selo', label: 'Selos' },
  { id: 'texto', label: 'Texto' },
];

function TextPanel() {
  const format = useEditor((s) => s.project?.format ?? 'reel');
  const clips = useEditor((s) => s.project?.clips);
  const time = useEditor((s) => s.time);
  // moldura sob a agulha (pode haver várias na timeline)
  const current = clips?.find((c) => c.type === 'frame' && time >= c.start && time < c.start + c.duration);
  const currentFrame = current?.type === 'frame' ? current.frame : null;
  return (
    <>
      <p className="hint">Escolha a moldura e a manchete — as duas se encaixam. Cada escolha vira um item na timeline, inserido na agulha (pode colocar várias molduras).</p>
      <section className="preset-section">
        <h4>Molduras</h4>
        <div className="frame-grid">
          {FRAMES.map((f) => (
            <button
              key={f.id}
              className={`frame-card ${currentFrame === f.id ? 'on' : ''}`}
              onClick={() => applyFrameCmd(f.id)}
              title={f.description}
              data-testid={`frame-${f.id}`}
            >
              <FrameThumb frameId={f.id} format={format} />
              <span>{f.name}</span>
            </button>
          ))}
        </div>
        <FrameLogos />
      </section>
      <section className="preset-section">
        <h4>Encerramento</h4>
        <OutroSettings />
      </section>
      {CATS.map((cat) => (
        <section key={cat.id} className="preset-section">
          <h4>{cat.label}</h4>
          <div className="preset-grid">
            {HEADLINE_PRESETS.filter((p) => p.category === cat.id).map((p) => (
              <button key={p.id} className="preset-card" onClick={() => addText(p.id)} title={p.description} data-testid={`preset-${p.id}`}>
                <PresetThumb presetId={p.id} />
                <span>{p.name}</span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </>
  );
}

/** Miniatura viva do preset, desenhada pelo mesmo código do vídeo final. */
function PresetThumb({ presetId }: { presetId: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let alive = true;
    void Promise.all([ensureFonts(), ensureBrandAssets()]).then(() => {
      const c = ref.current;
      if (!alive || !c) return;
      const p = createProject('thumb', 'reel');
      const clip: TextClip = createTextClip(p, presetId, 0);
      const W = 280;
      const H = 120;
      const dpr = window.devicePixelRatio || 1;
      c.width = W * dpr;
      c.height = H * dpr;
      const ctx = c.getContext('2d')!;
      const g = ctx.createLinearGradient(0, 0, W * dpr, H * dpr);
      g.addColorStop(0, '#3b4652');
      g.addColorStop(1, '#1f262e');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, c.width, c.height);
      const tw = clip.transform.width;
      const th = clip.transform.height;
      const s = Math.min((W * 0.92) / tw, (H * 0.8) / th) * dpr;
      ctx.translate((c.width - tw * s) / 2, (c.height - th * s) / 2);
      ctx.scale(s, s);
      drawHeadline(ctx, clip, { w: tw, h: th, p: 1, t: 1.2 });
    });
    return () => {
      alive = false;
    };
  }, [presetId]);
  return <canvas ref={ref} className="preset-thumb" />;
}

/** Miniatura da moldura no formato do projeto; a janela do vídeo aparece em cinza. */
function FrameThumb({ frameId, format }: { frameId: string; format: Project['format'] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let alive = true;
    void Promise.all([ensureFonts(), ensureBrandAssets()]).then(() => {
      const c = ref.current;
      if (!alive || !c) return;
      let p = createProject('thumb', format);
      p = { ...insertFrame({ ...p, background: '#56606c' }, frameId, 0).project };
      const dpr = window.devicePixelRatio || 1;
      const cssW = format === 'wide' ? 150 : 84;
      c.width = Math.round(cssW * dpr);
      c.height = Math.round((c.width / p.width) * p.height);
      c.style.width = `${cssW}px`;
      const ctx = c.getContext('2d')!;
      renderFrame(ctx, p, 1, { video: () => null, image: () => null, size: () => null }, { editorHints: false });
      // marca a janela do vídeo
      const win = frameWindow(getFrame(frameId), p.width, p.height);
      const k = c.width / p.width;
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.font = `${Math.round(11 * dpr)}px "IBM Plex Sans", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('vídeo', (win.x + win.w / 2) * k, (win.y + win.h / 2) * k);
    });
    return () => {
      alive = false;
    };
  }, [frameId, format]);
  return <canvas ref={ref} className="frame-thumb" />;
}

function BlurPanel() {
  const tool = useEditor((s) => s.tool);
  // seleciona a referência estável e filtra no render (seletores do zustand não podem criar arrays novos)
  const clips = useEditor((s) => s.project?.clips);
  const blurs = (clips ?? []).filter((c) => c.type === 'blur');
  const set = (t: 'blur-rect' | 'blur-ellipse') => getEditor().set('tool', tool === t ? 'select' : t);
  return (
    <>
      <p className="hint">Escolha a forma e desenhe direto sobre o vídeo. Depois arraste para mover e puxe as alças para ajustar. Para seguir algo em movimento, ative keyframes no ajuste do item.</p>
      <div className="row-gap">
        <button className={`btn ${tool === 'blur-rect' ? 'primary' : ''}`} onClick={() => set('blur-rect')} data-testid="blur-rect">
          ▭ Retângulo
        </button>
        <button className={`btn ${tool === 'blur-ellipse' ? 'primary' : ''}`} onClick={() => set('blur-ellipse')} data-testid="blur-ellipse">
          ◯ Oval
        </button>
      </div>
      {blurs.length > 0 && (
        <div className="list">
          {blurs.map((b) => (
            <button key={b.id} className="list-row" onClick={() => getEditor().select([b.id])}>
              {b.name} · {formatTime(b.start).slice(0, 5)}–{formatTime(b.start + b.duration).slice(0, 5)}
            </button>
          ))}
        </div>
      )}
      <VoiceDisguise />
    </>
  );
}

type Voice = 'normal' | 'high' | 'low';
const VOICES: { v: Voice; label: string }[] = [
  { v: 'normal', label: 'Normal' },
  { v: 'high', label: 'Aguda' },
  { v: 'low', label: 'Grave' },
];

/** Disfarça a voz dos vídeos/áudios selecionados (fonte que não pode ser identificada). */
function VoiceDisguise() {
  const clips = useEditor((s) => s.project?.clips);
  const selection = useEditor((s) => s.selection);
  const targets = (clips ?? []).filter((c): c is VideoClip | AudioClip => (c.type === 'video' || c.type === 'audio') && selection.includes(c.id));
  const current = targets.length ? (targets.every((c) => (c.voice ?? 'normal') === (targets[0]!.voice ?? 'normal')) ? (targets[0]!.voice ?? 'normal') : null) : null;
  const setVoice = (v: Voice) => {
    const ids = new Set(targets.map((c) => c.id));
    getEditor().apply((p) => ({
      ...p,
      clips: p.clips.map((c) => (ids.has(c.id) && (c.type === 'video' || c.type === 'audio') ? { ...c, voice: v } : c)),
    }));
  };
  return (
    <div className="voice-disguise" data-testid="voice-disguise">
      <h4>Disfarçar voz</h4>
      <p className="hint">
        {targets.length
          ? 'Muda o tom da voz para a pessoa não ser reconhecida. Vale na prévia e no vídeo exportado.'
          : 'Selecione na timeline o vídeo ou áudio com a voz que deseja disfarçar.'}
      </p>
      <div className="row-gap">
        {VOICES.map(({ v, label }) => (
          <button
            key={v}
            className={`btn ${current === v ? 'primary' : ''}`}
            disabled={!targets.length}
            onClick={() => setVoice(v)}
            data-testid={`voice-${v}`}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}


/**
 * Logos da moldura: enviar imagens e marcar qual é a padrão (horizontal para o
 * cabeçalho, redonda para a marca grande que passa no fundo). Troca na hora.
 */
const FRAME_ROWS: { kind: FrameLogoKind; label: string }[] = [
  { kind: 'horizontal', label: 'Logo horizontal (cabeçalho)' },
  { kind: 'round', label: 'Logo redonda (marca no fundo)' },
];
const OUTRO_ROWS: { kind: FrameLogoKind; label: string }[] = [{ kind: 'outro', label: 'Logo do encerramento' }];

/** Encerramento estilo TikTok: entra sozinho no fim de toda exportação. */
function OutroSettings() {
  const [auto, setAuto] = useState(outroAuto);
  return (
    <div className="outro-settings">
      <div className="template-card outro-card">
        <PresetThumb presetId="pn-encerramento" />
        <span>
          <strong>Fim do vídeo · @primeirasnoticias_</strong>
          <span className="muted small">Tela final estilo TikTok com a logo, o perfil e o som. Entra sozinha no fim de todo vídeo exportado — não precisa colocar na timeline.</span>
        </span>
      </div>
      <label className="check-row">
        <input
          type="checkbox"
          checked={auto}
          onChange={(e) => {
            setAuto(e.target.checked);
            setOutroAuto(e.target.checked);
          }}
          data-testid="outro-auto"
        />
        Colocar automaticamente ao exportar
      </label>
      <FrameLogos rows={OUTRO_ROWS} title="Logo do encerramento" testId="outro-logos" />
      <button className="btn sm ghost" onClick={() => void addOutro()} data-testid="add-outro" title="Coloca o encerramento na timeline para ver como fica antes de exportar">
        Ver na timeline
      </button>
    </div>
  );
}

function FrameLogos({ rows = FRAME_ROWS, title = 'Logos da moldura', testId = 'frame-logos' }: { rows?: { kind: FrameLogoKind; label: string }[]; title?: string; testId?: string }) {
  const all = useEditor((s) => s.media);
  const brand = Object.values(all).filter((m) => m.brand && m.kind === 'image' && m.status === 'ready');
  const [sel, setSel] = useState<Record<FrameLogoKind, string>>(() => ({ horizontal: getFrameLogo('horizontal'), round: getFrameLogo('round'), outro: getFrameLogo('outro') }));
  const input = useRef<HTMLInputElement>(null);
  const choose = (kind: FrameLogoKind, id: string) => {
    setFrameLogo(kind, id, getEditor().media);
    setSel((s) => ({ ...s, [kind]: id }));
  };
  return (
    <div className="frame-logos" data-testid={testId}>
      <div className="row-between">
        <h5>{title}</h5>
        <button className="btn sm" onClick={() => input.current?.click()} data-testid={`${testId}-upload`}>
          <IconUpload /> Enviar
        </button>
      </div>
      <input
        ref={input}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={async (e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          for (const f of files) {
            try {
              await mediaApi.uploadBrand(f);
            } catch (err) {
              getEditor().notify((err as Error).message, 'error');
            }
          }
          await refreshBrand();
        }}
      />
      {rows.map(({ kind, label }) => (
        <div key={kind} className="logo-row">
          <span className="muted small">{label}</span>
          <div className="logo-opts">
            {[{ id: BUILTIN, url: BUILTIN_URL[kind], name: 'Padrão PN', asset: null as MediaAsset | null }, ...brand.map((b) => ({ id: b.id, url: b.url, name: b.name, asset: b as MediaAsset | null }))].map((o) => (
              <button
                key={o.id}
                className={`logo-opt ${sel[kind] === o.id ? 'on' : ''}`}
                onClick={() => choose(kind, o.id)}
                title={o.name}
                data-testid={`frame-logo-${kind}-${o.id === BUILTIN ? 'builtin' : 'custom'}`}
              >
                <img src={o.url} alt="" />
                {sel[kind] === o.id && <span className="logo-flag">Padrão</span>}
                {o.asset && !isBundledBrand(o.asset) && (
                  <span
                    role="button"
                    tabIndex={0}
                    className="media-del logo-del"
                    aria-label="Excluir imagem"
                    title="Excluir imagem"
                    onClick={async (e) => {
                      e.stopPropagation();
                      if (await removeBrandAsset(o.asset!)) setSel({ horizontal: getFrameLogo('horizontal'), round: getFrameLogo('round'), outro: getFrameLogo('outro') });
                    }}
                    data-testid="logo-del"
                  >
                    <IconTrash />
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
