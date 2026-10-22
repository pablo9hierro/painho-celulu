/**
 * Palco de edição: canvas com o quadro renderizado + camada de interação.
 * Toda edição visual acontece aqui por manipulação direta: arrastar, alças,
 * rotação, pinça com dois dedos, Ctrl+roda/trackpad e desenho de máscaras.
 */
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import type { Project, Transform, VisualClip } from '../../core/model';
import { isVisual } from '../../core/model';
import { evaluateScene } from '../../core/scene';
import {
  HANDLES,
  hitTest,
  pointerAngle,
  rectFromPoints,
  dragCrop,
  fullMediaRect,
  rotate,
  NO_CROP,
  type CropEdge,
  type CropValue,
  resizeTransform,
  rotationFromPointer,
  snapPosition,
  type Guide,
  type Handle,
} from '../../core/geometry';
import { effectiveCrop, effectiveTransform, patchClip, setCropAt, setTransformAt } from '../../core/edit';
import { renderFrame } from '../../render/renderer';
import { preview } from '../../engine/preview';
import { syncCaptionBox } from '../captions';
import { getEditor, useEditor } from '../../state/store';
import { addBlur, deleteSelection, togglePlay } from '../commands';
import { FRAME_LOGO_DEFAULT, frameLogoRect, type FrameLogoState } from '../../core/frames';
import { IconTrash } from '../icons';
import { getPreset } from '../../core/presets';
import { ensureBrandAssets, LOGO_RATIO, onBrandLoaded } from '../../render/brandAssets';
import { onStampChange } from '../../render/stampSettings';
import { TextEditOverlay } from './TextEditOverlay';

let liveCanvas: HTMLCanvasElement | null = null;

/** Miniatura JPEG do quadro atual (para a lista de projetos). */
export function captureThumb(): string | null {
  if (!liveCanvas || liveCanvas.width === 0) return null;
  const w = 180;
  const h = Math.round((liveCanvas.height / liveCanvas.width) * w);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d')!.drawImage(liveCanvas, 0, 0, w, h);
  try {
    return c.toDataURL('image/jpeg', 0.72);
  } catch {
    return null;
  }
}

type Gesture =
  | { kind: 'move'; start: { x: number; y: number }; bases: Map<string, Transform>; primary: string; moved: boolean }
  | { kind: 'resize'; id: string; handle: Handle; start: { x: number; y: number }; base: Transform }
  | { kind: 'rotate'; id: string; base: Transform; startAngle: number }
  | { kind: 'crop'; id: string; edge: CropEdge; start: { x: number; y: number }; base: Transform; crop: CropValue }
  | { kind: 'logo'; id: string; start: { x: number; y: number }; base: FrameLogoState; moved: boolean }
  | { kind: 'pinch'; id: string; base: Transform; d0: number; a0: number; m0: { x: number; y: number } }
  | { kind: 'draw'; start: { x: number; y: number }; cur: { x: number; y: number } };

const MEDIA_TYPES = new Set(['video', 'image']);

