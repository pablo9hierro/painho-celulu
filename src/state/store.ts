/**
 * Estado do editor. Gestos contínuos (arrastar, redimensionar, aparar) usam
 * begin/update/end: o preview atualiza a cada movimento e o histórico recebe
 * uma única entrada ao soltar.
 */
import { create } from 'zustand';
import type { Clip, MediaAsset, Project } from '../core/model';
import { projectDuration } from '../core/timeline';

const HISTORY_LIMIT = 200;
const MERGE_WINDOW_MS = 800;

export type Tool = 'select' | 'blur-rect' | 'blur-ellipse';
export type Panel = 'media' | 'brand' | 'text' | 'blur' | 'audio';
export type SaveState = 'saved' | 'dirty' | 'saving' | 'error';

interface EditorState {
  project: Project | null;
  media: Record<string, MediaAsset>;
  selection: string[];
  time: number;
  playing: boolean;
  /** pixels por segundo na timeline */
  zoom: number;
  snapping: boolean;
  safeZones: boolean;
  /** prévia em tela cheia (sem controles de edição sobre o vídeo) */
  previewFull: boolean;
  /** clipe em modo de corte (alças de corte no palco) */
  cropId: string | null;
  /** moldura cuja logo do cabeçalho está selecionada no preview */
  frameLogoId: string | null;
  /** modo "Movimento" (Pan/Crop do Vegas): mexer no item grava keyframe na agulha */
  autoKey: boolean;
  tool: Tool;
  panel: Panel | null;
  editingTextId: string | null;
  saveState: SaveState;
  saveError: string | null;
  past: Project[];
  future: Project[];
  gestureBase: Project | null;
  lastMerge: { key: string; at: number } | null;
  clipboard: Clip[] | null;
  toast: { id: number; text: string; kind: 'info' | 'error' } | null;

  load(p: Project): void;
  close(): void;
  setMedia(list: MediaAsset[]): void;
  upsertMedia(m: MediaAsset): void;
  removeMedia(id: string): void;
  select(ids: string[], additive?: boolean): void;
  setTime(t: number): void;
  setPlaying(v: boolean): void;
  setZoom(z: number): void;
  set<K extends keyof EditorState>(key: K, value: EditorState[K]): void;
  /** aplica uma alteração com entrada no histórico; `merge` agrupa edições seguidas (ex.: digitação) */
  apply(fn: (p: Project) => Project, merge?: string): void;
  beginGesture(): void;
  updateGesture(fn: (base: Project) => Project): void;
  endGesture(): void;
  cancelGesture(): void;
  undo(): void;
  redo(): void;
  notify(text: string, kind?: 'info' | 'error'): void;
}

function loadAutoKey(): boolean {
  try {
    return localStorage.getItem('pn-autokey') === '1';
  } catch {
    return false;
  }
}

export function setAutoKey(on: boolean) {
  useEditor.getState().set('autoKey', on);
  try {
    localStorage.setItem('pn-autokey', on ? '1' : '0');
  } catch {
    /* sem armazenamento */
  }
}

export const useEditor = create<EditorState>((set, get) => ({
  project: null,
  media: {},
  selection: [],
  time: 0,
  playing: false,
  zoom: 80,
  snapping: true,
  safeZones: false,
  previewFull: false,
  cropId: null,
  frameLogoId: null,
  autoKey: loadAutoKey(),
  tool: 'select',
  panel: 'media',
  editingTextId: null,
  saveState: 'saved',
  saveError: null,
  past: [],
  future: [],
  gestureBase: null,
  lastMerge: null,
  clipboard: null,
  toast: null,

  load: (p) => set({ project: p, selection: [], time: 0, playing: false, past: [], future: [], saveState: 'saved', gestureBase: null, editingTextId: null }),
  close: () => set({ project: null, selection: [], playing: false, past: [], future: [] }),
  setMedia: (list) => set({ media: Object.fromEntries(list.map((m) => [m.id, m])) }),
  upsertMedia: (m) => set((s) => ({ media: { ...s.media, [m.id]: m } })),
  removeMedia: (id) =>
    set((s) => {
      const media = { ...s.media };
      delete media[id];
      return { media };
    }),
  select: (ids, additive) =>
    set((s) => {
      if (!additive) return { selection: ids, frameLogoId: null };
      const next = new Set(s.selection);
      for (const id of ids) {
        if (next.has(id)) next.delete(id);
        else next.add(id);
      }
      return { selection: [...next] };
    }),
  setTime: (t) => {
    const p = get().project;
    const max = p ? Math.max(projectDuration(p), 0) : 0;
    set({ time: Math.max(0, Math.min(t, max)) });
  },
  setPlaying: (v) => set({ playing: v }),
  setZoom: (z) => set({ zoom: Math.max(4, Math.min(600, z)) }),
  set: (key, value) => set({ [key]: value } as Partial<EditorState>),

  apply: (fn, merge) => {
    const s = get();
    if (!s.project) return;
    const next = fn(s.project);
    if (next === s.project) return;
    const nowMs = Date.now();
    const merging = merge && s.lastMerge?.key === merge && nowMs - s.lastMerge.at < MERGE_WINDOW_MS;
    set({
      project: next,
      past: merging ? s.past : [...s.past, s.project].slice(-HISTORY_LIMIT),
      future: [],
      saveState: 'dirty',
      lastMerge: merge ? { key: merge, at: nowMs } : null,
      selection: s.selection.filter((id) => next.clips.some((c) => c.id === id)),
    });
  },

  beginGesture: () => {
    const p = get().project;
    if (p) set({ gestureBase: p });
  },
  updateGesture: (fn) => {
    const base = get().gestureBase;
    if (!base) return;
    set({ project: fn(base) });
  },
  endGesture: () => {
    const s = get();
    if (!s.gestureBase || !s.project) return;
    if (s.project !== s.gestureBase) {
      set({ past: [...s.past, s.gestureBase].slice(-HISTORY_LIMIT), future: [], saveState: 'dirty', lastMerge: null });
    }
    set({ gestureBase: null });
  },
  cancelGesture: () => {
    const base = get().gestureBase;
    if (base) set({ project: base, gestureBase: null });
  },

  undo: () => {
    const s = get();
    if (!s.project || !s.past.length) return;
    const prev = s.past[s.past.length - 1]!;
    set({
      project: prev,
      past: s.past.slice(0, -1),
      future: [s.project, ...s.future].slice(0, HISTORY_LIMIT),
      saveState: 'dirty',
      lastMerge: null,
      selection: s.selection.filter((id) => prev.clips.some((c) => c.id === id)),
    });
  },
  redo: () => {
    const s = get();
    if (!s.project || !s.future.length) return;
    const next = s.future[0]!;
    set({
      project: next,
      past: [...s.past, s.project],
      future: s.future.slice(1),
      saveState: 'dirty',
      lastMerge: null,
      selection: s.selection.filter((id) => next.clips.some((c) => c.id === id)),
    });
  },

  notify: (text, kind = 'info') => set({ toast: { id: Date.now(), text, kind } }),
}));

export const getEditor = () => useEditor.getState();

export function selectedClips(s: Pick<EditorState, 'project' | 'selection'>): Clip[] {
  if (!s.project) return [];
  return s.project.clips.filter((c) => s.selection.includes(c.id));
}
