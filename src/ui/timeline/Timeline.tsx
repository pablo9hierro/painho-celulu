/**
 * Timeline multitrilha com manipulação direta: arrastar blocos (inclusive entre
 * trilhas), aparar pelas bordas, ímã, agulha arrastável, pinça/Ctrl+roda para
 * zoom e rolagem por arraste no toque.
 */
import { memo, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import type { Clip, MediaAsset, Project, Track } from '../../core/model';
import {
  addTrack,
  closeGaps,
  insertTrackNear,
  overlapping,
  toggleGroup,
  withGroups,
  clipEnd,
  moveClip,
  moveTrack,
  placeClip,
  projectDuration,
  snapCandidates,
  snapTime,
  trackKindFor,
  trimEnd,
  trimStart,
} from '../../core/timeline';
import { getPreset } from '../../core/presets';
import { getEditor, setAutoKey, useEditor } from '../../state/store';
import { createAudioClip, createImageClip, createVideoClip } from '../../core/factory';
import { deleteSelection, detachAudio, duplicateSelection, seek, splitAtPlayhead, recentlyAdded } from '../commands';
import { formatTime } from '../Transport';
import { getWaveform } from './waveforms';
import {
  IconCopy,
  IconDetach,
  IconEye,
  IconEyeOff,
  IconFit,
  IconLock,
  IconMagnet,
  IconMute,
  IconPlus,
  IconSplit,
  IconTrash,
  IconUnlock,
  IconVolume,
} from '../icons';

const RULER_H = 26;

function rowHeight(track: Track, isMain: boolean) {
  if (track.kind === 'audio') return 44;
  return isMain ? 58 : 44;
}

const TICK_STEPS = [1 / 30, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];

type Gesture =
  | { kind: 'scrub' }
  | { kind: 'pan'; x: number; y: number; sl: number; st: number; moved: boolean; t: number }
  | { kind: 'pinch'; d0: number; zoom0: number; anchorT: number; anchorX: number }
  | {
      kind: 'move';
      id: string;
      x0: number;
      y0: number;
      /** scrollLeft no início — a timeline pode rolar sozinha durante o gesto */
      sl0: number;
      bases: { id: string; start: number; trackId: string; duration: number }[];
      moved: boolean;
      /** onde vai cair ao soltar: faixa livre, trocar com outro item, ou faixa nova */
      alvo?: { tipo: 'faixa'; trackId: string } | { tipo: 'troca'; trackId: string; outroId: string } | { tipo: 'nova'; refTrackId: string; acima: boolean };
    }
  | { kind: 'trim'; id: string; edge: 'l' | 'r'; x0: number; sl0: number; start: number; end: number };

/** Faixa junto às bordas que faz a timeline andar sozinha durante arrastes (px). */
const EDGE_ZONE = 64;
/** Velocidade máxima da rolagem automática (px/s): nem rápida demais, nem lenta. */
const EDGE_MAX_SPEED = 520;
const EDGE_MIN_SPEED = 90;

export function Timeline() {
  const project = useEditor((s) => s.project)!;
  const zoom = useEditor((s) => s.zoom);
  const selection = useEditor((s) => s.selection);
  const snapping = useEditor((s) => s.snapping);
  const autoKey = useEditor((s) => s.autoKey);
  const media = useEditor((s) => s.media);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ left: 0, width: 800 });
  const [headW, setHeadW] = useState(132);
  const [snapAt, setSnapAt] = useState<number | null>(null);
  /** aviso visual do que acontece ao soltar (trocar de lugar / faixa nova) */
  const [dropHint, setDropHint] = useState<{ tipo: 'troca' | 'nova'; trackId: string; acima: boolean } | null>(null);
  const fechaVaos = useEditor((s) => s.fechaVaos);
  const gesture = useRef<Gesture | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const lastPointer = useRef<{ x: number; y: number } | null>(null);
  const autoRaf = useRef<number | null>(null);

  const visual = project.tracks.filter((t) => t.kind === 'visual');
  const mainId = visual[0]?.id;
  const rows = [...visual].reverse().concat(project.tracks.filter((t) => t.kind === 'audio'));
  const dur = projectDuration(project);
  const laneW = Math.max(view.width - headW, (dur + 8) * zoom);

  useLayoutEffect(() => {
    const el = scrollRef.current!;
    const update = () => {
      setView({ left: el.scrollLeft, width: el.clientWidth });
      setHeadW(window.matchMedia('(max-width: 899px)').matches ? 52 : 132);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const laneX = (clientX: number) => {
    const r = scrollRef.current!.getBoundingClientRect();
    return clientX - r.left - headW + scrollRef.current!.scrollLeft;
  };
  const timeAt = (clientX: number) => Math.max(0, laneX(clientX) / getEditor().zoom);

  const setZoomAnchored = (z: number, anchorT: number, anchorClientX: number) => {
    const s = getEditor();
    s.setZoom(z);
    const nz = getEditor().zoom;
    const el = scrollRef.current!;
    const r = el.getBoundingClientRect();
    requestAnimationFrame(() => {
      el.scrollLeft = Math.max(0, anchorT * nz - (anchorClientX - r.left - headW));
    });
  };

  // Ctrl+roda / pinça do trackpad = zoom; roda simples = rolagem horizontal
  useEffect(() => {
    const el = scrollRef.current!;
    const on = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const t = timeAt(e.clientX);
        setZoomAnchored(getEditor().zoom * Math.exp(-e.deltaY * 0.004), t, e.clientX);
      } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        // rolagem horizontal é controlada aqui (a barra nativa horizontal fica oculta)
        e.preventDefault();
        el.scrollLeft += e.deltaX || e.deltaY;
      } else if (el.scrollHeight <= el.clientHeight + 2) {
        e.preventDefault();
        el.scrollLeft += e.deltaY;
      }
    };
    el.addEventListener('wheel', on, { passive: false });
    return () => el.removeEventListener('wheel', on);
  }, [headW]);

  // agulha visível durante a reprodução
  useEffect(
    () =>
      useEditor.subscribe((s, p) => {
        if (!s.playing || s.time === p.time) return;
        const el = scrollRef.current;
        if (!el) return;
        const x = s.time * s.zoom;
        const visW = el.clientWidth - headW;
        if (x < el.scrollLeft || x > el.scrollLeft + visW - 40) el.scrollLeft = Math.max(0, x - visW * 0.15);
      }),
    [headW],
  );

  const snapT = (t: number, exclude: string[], candidatesExtra: number[] = []) => {
    const s = getEditor();
    if (!s.snapping || !s.project) return { value: t, snapped: false as const };
    return snapTime(t, [...snapCandidates(s.project, s.time, exclude), ...candidatesExtra], 9 / s.zoom);
  };

  const trackUnder = (clientX: number, clientY: number): string | null => {
    const el = document.elementFromPoint(clientX, clientY)?.closest('[data-track]') as HTMLElement | null;
    return el?.dataset.track ?? null;
  };

  // ------------------------------------------------------------------ gestos
  const onPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('.tl-head') || target.closest('button')) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    scrollRef.current!.setPointerCapture(e.pointerId);
    const s = getEditor();

    if (pointers.current.size === 2) {
      const g = gesture.current;
      if (g && (g.kind === 'move' || g.kind === 'trim')) s.cancelGesture();
      const [a, b] = [...pointers.current.values()];
      const mid = (a!.x + b!.x) / 2;
      gesture.current = { kind: 'pinch', d0: Math.abs(b!.x - a!.x) || 1, zoom0: s.zoom, anchorT: timeAt(mid), anchorX: mid };
      return;
    }
    if (pointers.current.size > 2) return;

    const clipEl = target.closest('[data-clip]') as HTMLElement | null;
    const edge = target.dataset.edge as 'l' | 'r' | undefined;
    const onRuler = !!target.closest('.tl-ruler');
    const onPlayhead = !!target.closest('.playhead');
    lastPointer.current = { x: e.clientX, y: e.clientY };
    const sl0 = scrollRef.current!.scrollLeft;

    // agulha (cabeça ou corpo): arrastar navega; perto da borda a timeline anda sozinha
    if (onPlayhead) {
      gesture.current = { kind: 'scrub' };
      startAutoScroll();
      return;
    }

    if (clipEl && !onRuler) {
      const id = clipEl.dataset.clip!;
      const clip = s.project!.clips.find((c) => c.id === id);
      const track = clip && s.project!.tracks.find((t) => t.id === clip.trackId);
      if (!clip || track?.locked) return;
      if (edge) {
        s.select([id]);
        s.beginGesture();
        gesture.current = { kind: 'trim', id, edge, x0: e.clientX, sl0, start: clip.start, end: clipEnd(clip) };
        startAutoScroll();
        return;
      }
      const wasSelected = s.selection.includes(id);
      if (e.shiftKey || e.ctrlKey || e.metaKey) s.select([id], true);
      else if (!wasSelected) s.select([id]);
      // no toque, o primeiro toque seleciona; arrastar move apenas blocos já selecionados
      if (e.pointerType === 'touch' && !wasSelected) {
        const el = scrollRef.current!;
        gesture.current = { kind: 'pan', x: e.clientX, y: e.clientY, sl: el.scrollLeft, st: el.scrollTop, moved: false, t: -1 };
        return;
      }
      const sel = getEditor().selection;
      s.beginGesture();
      gesture.current = {
        kind: 'move',
        id,
        x0: e.clientX,
        y0: e.clientY,
        sl0,
        // itens agrupados (Ctrl+G, legenda ligada ao vídeo) andam juntos
        bases: s.project!.clips.filter((c) => withGroups(s.project!, sel).includes(c.id)).map((c) => ({ id: c.id, start: c.start, trackId: c.trackId, duration: c.duration })),
        moved: false,
      };
      startAutoScroll();
      return;
    }

    if (onRuler || e.pointerType !== 'touch') {
      gesture.current = { kind: 'scrub' };
      if (!onRuler && !e.shiftKey) s.select([]);
      seek(timeAt(e.clientX));
      startAutoScroll();
      return;
    }
    const el = scrollRef.current!;
    gesture.current = { kind: 'pan', x: e.clientX, y: e.clientY, sl: el.scrollLeft, st: el.scrollTop, moved: false, t: timeAt(e.clientX) };
  };

  /** Velocidade de rolagem automática conforme a proximidade da borda (negativa = esquerda). */
  const edgeSpeed = (clientX: number) => {
    const r = scrollRef.current!.getBoundingClientRect();
    const left = r.left + headW;
    const k = (d: number) => EDGE_MIN_SPEED + (EDGE_MAX_SPEED - EDGE_MIN_SPEED) * Math.min(1, d / EDGE_ZONE);
    if (clientX < left + EDGE_ZONE) return -k(left + EDGE_ZONE - clientX);
    if (clientX > r.right - EDGE_ZONE) return k(clientX - (r.right - EDGE_ZONE));
    return 0;
  };

  /** Laço que rola a timeline enquanto o dedo/mouse estiver junto à borda num arraste. */
  const startAutoScroll = () => {
    if (autoRaf.current !== null) return;
    let prev = performance.now();
    const tick = (now: number) => {
      const g = gesture.current;
      const p = lastPointer.current;
      if (!g || !p || !(g.kind === 'scrub' || g.kind === 'move' || g.kind === 'trim')) {
        autoRaf.current = null;
        return;
      }
      const dt = Math.min(0.05, (now - prev) / 1000);
      prev = now;
      const v = edgeSpeed(p.x);
      const el = scrollRef.current!;
      if (v !== 0) {
        const before = el.scrollLeft;
        el.scrollLeft = Math.max(0, before + v * dt);
        if (el.scrollLeft !== before) handleMove(p.x, p.y);
      }
      autoRaf.current = requestAnimationFrame(tick);
    };
    autoRaf.current = requestAnimationFrame(tick);
  };

  const onPointerMove = (e: RPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    lastPointer.current = { x: e.clientX, y: e.clientY };
    handleMove(e.clientX, e.clientY);
  };

  const handleMove = (clientX: number, clientY: number) => {
    const g = gesture.current;
    if (!g) return;
    const s = getEditor();
    const scrolled = 'sl0' in g ? scrollRef.current!.scrollLeft - g.sl0 : 0;
    switch (g.kind) {
      case 'scrub':
        seek(timeAt(clientX));
        return;
      case 'pan': {
        const dx = clientX - g.x;
        const dy = clientY - g.y;
        if (!g.moved && Math.hypot(dx, dy) < 6) return;
        g.moved = true;
        scrollRef.current!.scrollLeft = g.sl - dx;
        scrollRef.current!.scrollTop = g.st - dy;
        return;
      }
      case 'pinch': {
        const [a, b] = [...pointers.current.values()];
        if (!a || !b) return;
        const d = Math.abs(b.x - a.x) || 1;
        setZoomAnchored(g.zoom0 * (d / g.d0), g.anchorT, g.anchorX);
        return;
      }
      case 'move': {
        const dxT = (clientX - g.x0 + scrolled) / s.zoom;
        // vale arrastar para os lados OU para cima/baixo (trocar de faixa)
        if (!g.moved && Math.hypot(clientX - g.x0, clientY - g.y0) < 4 && scrolled === 0) return;
        g.moved = true;
        const prim = g.bases.find((b) => b.id === g.id)!;
        const ids = g.bases.map((b) => b.id);
        let start = Math.max(0, prim.start + dxT);
        // imã: início ou fim do bloco encostam em bordas/agulha
        const sStart = snapT(start, ids);
        const sEnd = snapT(start + prim.duration, ids);
        if (sStart.snapped && (!sEnd.snapped || Math.abs(sStart.value - start) <= Math.abs(sEnd.value - start - prim.duration))) {
          start = sStart.value;
          setSnapAt(sStart.value);
        } else if (sEnd.snapped) {
          start = sEnd.value - prim.duration;
          setSnapAt(sEnd.value);
        } else setSnapAt(null);
        const delta = start - prim.start;
        const hoverTrack = trackUnder(clientX, clientY);
        const primClip = s.project!.clips.find((c) => c.id === g.id)!;
        const kind = trackKindFor(primClip);
        const ids2 = g.bases.map((b) => b.id);
        // acima de todas as faixas (ou abaixo de todas): faixa nova ao soltar
        const rowsEls = [...scrollRef.current!.querySelectorAll<HTMLElement>('.tl-lane[data-track]')];
        const first = rowsEls[0]?.getBoundingClientRect();
        const last = rowsEls[rowsEls.length - 1]?.getBoundingClientRect();
        g.alvo = undefined;
        if (!hoverTrack && first && clientY < first.top && kind === 'visual') {
          const topo = [...s.project!.tracks].filter((x) => x.kind === 'visual').pop();
          if (topo) g.alvo = { tipo: 'nova', refTrackId: topo.id, acima: true };
        } else if (!hoverTrack && last && clientY > last.bottom && kind === 'audio') {
          const fim = [...s.project!.tracks].filter((x) => x.kind === 'audio').pop();
          if (fim) g.alvo = { tipo: 'nova', refTrackId: fim.id, acima: false };
        } else if (hoverTrack) {
          const tr = s.project!.tracks.find((x) => x.id === hoverTrack);
          if (tr && tr.kind === kind && !tr.locked) {
            if (tr.id === prim.trackId) g.alvo = { tipo: 'faixa', trackId: tr.id };
            else {
              const quem = overlapping(s.project!, tr.id, start, prim.duration, ids2);
              if (!quem.length) g.alvo = { tipo: 'faixa', trackId: tr.id };
              else if (quem.length === 1 && !quem[0]!.group) g.alvo = { tipo: 'troca', trackId: tr.id, outroId: quem[0]!.id };
              else g.alvo = { tipo: 'nova', refTrackId: tr.id, acima: kind === 'visual' };
            }
          }
        }
        const a = g.alvo;
        setDropHint(a && a.tipo !== 'faixa' ? { tipo: a.tipo, trackId: a.tipo === 'troca' ? a.trackId : a.refTrackId, acima: a.tipo === 'nova' ? a.acima : false } : null);
        s.updateGesture((base) => {
          let p = base;
          for (const b of g.bases) {
            // só muda de faixa ao vivo quando ela está livre; troca/faixa nova acontece ao soltar
            const trackId = b.id === g.id && a?.tipo === 'faixa' ? a.trackId : b.trackId;
            p = moveClip(p, b.id, Math.max(0, b.start + delta), trackId);
          }
          return p;
        });
        return;
      }
      case 'trim': {
        const dxT = (clientX - g.x0 + scrolled) / s.zoom;
        if (g.edge === 'l') {
          const sn = snapT(g.start + dxT, [g.id]);
          setSnapAt(sn.snapped ? sn.value : null);
          s.updateGesture((base) => trimStart(base, g.id, sn.value));
        } else {
          const sn = snapT(g.end + dxT, [g.id]);
          setSnapAt(sn.snapped ? sn.value : null);
          s.updateGesture((base) => trimEnd(base, g.id, sn.value));
        }
      }
    }
  };

  const onPointerUp = (e: RPointerEvent<HTMLDivElement>, cancelled = false) => {
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    const s = getEditor();
    if (g?.kind === 'pinch') {
      if (pointers.current.size === 0) gesture.current = null;
      return;
    }
    if (pointers.current.size > 0) return;
    if (g?.kind === 'move' || g?.kind === 'trim') {
      if (cancelled) s.cancelGesture();
      else {
        if (g.kind === 'move' && g.moved && g.alvo && g.alvo.tipo !== 'faixa') {
          const alvo = g.alvo;
          const prim = g.bases.find((b) => b.id === g.id)!;
          s.updateGesture((base) => {
            const cur = base.clips.find((c) => c.id === g.id);
            if (!cur) return base;
            if (alvo.tipo === 'troca') {
              // os dois trocam de faixa (cada um mantém o seu tempo)
              const outro = base.clips.find((c) => c.id === alvo.outroId);
              if (!outro) return base;
              const p1 = { ...base, clips: base.clips.map((c) => (c.id === outro.id ? { ...c, trackId: prim.trackId } : c.id === cur.id ? { ...c, trackId: alvo.trackId } : c)) };
              return p1;
            }
            // abre uma faixa só para ele (só agora, ao soltar)
            const ref = alvo.acima ? alvo.refTrackId : alvo.refTrackId;
            const r = insertTrackNear(base, ref, base.tracks.find((x) => x.id === ref)!.kind);
            return { ...r.project, clips: r.project.clips.map((c) => (c.id === cur.id ? { ...c, trackId: r.trackId } : c)) };
          });
        }
        if (s.fechaVaos) s.updateGesture((base) => closeGaps(base));
        s.endGesture();
      }
      setDropHint(null);
    } else if (g?.kind === 'pan' && !g.moved && !cancelled && g.t >= 0) {
      s.select([]);
      seek(g.t);
    }
    gesture.current = null;
    setSnapAt(null);
  };

  // ------------------------------------------------------- soltar mídia da biblioteca
  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    const id = e.dataTransfer.getData('application/x-pn-media');
    if (!id) return;
    e.preventDefault();
    // o Chrome anexa a imagem arrastada como "arquivo": sem isto o editor a importava de novo (item duplicado)
    e.stopPropagation();
    if (recentlyAdded(id)) return;
    const s = getEditor();
    const m = s.media[id];
    if (!m || !s.project || m.status !== 'ready') return;
    const t = timeAt(e.clientX);
    const trackId = trackUnder(e.clientX, e.clientY) ?? undefined;
    const clip = m.kind === 'video' ? createVideoClip(s.project, m, t) : m.kind === 'image' ? createImageClip(s.project, m, t) : createAudioClip(s.project, m, t);
    s.apply((p) => placeClip(p, clip, trackId));
    s.select([clip.id]);
  };

  // ------------------------------------------------------------------ régua
  const step = TICK_STEPS.find((st) => st * zoom >= 64) ?? 600;
  const t0 = Math.max(0, Math.floor(view.left / zoom / step) * step);
  const t1 = (view.left + view.width) / zoom;
  const ticks: number[] = [];
  for (let t = t0; t <= t1 + step; t += step) ticks.push(Math.round(t * 1000) / 1000);

  const fit = () => {
    const w = (scrollRef.current?.clientWidth ?? 800) - headW - 40;
    getEditor().setZoom(w / Math.max(1, dur));
    if (scrollRef.current) scrollRef.current.scrollLeft = 0;
  };

  const hasSel = selection.length > 0;
  const selVideo = project.clips.some((c) => selection.includes(c.id) && c.type === 'video' && c.hasAudio);

  return (
    <div className="tl" style={{ ['--head-w' as string]: `${headW}px` }}>
      <div className="tl-toolbar">
        <button className="icon-btn" onClick={splitAtPlayhead} title="Dividir (S)" aria-label="Dividir" data-testid="tl-split">
          <IconSplit />
        </button>
        <button className="icon-btn" disabled={!hasSel} onClick={() => deleteSelection()} title="Excluir (Delete) · Shift+Delete fecha o espaço" aria-label="Excluir" data-testid="tl-delete">
          <IconTrash />
        </button>
        <button className="icon-btn" disabled={!hasSel} onClick={duplicateSelection} title="Duplicar (Ctrl+D)" aria-label="Duplicar">
          <IconCopy />
        </button>
        <button className="icon-btn" disabled={!selVideo} onClick={detachAudio} title="Separar áudio do vídeo" aria-label="Separar áudio">
          <IconDetach />
        </button>
        <button
          className={`btn sm pancrop-btn ${autoKey ? 'on' : ''}`}
          onClick={() => setAutoKey(!autoKey)}
          title="Event Pan/Crop (como no Vegas): ligado, mexer/cortar o item grava um nó ◆ na agulha e ele se move entre os nós"
          aria-pressed={autoKey}
          data-testid="tl-pancrop"
        >
          ◆ Pan/Crop
        </button>
        <span className="tl-sep" />
        <button
          className={`icon-btn ${snapping ? 'on' : ''}`}
          onClick={() => getEditor().set('snapping', !snapping)}
          title="Ímã (alinhar a bordas e à agulha)"
          aria-label="Ímã"
        >
          <IconMagnet />
        </button>
        <button
          className="icon-btn"
          onClick={() => getEditor().apply((p) => addTrack(p, 'visual').project)}
          title="Nova camada"
          aria-label="Nova camada"
        >
          <IconPlus />
        </button>
        <button
          className="btn sm"
          disabled={selection.length < 1 || (selection.length < 2 && !project.clips.find((c) => c.id === selection[0])?.group)}
          onClick={() => getEditor().apply((p) => toggleGroup(p, withGroups(p, selection)))}
          title="Agrupar (Ctrl+G): os itens andam juntos. Com um grupo selecionado, desagrupa."
          data-testid="tl-group"
        >
          {selection.length && project.clips.filter((c) => selection.includes(c.id)).every((c, _i, arr) => c.group && c.group === arr[0]!.group) ? 'Desagrupar' : 'Agrupar'}
        </button>
        <button
          className={`btn sm ${fechaVaos ? 'primary' : ''}`}
          onClick={() => {
            const s = getEditor();
            s.set('fechaVaos', !fechaVaos);
            if (!fechaVaos) s.apply((p) => closeGaps(p));
          }}
          title="Juntar trechos: tira os espaços vazios entre os vídeos (e continua tirando depois de mover, cortar ou apagar)"
          aria-pressed={fechaVaos}
          data-testid="tl-gaps"
        >
          Juntar trechos
        </button>
        <div className="tl-spacer" />
        <button className="icon-btn" onClick={fit} title="Ajustar a timeline à tela" aria-label="Ajustar">
          <IconFit />
        </button>
        <input
          type="range"
          className="zoom-range"
          min={Math.log(4)}
          max={Math.log(600)}
          step={0.01}
          value={Math.log(zoom)}
          onChange={(e) => getEditor().setZoom(Math.exp(Number(e.target.value)))}
          aria-label="Zoom da timeline"
        />
      </div>

      <div
        className="tl-scroll"
        ref={scrollRef}
        onScroll={(e) => setView({ left: e.currentTarget.scrollLeft, width: e.currentTarget.clientWidth })}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => onPointerUp(e)}
        onPointerCancel={(e) => onPointerUp(e, true)}
        onDragOver={(e) => e.dataTransfer.types.includes('application/x-pn-media') && e.preventDefault()}
        onDrop={onDrop}
        data-testid="timeline"
      >
        <div className="tl-content" style={{ width: headW + laneW }}>
          <div className="tl-ruler-row" style={{ height: RULER_H }}>
            <div className="tl-corner" />
            <div className="tl-ruler" style={{ width: laneW }}>
              {ticks.map((t) => (
                <div key={t} className="tick" style={{ left: t * zoom }}>
                  <span>{step < 1 ? formatTime(t, project.fps).slice(3) : formatTime(t, project.fps).slice(0, 5)}</span>
                </div>
              ))}
            </div>
          </div>

          {rows.map((track) => (
            <TrackRow
              key={track.id}
              track={track}
              project={project}
              isMain={track.id === mainId}
              zoom={zoom}
              laneW={laneW}
              selection={selection}
              media={media}
              view={view}
              headW={headW}
            />
          ))}

          <Playhead headW={headW} />
          {snapAt !== null && <div className="snap-line" style={{ left: headW + snapAt * zoom }} />}
          {dropHint && <DropHint hint={dropHint} />}
        </div>
        {project.clips.length === 0 && <div className="tl-empty">Importe um vídeo pelo painel Mídia ou arraste arquivos para cá</div>}
      </div>
      <HScrollbar scrollRef={scrollRef} contentW={headW + laneW} viewLeft={view.left} viewW={view.width} headW={headW} />
    </div>
  );
}