export function Stage() {
  const project = useEditor((s) => s.project)!;
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const needsRender = useRef(true);
  const previewFull = useEditor((s) => s.previewFull);

  // --- dimensionamento: encaixa o quadro no espaço disponível
  useLayoutEffect(() => {
    const el = wrapRef.current!;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      const pad = 12;
      const s = Math.max(0.01, Math.min((r.width - pad * 2) / project.width, (r.height - pad * 2) / project.height));
      setBox({ w: Math.floor(project.width * s), h: Math.floor(project.height * s) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [project.width, project.height]);

  // --- resolução interna do canvas (respeita devicePixelRatio, limitada ao tamanho do projeto)
  useEffect(() => {
    const c = canvasRef.current;
    if (!c || box.w === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.min(project.width, Math.round(box.w * dpr));
    c.width = w;
    c.height = Math.round((w / project.width) * project.height);
    liveCanvas = c;
    needsRender.current = true;
  }, [box.w, box.h, project.width, project.height]);

  // --- laço de renderização: só desenha quando algo mudou
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const s = getEditor();
      if (!needsRender.current && !s.playing) return;
      needsRender.current = false;
      const c = canvasRef.current;
      if (!c || !s.project || c.width === 0) return;
      const ctx = c.getContext('2d', { alpha: false })!;
      renderFrame(ctx, s.project, s.time, preview.sources, { editorHints: true });
    };
    raf = requestAnimationFrame(loop);
    const unsubStore = useEditor.subscribe((s, p) => {
      if (s.project !== p.project || s.time !== p.time || s.media !== p.media) needsRender.current = true;
    });
    const unsubPreview = preview.onInvalidate(() => (needsRender.current = true));
    const unsubBrand = onBrandLoaded(() => (needsRender.current = true));
    const unsubStamp = onStampChange(() => (needsRender.current = true));
    void ensureBrandAssets();
    void document.fonts.ready.then(() => (needsRender.current = true));
    return () => {
      cancelAnimationFrame(raf);
      unsubStore();
      unsubPreview();
      unsubBrand();
      unsubStamp();
      if (liveCanvas === canvasRef.current) liveCanvas = null;
    };
  }, []);

  const scale = box.w / project.width;

  return (
    <div className="stage-wrap" ref={wrapRef}>
      <div className="stage" style={{ width: box.w, height: box.h }} data-testid="stage">
        <canvas ref={canvasRef} className="stage-canvas" style={{ width: box.w, height: box.h }} />
        {box.w > 0 &&
          (previewFull ? (
            // na prévia em tela cheia não há controles de edição: tocar pausa/reproduz
            <div className="stage-overlay" onClick={togglePlay} data-tip="Toque para reproduzir ou pausar" />
          ) : (
            <Interaction project={project} scale={scale} />
          ))}
      </div>
    </div>
  );
}

function Interaction({ project, scale }: { project: Project; scale: number }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const time = useEditor((s) => s.time);
  const selection = useEditor((s) => s.selection);
  const tool = useEditor((s) => s.tool);
  const safeZones = useEditor((s) => s.safeZones);
  const editingTextId = useEditor((s) => s.editingTextId);
  const cropId = useEditor((s) => s.cropId);
  useEffect(() => {
    if (cropId && !selection.includes(cropId)) getEditor().set('cropId', null);
  }, [cropId, selection]);
  const [guides, setGuides] = useState<Guide[]>([]);
  const [drawRect, setDrawRect] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const lastTap = useRef<{ id: string; at: number } | null>(null);

  const toFrame = (clientX: number, clientY: number) => {
    const r = rootRef.current!.getBoundingClientRect();
    return { x: (clientX - r.left) / scale, y: (clientY - r.top) / scale };
  };

  const lockedTracks = new Set(project.tracks.filter((t) => t.locked).map((t) => t.id));
  // a moldura cobre o quadro todo: não participa da seleção no canvas (é selecionada pela timeline)
  const scene = evaluateScene(project, time);
  const items = scene.filter((it) => !lockedTracks.has(it.clip.trackId) && it.clip.type !== 'frame');
  const frameLogoId = useEditor((s) => s.frameLogoId);
  const autoKey = useEditor((s) => s.autoKey);

  /** logo do cabeçalho da moldura sob o ponto (clicável no preview, sem item na timeline) */
  const frameLogoAt = (pt: { x: number; y: number }) => {
    for (let i = scene.length - 1; i >= 0; i--) {
      const c = scene[i]!.clip;
      if (c.type !== 'frame' || lockedTracks.has(c.trackId)) continue;
      const r = frameLogoRect(c, project.width, project.height, LOGO_RATIO.horizontal);
      if (r && pt.x >= r.x && pt.x <= r.x + r.w && pt.y >= r.y && pt.y <= r.y + r.h) return { clip: c, index: i, rect: r };
    }
    return null;
  };

  const hitAt = (pt: { x: number; y: number }): VisualClip | null => {
    const pad = 4 / scale;
    const sel = items.find((it) => selection.includes(it.clip.id) && hitTest(it.transform, pt.x, pt.y, pad));
    if (sel) return sel.clip;
    for (let i = items.length - 1; i >= 0; i--) {
      if (hitTest(items[i]!.transform, pt.x, pt.y, pad)) return items[i]!.clip;
    }
    return null;
  };

  const startPinch = () => {
    const s = getEditor();
    const id = s.selection[0];
    const clip = id ? s.project?.clips.find((c) => c.id === id) : undefined;
    if (!clip || !isVisual(clip) || pointers.current.size < 2) return;
    const [a, b] = [...pointers.current.values()];
    const base = s.gestureBase ?? s.project!;
    const baseClip = base.clips.find((c) => c.id === id);
    if (!baseClip || !isVisual(baseClip)) return;
    if (!s.gestureBase) s.beginGesture();
    gesture.current = {
      kind: 'pinch',
      id,
      base: effectiveTransform(baseClip, s.time),
      d0: Math.hypot(b!.x - a!.x, b!.y - a!.y) || 1,
      a0: Math.atan2(b!.y - a!.y, b!.x - a!.x),
      m0: { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 },
    };
    setGuides([]);
  };

  const onPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const pt = toFrame(e.clientX, e.clientY);
    pointers.current.set(e.pointerId, pt);
    rootRef.current!.setPointerCapture(e.pointerId);
    const s = getEditor();
    if (s.editingTextId) s.set('editingTextId', null);

    if (pointers.current.size === 2) {
      startPinch();
      return;
    }
    if (pointers.current.size > 2) return;

    if (s.tool !== 'select') {
      gesture.current = { kind: 'draw', start: pt, cur: pt };
      setDrawRect({ x: pt.x, y: pt.y, width: 0, height: 0 });
      return;
    }

    const hit = hitAt(pt);
    // logo da moldura: vence se nenhum item acima dela foi tocado
    const lg = frameLogoAt(pt);
    if (lg && (!hit || scene.findIndex((it) => it.clip.id === hit.id) < lg.index)) {
      s.select([lg.clip.id]);
      s.set('frameLogoId', lg.clip.id);
      s.beginGesture();
      gesture.current = { kind: 'logo', id: lg.clip.id, start: pt, base: lg.clip.logo ?? FRAME_LOGO_DEFAULT, moved: false };
      return;
    }
    if (!hit) {
      s.select([]);
      gesture.current = null;
      return;
    }
    // toque duplo / duplo clique em texto → edição inline
    const now = performance.now();
    if (hit.type === 'text' && getPreset(hit.preset).uses.length > 0 && lastTap.current?.id === hit.id && now - lastTap.current.at < 350) {
      s.select([hit.id]);
      s.set('editingTextId', hit.id);
      lastTap.current = null;
      gesture.current = null;
      return;
    }
    lastTap.current = { id: hit.id, at: now };

    let sel = s.selection;
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      s.select([hit.id], true);
      sel = getEditor().selection;
      if (!sel.includes(hit.id)) return;
    } else if (!sel.includes(hit.id)) {
      s.select([hit.id]);
      sel = [hit.id];
    }
    s.beginGesture();
    const bases = new Map<string, Transform>();
    for (const id of sel) {
      const c = s.project!.clips.find((x) => x.id === id);
      if (c && isVisual(c) && !lockedTracks.has(c.trackId)) bases.set(id, effectiveTransform(c, s.time));
    }
    gesture.current = { kind: 'move', start: pt, bases, primary: hit.id, moved: false };
  };

  const onPointerMove = (e: RPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    const pt = toFrame(e.clientX, e.clientY);
    pointers.current.set(e.pointerId, pt);
    const g = gesture.current;
    if (!g) return;
    const s = getEditor();
    const snapping = s.snapping && !e.altKey;

    if (g.kind === 'draw') {
      g.cur = pt;
      setDrawRect(rectFromPoints(g.start.x, g.start.y, pt.x, pt.y));
      return;
    }
    if (g.kind === 'pinch') {
      const [a, b] = [...pointers.current.values()];
      if (!a || !b) return;
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const k = Math.max(0.05, d / g.d0);
      const tr: Transform = {
        ...g.base,
        width: Math.max(8, g.base.width * k),
        height: Math.max(8, g.base.height * k),
        rotation: g.base.rotation + ((ang - g.a0) * 180) / Math.PI,
        x: g.base.x + (m.x - g.m0.x),
        y: g.base.y + (m.y - g.m0.y),
      };
      s.updateGesture((base) => syncCaptionBox(setTransformAt(base, g.id, s.time, tr, s.autoKey), g.id));
      return;
    }
    if (g.kind === 'move') {
      const dx = pt.x - g.start.x;
      const dy = pt.y - g.start.y;
      if (!g.moved && Math.hypot(dx, dy) * scale < 3) return;
      g.moved = true;
      let ox = dx;
      let oy = dy;
      const prim = g.bases.get(g.primary);
      if (prim && snapping) {
        const others = items.filter((it) => !g.bases.has(it.clip.id)).map((it) => it.transform);
        const moved = { ...prim, x: prim.x + dx, y: prim.y + dy };
        const sn = snapPosition(moved, project, others, 7 / scale);
        ox = sn.x - prim.x;
        oy = sn.y - prim.y;
        setGuides(sn.guides);
      } else setGuides([]);
      s.updateGesture((base) => {
        let p = base;
        for (const [id, tr] of g.bases) p = setTransformAt(p, id, s.time, { ...tr, x: tr.x + ox, y: tr.y + oy }, s.autoKey);
        return g.bases.size === 1 ? syncCaptionBox(p, g.primary) : p;
      });
      return;
    }
    if (g.kind === 'resize') {
      const clip = s.project!.clips.find((c) => c.id === g.id);
      const isCorner = g.handle.length === 2;
      const prefersAspect = !!clip && (MEDIA_TYPES.has(clip.type) || clip.type === 'text');
      const keepAspect = isCorner && (prefersAspect ? !e.shiftKey : e.shiftKey);
      const tr = resizeTransform(g.base, g.handle, pt.x - g.start.x, pt.y - g.start.y, { keepAspect, fromCenter: e.altKey, minSize: 10 });
      s.updateGesture((base) => syncCaptionBox(setTransformAt(base, g.id, s.time, tr, s.autoKey), g.id));
      return;
    }
    if (g.kind === 'rotate') {
      const rot = rotationFromPointer(g.base, pt.x, pt.y, g.startAngle, g.base.rotation, snapping);
      s.updateGesture((base) => setTransformAt(base, g.id, s.time, { ...g.base, rotation: rot }, s.autoKey));
    }
    if (g.kind === 'logo') {
      const dx = pt.x - g.start.x;
      const dy = pt.y - g.start.y;
      if (!g.moved && Math.hypot(dx, dy) * scale < 3) return;
      g.moved = true;
      s.updateGesture((base) => patchClip(base, g.id, { logo: { ...g.base, dx: g.base.dx + dx, dy: g.base.dy + dy } } as Partial<VisualClip>));
      return;
    }
    if (g.kind === 'crop') {
      // deslocamento do ponteiro no eixo local do item
      const d = rotate(pt.x - g.start.x, pt.y - g.start.y, -g.base.rotation);
      const r = dragCrop(g.base, g.crop, g.edge, g.edge === 'l' || g.edge === 'r' ? d.x : d.y);
      s.updateGesture((base) => setCropAt(base, g.id, s.time, r.transform, r.crop, s.autoKey));
    }
  };

  const finish = (e: RPointerEvent<HTMLDivElement>, cancelled = false) => {
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    const s = getEditor();
    if (g?.kind === 'pinch') {
      if (pointers.current.size === 0) {
        s.endGesture();
        gesture.current = null;
      } else {
        // continua como arraste com o dedo restante
        gesture.current = null;
      }
      return;
    }
    if (pointers.current.size > 0) return;
    if (g?.kind === 'draw') {
      setDrawRect(null);
      const r = rectFromPoints(g.start.x, g.start.y, g.cur.x, g.cur.y);
      if (!cancelled && r.width * scale > 8 && r.height * scale > 8) addBlur(r, s.tool === 'blur-ellipse' ? 'ellipse' : 'rect');
    } else if (g) {
      if (cancelled) s.cancelGesture();
      else s.endGesture();
    }
    gesture.current = null;
    setGuides([]);
  };

  const startHandle = (e: RPointerEvent, id: string, handle: Handle | 'rotate' | CropEdge) => {
    e.stopPropagation();
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const s = getEditor();
    const clip = s.project!.clips.find((c) => c.id === id);
    if (!clip || !isVisual(clip)) return;
    const pt = toFrame(e.clientX, e.clientY);
    pointers.current.set(e.pointerId, pt);
    rootRef.current!.setPointerCapture(e.pointerId);
    s.beginGesture();
    const base = effectiveTransform(clip, s.time);
    if (handle === 'l' || handle === 't' || handle === 'r' || handle === 'b') {
      const crop = clip.type === 'video' || clip.type === 'image' ? (effectiveCrop(clip, s.time) ?? NO_CROP) : NO_CROP;
      gesture.current = { kind: 'crop', id, edge: handle, start: pt, base, crop };
      return;
    }
    gesture.current =
      handle === 'rotate'
        ? { kind: 'rotate', id, base, startAngle: pointerAngle(base, pt.x, pt.y) }
        : { kind: 'resize', id, handle, start: pt, base };
  };

  // Ctrl + roda (ou pinça do trackpad) escala o elemento selecionado
  useEffect(() => {
    const el = rootRef.current!;
    const on = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      const s = getEditor();
      const id = s.selection[0];
      const clip = id ? s.project?.clips.find((c) => c.id === id) : undefined;
      if (!clip || !isVisual(clip)) return;
      e.preventDefault();
      const k = Math.exp(-e.deltaY * 0.0035);
      const tr = effectiveTransform(clip, s.time);
      s.apply(
        (p) => setTransformAt(p, clip.id, s.time, { ...tr, width: Math.max(8, tr.width * k), height: Math.max(8, tr.height * k) }, s.autoKey),
        `wheel-${clip.id}`,
      );
    };
    el.addEventListener('wheel', on, { passive: false });
    return () => el.removeEventListener('wheel', on);
  }, []);

  const selectedItems = items.filter((it) => selection.includes(it.clip.id));
  const editing = editingTextId ? items.find((it) => it.clip.id === editingTextId) : undefined;

  return (
    <div
      ref={rootRef}
      className={`stage-overlay ${tool !== 'select' ? 'drawing' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => finish(e)}
      onPointerCancel={(e) => finish(e, true)}
      onDoubleClick={(e) => {
        const hit = hitAt(toFrame(e.clientX, e.clientY));
        if (hit?.type === 'text' && getPreset(hit.preset).uses.length > 0) getEditor().set('editingTextId', hit.id);
      }}
      data-testid="stage-overlay"
    >
      {safeZones && <SafeZones project={project} scale={scale} />}
      {autoKey && <div className="pancrop-badge" data-testid="pancrop-badge">◆ PAN/CROP · mova a agulha e ajuste o item</div>}
      {selectedItems.map((it) => (
        <Gizmo
          key={it.clip.id}
          tr={it.transform}
          scale={scale}
          type={it.clip.type}
          primary={selectedItems.length === 1}
          crop={cropId === it.clip.id && (it.clip.type === 'video' || it.clip.type === 'image') ? (effectiveCrop(it.clip, time) ?? NO_CROP) : null}
          onHandle={(e, h) => startHandle(e, it.clip.id, h)}
        />
      ))}
      {frameLogoId && <FrameLogoGizmo id={frameLogoId} project={project} time={time} scale={scale} />}
      {guides.map((g, i) => (
        <div
          key={i}
          className={`guide guide-${g.axis}`}
          style={g.axis === 'x' ? { left: g.pos * scale } : { top: g.pos * scale }}
        />
      ))}
      {drawRect && (
        <div
          className={`draw-rect ${tool === 'blur-ellipse' ? 'ellipse' : ''}`}
          style={{
            left: (drawRect.x - drawRect.width / 2) * scale,
            top: (drawRect.y - drawRect.height / 2) * scale,
            width: drawRect.width * scale,
            height: drawRect.height * scale,
          }}
        />
      )}
      {editing && editing.clip.type === 'text' && <TextEditOverlay clip={editing.clip} tr={editing.transform} scale={scale} />}
      {tool !== 'select' && <div className="stage-hint">Arraste sobre a imagem para desenhar a área de desfoque · Esc cancela</div>}
    </div>
  );
}

/** Contorno da logo da moldura selecionada no preview, com lixeira para tirá-la. */
function FrameLogoGizmo({ id, project, time, scale }: { id: string; project: Project; time: number; scale: number }) {
  const c = project.clips.find((x) => x.id === id);
  if (!c || c.type !== 'frame' || time < c.start || time >= c.start + c.duration) return null;
  const r = frameLogoRect(c, project.width, project.height, LOGO_RATIO.horizontal);
  if (!r) return null;
  return (
    <div className="gizmo logo-gizmo" style={{ left: r.x * scale, top: r.y * scale, width: r.w * scale, height: r.h * scale }} data-testid="frame-logo-gizmo">
      <button
        className="logo-gizmo-del"
        aria-label="Tirar a logo da moldura"
        title="Tirar a logo da moldura"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          deleteSelection();
        }}
        data-testid="frame-logo-del"
      >
        <IconTrash />
      </button>
    </div>
  );
}

function Gizmo({
  tr,
  scale,
  type,
  primary,
  crop,
  onHandle,
}: {
  tr: Transform;
  scale: number;
  type: VisualClip['type'];
  primary: boolean;
  /** modo de corte: mostra as alças de borda e o contorno da mídia inteira */
  crop: CropValue | null;
  onHandle: (e: RPointerEvent, h: Handle | 'rotate' | CropEdge) => void;
}) {
  const w = tr.width * scale;
  const h = tr.height * scale;
  if (crop && primary) {
    const full = fullMediaRect(tr, crop);
    return (
      <div
        className="gizmo gizmo-crop"
        style={{ left: tr.x * scale - w / 2, top: tr.y * scale - h / 2, width: w, height: h, transform: `rotate(${tr.rotation}deg)` }}
      >
        <span
          className="crop-full"
          style={{ left: (full.x + tr.width / 2) * scale, top: (full.y + tr.height / 2) * scale, width: full.w * scale, height: full.h * scale }}
        />
        {(['t', 'r', 'b', 'l'] as const).map((edge) => (
          <span key={edge} className={`crop-h crop-${edge}`} onPointerDown={(e) => onHandle(e, edge)} data-handle={`crop-${edge}`} />
        ))}
      </div>
    );
  }
  // mídia redimensiona só pelos cantos (proporcional); gráficos por todas as alças
  const handles = MEDIA_TYPES.has(type) ? HANDLES.filter((x) => x.length === 2) : HANDLES;
  return (
    <div
      className={`gizmo ${type === 'blur' ? 'gizmo-blur' : ''}`}
      style={{
        left: tr.x * scale - w / 2,
        top: tr.y * scale - h / 2,
        width: w,
        height: h,
        transform: `rotate(${tr.rotation}deg)`,
      }}
    >
      {primary &&
        handles.map((hd) => (
          <span key={hd} className={`handle h-${hd}`} onPointerDown={(e) => onHandle(e, hd)} data-handle={hd} />
        ))}
      {primary && (
        <span className="rotate-handle" onPointerDown={(e) => onHandle(e, 'rotate')} title="Girar (Shift desliga o ímã)" data-handle="rotate" />
      )}
    </div>
  );
}

/** Áreas cobertas pela interface do Instagram em Reels/feed (orientação editorial). */
function SafeZones({ project, scale }: { project: Project; scale: number }) {
  const W = project.width * scale;
  const H = project.height * scale;
  const isReel = project.format === 'reel';
  const top = isReel ? H * 0.12 : H * 0.05;
  const bottom = isReel ? H * 0.21 : H * 0.06;
  const right = isReel ? W * 0.14 : 0;
  return (
    <div className="safe-zones" aria-hidden>
      <div className="sz" style={{ left: 0, top: 0, width: W, height: top }} />
      <div className="sz" style={{ left: 0, top: H - bottom, width: W, height: bottom }} />
      {right > 0 && <div className="sz" style={{ left: W - right, top: H * 0.45, width: right, height: H * 0.55 - bottom }} />}
      <span className="sz-label" style={{ top: top + 4 }}>
        área segura
      </span>
    </div>
  );
}
