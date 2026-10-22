/**
 * Inspector contextual. Os campos numéricos são secundários: a edição principal
 * acontece no canvas e na timeline. Aqui ficam ajustes finos e propriedades.
 */
import { useState, type ReactNode } from 'react';
import type { BlurClip, Clip, FrameClip, ImageClip, Project, ShapeClip, SponsorsClip, TextClip, VideoClip, VisualClip } from '../../core/model';
import { removeCrop } from '../../core/geometry';
import { FORMATS, isVisual } from '../../core/model';
import { getPreset } from '../../core/presets';
import { getFrame } from '../../core/frames';
import { BRAND_SWATCHES } from '../../core/brand';
import { clearKeyframes, effectiveTransform, patchClip, setTransformAt, toggleKeyframeAt } from '../../core/edit';
import { setSpeed, trimEnd } from '../../core/timeline';
import { getEditor, setAutoKey, useEditor } from '../../state/store';
import { deleteKeyframe, detachAudio, fitSelection, removeImageBackground, resetClip } from '../commands';
import { IconClose, IconKeyframe } from '../icons';

export function Inspector({ onClose }: { onClose: () => void }) {
  const project = useEditor((s) => s.project)!;
  const selection = useEditor((s) => s.selection);
  const time = useEditor((s) => s.time);
  const clips = project.clips.filter((c) => selection.includes(c.id));

  if (clips.length === 0) return <ProjectInspector project={project} />;
  if (clips.length > 1)
    return (
      <div className="insp">
        <InspHead title={`${clips.length} itens selecionados`} onClose={onClose} />
        <p className="hint">Arraste no vídeo ou na timeline para mover todos juntos. Delete remove.</p>
      </div>
    );
  const clip = clips[0]!;
  return (
    <div className="insp" key={clip.id}>
      <InspHead title={clip.type === 'text' ? getPreset(clip.preset).name : clip.name} onClose={onClose} onReset={() => resetClip(clip.id)} />
      {clip.type === 'text' && <TextSection clip={clip} />}
      {clip.type === 'frame' && <FrameSection clip={clip} />}
      {clip.type === 'video' && <VideoSection clip={clip} />}
      {clip.type === 'image' && <ImageSection clip={clip} />}
      {clip.type === 'blur' && (clip.mode === 'bw' ? <FilterSection clip={clip} /> : <BlurSection clip={clip} />)}
      {clip.type === 'sponsors' && <SponsorsSection clip={clip} />}
      {clip.type === 'shape' && <ShapeSection clip={clip} />}
      {(clip.type === 'video' || clip.type === 'audio') && <SpeedSection clip={clip} />}
      {(clip.type === 'video' || clip.type === 'audio') && <AudioSection clip={clip} />}
      {isVisual(clip) && clip.type !== 'frame' && <TransformSection clip={clip} time={time} />}
      <TimingSection clip={clip} />
    </div>
  );
}

function InspHead({ title, onClose, onReset }: { title: string; onClose: () => void; onReset?: () => void }) {
  return (
    <div className="insp-head">
      <h3 className="ellipsis">{title}</h3>
      <div className="row-gap">
        {onReset && (
          <button className="btn sm ghost" onClick={onReset} title="Voltar à configuração padrão do template" data-testid="reset-clip">
            Restaurar padrão
          </button>
        )}
        <button className="icon-btn show-sm" onClick={onClose} aria-label="Fechar ajustes">
          <IconClose />
        </button>
      </div>
    </div>
  );
}

function Section({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="insp-sec">
      <div className="insp-sec-head">
        <h4>{title}</h4>
        {right}
      </div>
      {children}
    </section>
  );
}

const apply = (fn: (p: Project) => Project, merge?: string) => getEditor().apply(fn, merge);
const patch = (id: string, v: Partial<Clip>, merge?: string) => apply((p) => patchClip(p, id, v), merge);