/**
 * Barra de rolagem horizontal larga, feita para o dedo: arraste o polegar
 * ou toque na trilha para pular. Não interfere com os blocos da timeline.
 */
function HScrollbar({
  scrollRef,
  contentW,
  viewLeft,
  viewW,
  headW,
}: {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  contentW: number;
  viewLeft: number;
  viewW: number;
  headW: number;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [trackW, setTrackW] = useState(0);
  useLayoutEffect(() => {
    const el = trackRef.current!;
    const ro = new ResizeObserver(() => setTrackW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const maxScroll = Math.max(0, contentW - viewW);
  const thumbW = maxScroll <= 0 ? trackW : Math.max(56, (trackW * viewW) / contentW);
  const free = Math.max(1, trackW - thumbW);
  const thumbX = maxScroll <= 0 ? 0 : (viewLeft / maxScroll) * free;

  const scrollTo = (x: number) => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = (Math.min(free, Math.max(0, x)) / free) * maxScroll;
  };

  const onDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (maxScroll <= 0) return;
    e.preventDefault();
    const r = trackRef.current!.getBoundingClientRect();
    const onThumb = (e.target as HTMLElement).classList.contains('hsb-thumb');
    // toque fora do polegar: centraliza o polegar ali e continua arrastando
    const grab = onThumb ? e.clientX - r.left - thumbX : thumbW / 2;
    if (!onThumb) scrollTo(e.clientX - r.left - grab);
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => scrollTo(ev.clientX - r.left - grab);
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  return (
    <div className="hsb" style={{ paddingLeft: headW }}>
      <div className="hsb-track" ref={trackRef} onPointerDown={onDown} data-tip="Rolar a timeline" data-testid="tl-scrollbar">
        <div className="hsb-thumb" style={{ width: thumbW, transform: `translateX(${thumbX}px)` }} />
      </div>
    </div>
  );
}

function Playhead({ headW }: { headW: number }) {
  const time = useEditor((s) => s.time);
  const zoom = useEditor((s) => s.zoom);
  return (
    <div className="playhead" style={{ left: headW + time * zoom }} data-testid="playhead">
      <span className="playhead-cap" />
    </div>
  );
}

const TrackRow = memo(function TrackRow({
  track,
  project,
  isMain,
  zoom,
  laneW,
  selection,
  media,
  view,
  headW,
}: {
  track: Track;
  project: Project;
  isMain: boolean;
  zoom: number;
  laneW: number;
  selection: string[];
  media: Record<string, MediaAsset>;
  view: { left: number; width: number };
  headW: number;
}) {
  const h = rowHeight(track, isMain);
  const clips = project.clips.filter((c) => c.trackId === track.id);
  const toggle = (key: 'hidden' | 'muted' | 'locked') =>
    getEditor().apply((p) => ({ ...p, tracks: p.tracks.map((t) => (t.id === track.id ? { ...t, [key]: !t[key] } : t)) }));
  const removeTrack = () => getEditor().apply((p) => ({ ...p, tracks: p.tracks.filter((t) => t.id !== track.id) }));
  const sameKind = project.tracks.filter((t) => t.kind === track.kind).length;
  const [volOpen, setVolOpen] = useState(false);
  const setVol = (v: number) => getEditor().apply((p) => ({ ...p, tracks: p.tracks.map((t) => (t.id === track.id ? { ...t, volume: v } : t)) }), `trackvol-${track.id}`);

  return (
    <div className={`tl-row ${track.kind} ${isMain ? 'main' : ''} ${track.locked ? 'locked' : ''}`} style={{ height: h }}>
      <div className="tl-head">
        <span className="tl-head-name" title={track.name}>
          {track.name}
        </span>
        <div className="tl-head-btns">
          {track.kind === 'visual' ? (
            <button className="mini-btn" onClick={() => toggle('hidden')} aria-label={track.hidden ? 'Mostrar' : 'Ocultar'} title={track.hidden ? 'Mostrar' : 'Ocultar'}>
              {track.hidden ? <IconEyeOff /> : <IconEye />}
            </button>
          ) : null}
          {(track.kind === 'audio' || isMain) && (
            <button
              className="mini-btn"
              onClick={() => toggle('muted')}
              onContextMenu={(e) => {
                e.preventDefault();
                setVolOpen((v) => !v);
              }}
              aria-label={track.muted ? 'Ativar som' : 'Silenciar'}
              title={track.muted ? 'Ativar som' : 'Silenciar (segure ou clique com o botão direito: volume)'}
              data-testid="tl-mute"
            >
              {track.muted ? <IconMute /> : <IconVolume />}
            </button>
          )}
          {(track.kind === 'audio' || isMain) && (
            <button className="mini-btn" onClick={() => setVolOpen((v) => !v)} aria-label="Volume da faixa" title="Volume da faixa" data-testid="tl-vol">
              {Math.round((track.volume ?? 1) * 100)}
            </button>
          )}
          <button className="mini-btn hide-sm" onClick={() => toggle('locked')} aria-label={track.locked ? 'Destravar' : 'Travar'} title={track.locked ? 'Destravar' : 'Travar'}>
            {track.locked ? <IconLock /> : <IconUnlock />}
          </button>
          {clips.length === 0 && sameKind > 1 && (
            <button className="mini-btn hide-sm" onClick={removeTrack} aria-label="Remover trilha vazia" title="Remover trilha vazia">
              ×
            </button>
          )}
          {track.kind === 'visual' && !isMain && (
            <button className="mini-btn hide-sm" onClick={() => getEditor().apply((p) => moveTrack(p, track.id, 1))} title="Subir camada" aria-label="Subir camada">
              ↑
            </button>
          )}
        </div>
      </div>
      {volOpen && (
        <div className="tl-vol-pop" data-testid="tl-vol-pop">
          <span className="small">Volume</span>
          <input type="range" min={0} max={2} step={0.05} value={track.volume ?? 1} onChange={(e) => setVol(Number(e.target.value))} aria-label="Volume da faixa" />
          <b className="small">{Math.round((track.volume ?? 1) * 100)}%</b>
          <button className="mini-btn" onClick={() => setVolOpen(false)} aria-label="Fechar">×</button>
        </div>
      )}
      <div className="tl-lane" data-track={track.id} style={{ width: laneW }}>
        {clips.map((c) => {
          const x0 = c.start * zoom;
          const x1 = clipEnd(c) * zoom;
          // virtualização simples: ignora blocos totalmente fora da área visível
          if (x1 < view.left - headW - 200 || x0 > view.left + view.width + 200) return null;
          return <ClipView key={c.id} clip={c} zoom={zoom} height={h} selected={selection.includes(c.id)} asset={'mediaId' in c ? media[c.mediaId] : undefined} />;
        })}
      </div>
    </div>
  );
});

/** onde o item vai cair: troca de lugar ou faixa nova */
function DropHint({ hint }: { hint: { tipo: 'troca' | 'nova'; trackId: string; acima: boolean } }) {
  const [box, setBox] = useState<{ top: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const el = document.querySelector<HTMLElement>(`.tl-lane[data-track="${hint.trackId}"]`);
    const row = el?.parentElement;
    if (row) setBox({ top: row.offsetTop, h: row.offsetHeight });
  }, [hint.trackId, hint.tipo]);
  if (!box) return null;
  return hint.tipo === 'troca' ? (
    <div className="tl-drop troca" style={{ top: box.top, height: box.h }}>trocar de lugar</div>
  ) : (
    <div className="tl-drop nova" style={{ top: hint.acima ? box.top - 3 : box.top + box.h - 3 }}>
      <span>nova faixa</span>
    </div>
  );
}

const TYPE_LABEL: Record<Clip['type'], string> = {
  video: 'Vídeo',
  image: 'Imagem',
  audio: 'Áudio',
  text: 'Manchete',
  blur: 'Desfoque',
  sponsors: 'Oferecimento',
  shape: 'Forma',
  frame: 'Moldura',
};

const ClipView = memo(function ClipView({
  clip,
  zoom,
  height,
  selected,
  asset,
}: {
  clip: Clip;
  zoom: number;
  height: number;
  selected: boolean;
  asset?: MediaAsset;
}) {
  const kfSel = useEditor((s) => s.kfSel);
  const w = Math.max(2, clip.duration * zoom);
  const label =
    clip.type === 'text' ? `${getPreset(clip.preset).name} · ${clip.fields.title.replace(/\*/g, '')}` : clip.name || TYPE_LABEL[clip.type];
  const speed = (clip.type === 'video' || clip.type === 'audio') && clip.speed !== 1 ? `${clip.speed}×` : null;
  const muted = (clip.type === 'video' || clip.type === 'audio') && clip.muted;
  // nó no início/fim fica para dentro do clipe (senão some sob as alças de esticar)
  const kfX = (t: number) => Math.min(Math.max(t * zoom, 8), Math.max(8, w - 8));

  return (
    <div
      className={`clip clip-${clip.type} ${selected ? 'selected' : ''}`}
      style={{ left: clip.start * zoom, width: w, height: height - 6 }}
      data-clip={clip.id}
      data-testid={`clip-${clip.type}`}
    >
      {clip.group && <span className="clip-group-badge" title="Agrupado: anda junto com outros itens">🔗</span>}
      {clip.type === 'video' && asset?.thumbs && <Filmstrip clip={clip} asset={asset} zoom={zoom} width={w} height={height - 6} />}
      {clip.type === 'image' && asset && <div className="clip-image-bg" style={{ backgroundImage: `url(${asset.url})` }} />}
      {(clip.type === 'audio' || (clip.type === 'video' && clip.hasAudio)) && asset?.waveform && (
        <Waveform clip={clip} url={asset.waveform} zoom={zoom} width={w} height={clip.type === 'audio' ? height - 22 : 14} />
      )}
      <div className="clip-label">
        {muted && <IconMute className="clip-badge-ico" />}
        {speed && <span className="clip-badge">{speed}</span>}
        <span className="clip-name">{label}</span>
      </div>
      {clip.type !== 'audio' && clip.keyframes.length > 1 && (
        <span
          className="kf-line"
          style={{ left: kfX(clip.keyframes[0]!.t), width: kfX(clip.keyframes[clip.keyframes.length - 1]!.t) - kfX(clip.keyframes[0]!.t) }}
        />
      )}
      {clip.type !== 'audio' &&
        clip.keyframes.map((k, i) => (
          <span
            key={i}
            className={`kf-dot ${kfSel && kfSel.clipId === clip.id && Math.abs(kfSel.t - k.t) < 1 / 60 ? 'on' : ''}`}
            style={{ left: kfX(k.t) }}
            title={`Nó em ${(clip.start + k.t).toFixed(2)} s — toque para ir até ele`}
            onPointerDown={(e) => {
              // tocar no nó leva a agulha até ele (sem arrastar o clipe)
              e.stopPropagation();
              const ed = getEditor();
              ed.select([clip.id]);
              seek(clip.start + k.t);
              // nó selecionado: o que for ajustado agora edita este nó; lixeira apaga só ele
              ed.set('kfSel', { clipId: clip.id, t: k.t });
            }}
            data-testid="kf-dot"
          />
        ))}
      <span className="edge edge-l" data-edge="l" />
      <span className="edge edge-r" data-edge="r" />
    </div>
  );
});

function Filmstrip({ clip, asset, zoom, width, height }: { clip: Extract<Clip, { type: 'video' }>; asset: MediaAsset; zoom: number; width: number; height: number }) {
  const th = asset.thumbs!;
  const tw = th.width * (height / th.height);
  const n = Math.min(300, Math.ceil(width / tw));
  const tiles = [];
  for (let i = 0; i < n; i++) {
    const srcT = clip.sourceIn + ((i * tw) / zoom) * clip.speed;
    const idx = Math.min(th.count - 1, Math.max(0, Math.floor(srcT / th.interval)));
    tiles.push(
      <span
        key={i}
        className="film-tile"
        style={{
          left: i * tw,
          width: tw,
          backgroundImage: `url(${th.url})`,
          backgroundSize: `${th.count * tw}px ${height}px`,
          backgroundPosition: `${-idx * tw}px 0`,
        }}
      />,
    );
  }
  return <div className="filmstrip">{tiles}</div>;
}

function Waveform({ clip, url, zoom, width, height }: { clip: Extract<Clip, { type: 'video' | 'audio' }>; url: string; zoom: number; width: number; height: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [data, setData] = useState<{ perSec: number; peaks: number[] } | null>(null);
  useEffect(() => {
    let alive = true;
    void getWaveform(url).then((d) => alive && setData(d));
    return () => {
      alive = false;
    };
  }, [url]);
  const cw = Math.min(Math.ceil(width), 6000);
  useEffect(() => {
    const c = ref.current;
    if (!c || !data) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = cw * dpr;
    c.height = height * dpr;
    const ctx = c.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cw, height);
    ctx.fillStyle = clip.type === 'audio' ? 'rgba(160,230,200,0.85)' : 'rgba(255,255,255,0.55)';
    const mid = clip.type === 'audio' ? height / 2 : height;
    for (let x = 0; x < cw; x++) {
      const a = clip.sourceIn + (x / zoom) * clip.speed;
      const b = clip.sourceIn + ((x + 1) / zoom) * clip.speed;
      const i0 = Math.floor(a * data.perSec);
      const i1 = Math.max(i0 + 1, Math.floor(b * data.perSec));
      let m = 0;
      for (let i = i0; i < i1 && i < data.peaks.length; i++) m = Math.max(m, data.peaks[i]!);
      const v = (m / 255) * clip.volume;
      const hh = Math.min(1, v) * (clip.type === 'audio' ? height / 2 : height);
      if (clip.type === 'audio') ctx.fillRect(x, mid - hh, 1, hh * 2);
      else ctx.fillRect(x, mid - hh, 1, hh);
    }
  }, [data, cw, height, zoom, clip.sourceIn, clip.speed, clip.volume, clip.type]);
  return <canvas ref={ref} className={`waveform ${clip.type === 'video' ? 'wf-strip' : ''}`} style={{ width: cw, height }} />;
}