/** Campo numérico com arraste horizontal no rótulo (scrub), como em editores profissionais. */
function Num({
  label,
  value,
  onChange,
  step = 1,
  min,
  max,
  suffix,
  digits = 0,
  mergeKey,
}: {
  label: string;
  value: number;
  onChange: (v: number, merge: string) => void;
  step?: number;
  min?: number;
  max?: number;
  suffix?: string;
  digits?: number;
  mergeKey: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const clampV = (v: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));
  return (
    <label className="num">
      <span
        className="num-label"
        onPointerDown={(e) => {
          const x0 = e.clientX;
          const v0 = value;
          const el = e.currentTarget;
          el.setPointerCapture(e.pointerId);
          const move = (ev: PointerEvent) => onChange(clampV(Number((v0 + ((ev.clientX - x0) / 2) * step).toFixed(digits + 2))), mergeKey);
          const up = () => {
            el.removeEventListener('pointermove', move);
            el.removeEventListener('pointerup', up);
          };
          el.addEventListener('pointermove', move);
          el.addEventListener('pointerup', up);
        }}
      >
        {label}
      </span>
      <input
        className="input num-input"
        inputMode="decimal"
        value={draft ?? value.toFixed(digits)}
        onFocus={(e) => {
          setDraft(value.toFixed(digits));
          e.currentTarget.select();
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const v = Number(draft?.replace(',', '.'));
          if (draft !== null && Number.isFinite(v)) onChange(clampV(v), `${mergeKey}-typed`);
          setDraft(null);
        }}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
      {suffix && <span className="num-suffix">{suffix}</span>}
    </label>
  );
}

function Slider({ label, value, min, max, step, onChange, format }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; format?: (v: number) => string }) {
  return (
    <label className="slider">
      <span className="slider-label">{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="slider-val">{format ? format(value) : value.toFixed(step < 1 ? 2 : 0)}</span>
    </label>
  );
}

function Swatches({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <div className="swatches">
      {BRAND_SWATCHES.map((c) => (
        <button key={c} className={`swatch ${value.toLowerCase() === c.toLowerCase() ? 'on' : ''}`} style={{ background: c }} onClick={() => onChange(c)} aria-label={c} />
      ))}
      <input type="color" className="swatch-input" value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#000000'} onChange={(e) => onChange(e.target.value)} aria-label="Cor personalizada" />
    </div>
  );
}

function Seg<T extends string>({ value, options, onChange }: { value: T; options: { v: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button key={o.v} className={value === o.v ? 'on' : ''} onClick={() => onChange(o.v)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------

function FrameSection({ clip }: { clip: FrameClip }) {
  const def = getFrame(clip.frame);
  return (
    <Section title="Moldura">
      <p className="hint">{def.description} Cores seguem o padrão Primeiras Notícias. Para trocar, escolha outra moldura no painel Manchetes.</p>
      {def.ticker && (
        <label className="field">
          <span>Texto do letreiro</span>
          <textarea className="input" rows={2} value={clip.text} onChange={(e) => patch(clip.id, { text: e.target.value } as Partial<FrameClip>, `ft-${clip.id}`)} />
        </label>
      )}
    </Section>
  );
}

/** Opacidade do item no instante da agulha (marca d'água, selos, manchetes). */
function OpacitySlider({ clip }: { clip: VisualClip }) {
  const time = useEditor((s) => s.time);
  const tr = effectiveTransform(clip, time);
  return (
    <Slider
      label="Opacidade"
      value={tr.opacity}
      min={0.05}
      max={1}
      step={0.01}
      onChange={(v) => {
        const s = getEditor();
        apply((p) => setTransformAt(p, clip.id, s.time, { ...effectiveTransform(clip, s.time), opacity: v }, s.autoKey), `op-${clip.id}`);
      }}
      format={(v) => `${Math.round(v * 100)}%`}
    />
  );
}

function TextSection({ clip }: { clip: TextClip }) {
  const preset = getPreset(clip.preset);
  const setField = (k: keyof TextClip['fields'], v: string) => patch(clip.id, { fields: { ...clip.fields, [k]: v } } as Partial<TextClip>, `f-${clip.id}-${k}`);
  const setStyle = (v: Partial<TextClip['style']>, merge?: string) => patch(clip.id, { style: { ...clip.style, ...v } } as Partial<TextClip>, merge);
  if (preset.uses.length === 0) {
    return (
      <Section title="Selo">
        <p className="hint">{preset.description} Posicione e redimensione direto no vídeo.</p>
        <OpacitySlider clip={clip} />
      </Section>
    );
  }
  return (
    <>
      <Section title="Texto">
        {preset.uses.includes('kicker') && (
          <label className="field">
            <span>Chapéu / selo</span>
            <input className="input" value={clip.fields.kicker} onChange={(e) => setField('kicker', e.target.value)} />
          </label>
        )}
        <label className="field">
          <span>Manchete</span>
          <textarea className="input" rows={3} value={clip.fields.title} onChange={(e) => setField('title', e.target.value)} data-testid="insp-title" />
        </label>
        {preset.uses.includes('subtitle') && (
          <label className="field">
            <span>Linha de apoio</span>
            <input className="input" value={clip.fields.subtitle} onChange={(e) => setField('subtitle', e.target.value)} />
          </label>
        )}
        <p className="hint">Use *asteriscos* para destacar trechos na cor de destaque.</p>
      </Section>
      <Section title="Texto · formatação">
        <Slider label="Corpo" value={clip.style.fontScale} min={0.4} max={2} step={0.05} onChange={(v) => setStyle({ fontScale: v }, `fs-${clip.id}`)} format={(v) => `${Math.round(v * 100)}%`} />
        <OpacitySlider clip={clip} />
        <div className="row-gap">
          <Seg
            value={clip.style.align}
            options={[
              { v: 'left', label: 'Esq.' },
              { v: 'center', label: 'Centro' },
              { v: 'right', label: 'Dir.' },
            ]}
            onChange={(v) => setStyle({ align: v })}
          />
          <button className={`btn sm ${clip.style.uppercase ? 'primary' : ''}`} onClick={() => setStyle({ uppercase: !clip.style.uppercase })}>
            AA
          </button>
        </div>
      </Section>
    </>
  );
}

function VideoSection({ clip }: { clip: VideoClip }) {
  const adj = (k: keyof VideoClip['adjust'], v: number) => patch(clip.id, { adjust: { ...clip.adjust, [k]: v } } as Partial<VideoClip>, `adj-${clip.id}-${k}`);
  return (
    <>
      <Section title="Enquadramento">
        <div className="row-gap wrap">
          <button className="btn sm" onClick={() => fitSelection('contain')}>
            Encaixar
          </button>
          <button className="btn sm" onClick={() => fitSelection('cover')}>
            Preencher
          </button>
          <button className={`btn sm ${clip.flipH ? 'primary' : ''}`} onClick={() => patch(clip.id, { flipH: !clip.flipH } as Partial<VideoClip>)}>
            Espelhar
          </button>
        </div>
        <CropControls clip={clip} />
      </Section>
      <Section title="Ajustes de imagem">
        <Slider label="Brilho" value={clip.adjust.brightness} min={0.3} max={2} step={0.01} onChange={(v) => adj('brightness', v)} />
        <Slider label="Contraste" value={clip.adjust.contrast} min={0.3} max={2} step={0.01} onChange={(v) => adj('contrast', v)} />
        <Slider label="Saturação" value={clip.adjust.saturation} min={0} max={2} step={0.01} onChange={(v) => adj('saturation', v)} />
      </Section>
    </>
  );
}

function ImageSection({ clip }: { clip: ImageClip }) {
  const [busy, setBusy] = useState(false);
  return (
    <Section title="Enquadramento">
      <div className="row-gap wrap">
        <button className="btn sm" onClick={() => fitSelection('contain')}>
          Encaixar
        </button>
        <button className="btn sm" onClick={() => fitSelection('cover')}>
          Preencher
        </button>
        <button
          className="btn sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await removeImageBackground(clip.id);
            setBusy(false);
          }}
          title="Tira o fundo branco (ou de cor única) da imagem"
          data-testid="remove-bg"
        >
          {busy ? 'Removendo…' : 'Remover fundo'}
        </button>
      </div>
      <CropControls clip={clip} />
    </Section>
  );
}

/** Cortar as bordas arrastando as alças no vídeo (como o recortar do Windows). */
function CropControls({ clip }: { clip: VideoClip | ImageClip }) {
  const cropId = useEditor((s) => s.cropId);
  const on = cropId === clip.id;
  const c = clip.crop;
  const hasCrop = !!c && (c.l > 0 || c.t > 0 || c.r > 0 || c.b > 0);
  return (
    <div className="field">
      <span>Cortar bordas</span>
      <div className="row-gap wrap">
        <button className={`btn sm ${on ? 'primary' : ''}`} onClick={() => getEditor().set('cropId', on ? null : clip.id)} data-testid="crop-toggle">
          {on ? 'Concluir corte' : 'Cortar'}
        </button>
        {hasCrop && (
          <button
            className="btn sm ghost"
            onClick={() =>
              apply((p) => {
                const cur = p.clips.find((x) => x.id === clip.id);
                if (!cur || (cur.type !== 'video' && cur.type !== 'image') || !cur.crop) return p;
                const tr = removeCrop(cur.transform, cur.crop);
                return patchClip(p, clip.id, { transform: tr, crop: undefined } as Partial<Clip>);
              })
            }
          >
            Remover corte
          </button>
        )}
      </div>
      {on && <p className="hint">Arraste as alças das bordas (em cima, embaixo, esquerda e direita) no vídeo para cortar.</p>}
    </div>
  );
}

function AudioSection({ clip }: { clip: Extract<Clip, { type: 'video' | 'audio' }> }) {
  if (clip.type === 'video' && !clip.hasAudio) return null;
  return (
    <Section title="Áudio" right={clip.type === 'video' ? <button className="btn sm ghost" onClick={detachAudio}>Separar</button> : undefined}>
      <div className="row-gap">
        <button className={`btn sm ${clip.muted ? 'primary' : ''}`} onClick={() => patch(clip.id, { muted: !clip.muted } as Partial<Clip>)}>
          {clip.muted ? 'Sem som' : 'Silenciar'}
        </button>
      </div>
      <Slider label="Volume" value={clip.volume} min={0} max={2} step={0.01} onChange={(v) => patch(clip.id, { volume: v } as Partial<Clip>, `vol-${clip.id}`)} format={(v) => `${Math.round(v * 100)}%`} />
      <Slider label="Entrada" value={clip.fadeIn} min={0} max={5} step={0.1} onChange={(v) => patch(clip.id, { fadeIn: v } as Partial<Clip>, `fi-${clip.id}`)} format={(v) => `${v.toFixed(1)} s`} />
      <Slider label="Saída" value={clip.fadeOut} min={0} max={5} step={0.1} onChange={(v) => patch(clip.id, { fadeOut: v } as Partial<Clip>, `fo-${clip.id}`)} format={(v) => `${v.toFixed(1)} s`} />
      <div className="field">
        <span>Disfarçar voz</span>
        <Seg
          value={clip.voice ?? 'normal'}
          options={[
            { v: 'normal', label: 'Normal' },
            { v: 'high', label: 'Aguda' },
            { v: 'low', label: 'Grave' },
          ]}
          onChange={(v) => patch(clip.id, { voice: v } as Partial<Clip>)}
        />
      </div>
    </Section>
  );
}

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

/** Velocidade (como no CapCut): acelera ou desacelera o trecho; a duração na timeline acompanha. */
function SpeedSection({ clip }: { clip: Extract<Clip, { type: 'video' | 'audio' }> }) {
  return (
    <Section title="Velocidade">
      <div className="speed-chips">
        {SPEEDS.map((v) => (
          <button key={v} className={`btn sm ${Math.abs(clip.speed - v) < 0.001 ? 'primary' : ''}`} onClick={() => apply((p) => setSpeed(p, clip.id, v))} data-testid={`speed-${v}`}>
            {String(v).replace('.', ',')}×
          </button>
        ))}
      </div>
      <Slider
        label="Ajuste fino"
        value={clip.speed}
        min={0.25}
        max={4}
        step={0.05}
        onChange={(v) => apply((p) => setSpeed(p, clip.id, v), `spd-${clip.id}`)}
        format={(v) => `${v.toFixed(2).replace('.', ',')}×`}
      />
      <p className="hint">O áudio acompanha a velocidade sem mudar o tom da voz.</p>
    </Section>
  );
}

function BlurSection({ clip }: { clip: BlurClip }) {
  return (
    <Section title="Desfoque">
      <Seg
        value={clip.shape}
        options={[
          { v: 'rect', label: 'Retângulo' },
          { v: 'ellipse', label: 'Oval' },
        ]}
        onChange={(v) => patch(clip.id, { shape: v } as Partial<BlurClip>)}
      />
      <Seg
        value={clip.mode}
        options={[
          { v: 'blur', label: 'Desfocar' },
          { v: 'pixelate', label: 'Pixelizar' },
        ]}
        onChange={(v) => patch(clip.id, { mode: v } as Partial<BlurClip>)}
      />
      <Slider label="Intensidade do desfoque" value={clip.intensity} min={1} max={100} step={1} onChange={(v) => patch(clip.id, { intensity: v } as Partial<BlurClip>, `bi-${clip.id}`)} />
    </Section>
  );
}

/** Filtro (preto e branco) é outra coisa: só a intensidade do filtro, sem forma nem desfoque. */
function FilterSection({ clip }: { clip: BlurClip }) {
  return (
    <Section title="Filtro · Preto e branco">
      <Slider label="Intensidade do filtro" value={clip.intensity} min={0} max={100} step={1} onChange={(v) => patch(clip.id, { intensity: v } as Partial<BlurClip>, `fi-${clip.id}`)} format={(v) => `${Math.round(v)}%`} />
      <p className="hint">0% = cores normais · 100% = preto e branco total. Estique ou encolha o item na timeline para escolher o trecho.</p>
    </Section>
  );
}

function SponsorsSection({ clip }: { clip: SponsorsClip }) {
  const media = useEditor((s) => s.media);
  const images = Object.values(media).filter((m) => m.kind === 'image' && m.status === 'ready');
  const [pick, setPick] = useState('');
  return (
    <Section title="Oferecimento">
      <label className="field">
        <span>Rótulo</span>
        <input className="input" value={clip.label} onChange={(e) => patch(clip.id, { label: e.target.value } as Partial<SponsorsClip>, `sl-${clip.id}`)} />
      </label>
      <div className="list">
        {clip.mediaIds.map((id, i) => (
          <div key={`${id}-${i}`} className="list-row">
            <img src={media[id]?.url} alt="" className="list-thumb" />
            <span className="ellipsis">{media[id]?.name ?? 'ausente'}</span>
            <button className="mini-btn" onClick={() => patch(clip.id, { mediaIds: clip.mediaIds.filter((_, j) => j !== i) } as Partial<SponsorsClip>)} aria-label="Remover">
              ×
            </button>
          </div>
        ))}
      </div>
      <div className="row-gap">
        <select className="input" value={pick} onChange={(e) => setPick(e.target.value)}>
          <option value="">Escolher logo da biblioteca…</option>
          {images.map((m) => (
            <option key={m.id} value={m.id}>
              {m.brand ? `Marca · ${m.name}` : m.name}
            </option>
          ))}
        </select>
        <button className="btn sm" disabled={!pick} onClick={() => { patch(clip.id, { mediaIds: [...clip.mediaIds, pick] } as Partial<SponsorsClip>); setPick(''); }}>
          Adicionar
        </button>
      </div>
      <p className="hint">Importe as logos dos patrocinadores pelo painel Mídia (PNG de preferência).</p>
      <div className="field">
        <span>Cor do texto</span>
        <Swatches value={clip.textColor} onChange={(c) => patch(clip.id, { textColor: c } as Partial<SponsorsClip>)} />
      </div>
    </Section>
  );
}

function ShapeSection({ clip }: { clip: ShapeClip }) {
  return (
    <Section title="Forma">
      <div className="field">
        <span>Cor</span>
        <Swatches value={clip.fill} onChange={(c) => patch(clip.id, { fill: c } as Partial<ShapeClip>)} />
      </div>
      {clip.shape === 'rect' && (
        <Slider label="Cantos" value={clip.radius} min={0} max={200} step={1} onChange={(v) => patch(clip.id, { radius: v } as Partial<ShapeClip>, `r-${clip.id}`)} />
      )}
    </Section>
  );
}

/** Nó do Pan/Crop selecionado na timeline: editar (mexendo no item) ou excluir. */
function SelectedNode({ clip }: { clip: VisualClip }) {
  const kfSel = useEditor((s) => s.kfSel);
  if (!kfSel || kfSel.clipId !== clip.id) return null;
  return (
    <div className="kf-selected" data-testid="kf-selected">
      <span>
        ◆ Nó em <strong>{(clip.start + kfSel.t).toFixed(2)} s</strong> selecionado — mova, redimensione ou corte o item para editar este nó.
      </span>
      <button className="btn sm danger" onClick={() => deleteKeyframe(clip.id, kfSel.t)} data-testid="kf-delete">
        Excluir nó
      </button>
    </div>
  );
}

/** Event Pan/Crop (Vegas): liga a gravação automática de nós ao mexer no item. */
function PanCropToggle({ count }: { count: number }) {
  const autoKey = useEditor((s) => s.autoKey);
  return (
    <div className="pancrop-row">
      <button className={`btn sm pancrop-btn ${autoKey ? 'on' : ''}`} onClick={() => setAutoKey(!autoKey)} aria-pressed={autoKey} data-testid="insp-pancrop">
        ◆ Pan/Crop {autoKey ? 'ligado' : 'desligado'}
      </button>
      <p className="hint">
        {autoKey
          ? 'Ponha a agulha num ponto e mova, redimensione, gire ou corte o item: vira um nó ◆. Em outro ponto, ajuste de novo — o item se move entre os nós.'
          : 'Ligue para animar o item como no Event Pan/Crop do Vegas.'}
        {count > 0 ? ` · ${count} nó(s)` : ''}
      </p>
    </div>
  );
}

function TransformSection({ clip, time }: { clip: VisualClip; time: number }) {
  const tr = effectiveTransform(clip, time);
  const local = time - clip.start;
  const active = local >= 0 && local <= clip.duration;
  const onKf = clip.keyframes.some((k) => Math.abs(k.t - local) < 1 / 60);
  const set = (k: keyof typeof tr) => (v: number, merge: string) => apply((p) => setTransformAt(p, clip.id, time, { ...tr, [k]: v }, getEditor().autoKey), `${merge}-${clip.id}`);
  return (
    <Section
      title="Posição e tamanho"
      right={
        <div className="row-gap">
          <button
            className={`icon-btn sm ${onKf ? 'on' : ''}`}
            disabled={!active}
            onClick={() => apply((p) => toggleKeyframeAt(p, clip.id, time))}
            title={onKf ? 'Remover keyframe neste instante' : 'Adicionar keyframe neste instante'}
            aria-label="Keyframe"
          >
            <IconKeyframe />
          </button>
          {clip.keyframes.length > 0 && (
            <button className="btn sm ghost" onClick={() => apply((p) => clearKeyframes(p, clip.id, time))}>
              Limpar
            </button>
          )}
        </div>
      }
    >
      <PanCropToggle count={clip.keyframes.length} />
      <SelectedNode clip={clip} />
      <div className="num-grid">
        <Num label="X" value={tr.x} onChange={set('x')} mergeKey="x" />
        <Num label="Y" value={tr.y} onChange={set('y')} mergeKey="y" />
        <Num label="L" value={tr.width} onChange={set('width')} min={1} mergeKey="w" />
        <Num label="A" value={tr.height} onChange={set('height')} min={1} mergeKey="h" />
        <Num label="°" value={tr.rotation} onChange={set('rotation')} step={0.5} digits={1} mergeKey="r" />
        <Num label="%" value={tr.opacity * 100} onChange={(v, m) => set('opacity')(Math.min(100, Math.max(0, v)) / 100, m)} min={0} max={100} mergeKey="o" />
      </div>
    </Section>
  );
}


function TimingSection({ clip }: { clip: Clip }) {
  return (
    <Section title="Tempo">
      <div className="num-grid two">
        <Num label="Início" value={clip.start} step={0.05} digits={2} min={0} suffix="s" onChange={(v, m) => apply((p) => patchClip(p, clip.id, { start: Math.max(0, v) }), `${m}-${clip.id}`)} mergeKey="st" />
        <Num label="Dur." value={clip.duration} step={0.05} digits={2} min={0.1} suffix="s" onChange={(v, m) => apply((p) => trimEnd(p, clip.id, clip.start + v), `${m}-${clip.id}`)} mergeKey="du" />
      </div>
    </Section>
  );
}

function ProjectInspector({ project }: { project: Project }) {
  return (
    <div className="insp">
      <div className="insp-head">
        <h3>Projeto</h3>
      </div>
      <Section title="Formato">
        <Seg
          value={project.format}
          options={(Object.keys(FORMATS) as (keyof typeof FORMATS)[]).map((f) => ({ v: f, label: FORMATS[f].short }))}
          onChange={(f) =>
            apply((p) => {
              const fm = FORMATS[f];
              const sx = fm.width / p.width;
              const sy = fm.height / p.height;
              // reposiciona proporcionalmente; o usuário ajusta o enquadramento depois
              const s = Math.min(sx, sy);
              return {
                ...p,
                format: f,
                width: fm.width,
                height: fm.height,
                clips: p.clips.map((c) =>
                  isVisual(c)
                    ? ({
                        ...c,
                        transform: { ...c.transform, x: c.transform.x * sx, y: c.transform.y * sy, width: c.transform.width * s, height: c.transform.height * s },
                        keyframes: c.keyframes.map((k) => ({ ...k, x: k.x * sx, y: k.y * sy, width: k.width * s, height: k.height * s })),
                      } as Clip)
                    : c,
                ),
              };
            })
          }
        />
        <p className="muted small">
          {project.width}×{project.height} · {project.fps} fps
        </p>
      </Section>
      <Section title="Quadros por segundo">
        <Seg
          value={String(project.fps)}
          options={['24', '25', '30', '60'].map((v) => ({ v, label: v }))}
          onChange={(v) => apply((p) => ({ ...p, fps: Number(v) as Project['fps'] }))}
        />
      </Section>
      <Section title="Atalhos">
        <ul className="shortcuts">
          <li><kbd>Espaço</kbd> reproduzir</li>
          <li><kbd>S</kbd> dividir</li>
          <li><kbd>Del</kbd> excluir · <kbd>Shift</kbd>+<kbd>Del</kbd> fecha espaço</li>
          <li><kbd>Ctrl</kbd>+<kbd>Z</kbd> desfazer</li>
          <li><kbd>Ctrl</kbd>+<kbd>D</kbd> duplicar</li>
          <li><kbd>,</kbd> <kbd>.</kbd> quadro a quadro</li>
          <li><kbd>Ctrl</kbd>+roda zoom (timeline e item)</li>
          <li>Duplo clique no texto para editar</li>
        </ul>
      </Section>
    </div>
  );
}
