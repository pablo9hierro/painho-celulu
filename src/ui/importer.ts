/** Importação de arquivos: envio ao servidor local, acompanhamento e inserção na timeline. */
import type { MediaAsset } from '../core/model';
import { media as mediaApi } from '../platform/api';
import { getEditor } from '../state/store';
import { addMedia } from './commands';

const ACCEPT = /^(video|audio|image)\//;
const EXT = /\.(mp4|mov|m4v|webm|mkv|avi|3gp|mts|mp3|wav|m4a|aac|ogg|opus|flac|wma|amr|jpe?g|png|webp|gif|bmp|avif|heic|heif|tiff?)$/i;

export const ACCEPT_ATTR = 'video/*,audio/*,image/*,.mkv,.mts,.heic,.heif';

export interface UploadProgress {
  name: string;
  progress: number;
}

type Listener = (list: UploadProgress[]) => void;
const listeners = new Set<Listener>();
let uploads: UploadProgress[] = [];
const emit = () => listeners.forEach((l) => l([...uploads]));

export function onUploads(l: Listener) {
  listeners.add(l);
  l([...uploads]);
  return () => listeners.delete(l);
}

async function waitReady(id: string): Promise<MediaAsset> {
  for (;;) {
    const m = await mediaApi.get(id);
    getEditor().upsertMedia(m);
    if (m.status !== 'processing') return m;
    await new Promise((r) => setTimeout(r, 900));
  }
}

export async function importFiles(files: FileList | File[], autoAdd: boolean) {
  const list = [...files].filter((f) => ACCEPT.test(f.type) || EXT.test(f.name));
  const s = getEditor();
  if (!list.length) {
    s.notify('Formato não suportado.', 'error');
    return;
  }
  await Promise.all(
    list.map(async (file) => {
      const entry: UploadProgress = { name: file.name, progress: 0 };
      uploads.push(entry);
      emit();
      try {
        const m = await mediaApi.upload(file, (f) => {
          entry.progress = f;
          emit();
        });
        getEditor().upsertMedia(m);
        uploads = uploads.filter((u) => u !== entry);
        emit();
        const ready = await waitReady(m.id);
        if (ready.status === 'error') {
          getEditor().notify(`${file.name}: ${ready.error ?? 'falha no processamento'}`, 'error');
        } else if (autoAdd) {
          addMedia(ready);
        }
      } catch (e) {
        uploads = uploads.filter((u) => u !== entry);
        emit();
        getEditor().notify(`${file.name}: ${(e as Error).message}`, 'error');
      }
    }),
  );
}

export async function refreshBrand() {
  const brand = await mediaApi.brand();
  const s = getEditor();
  const media = Object.fromEntries(Object.entries(s.media).filter(([, m]) => !m.brand));
  for (const b of brand) media[b.id] = b;
  s.set('media', media);
}

export async function loadAllMedia() {
  const [lib, brand] = await Promise.all([mediaApi.list(), mediaApi.brand().catch(() => [] as MediaAsset[])]);
  getEditor().setMedia([...lib, ...brand]);
  // retoma o acompanhamento de arquivos ainda em processamento
  for (const m of lib) if (m.status === 'processing') void waitReady(m.id);
}

/**
 * Som do encerramento (embutido no app). Na primeira vez é enviado para a
 * biblioteca de mídia; depois reaproveita o mesmo arquivo.
 */
export async function ensureOutroAudio(): Promise<MediaAsset> {
  const KEY = 'pn-outro-media-v2';
  const s = getEditor();
  let cachedId: string | null = null;
  try {
    cachedId = localStorage.getItem(KEY);
  } catch {
    /* sem armazenamento */
  }
  const cached = cachedId ? s.media[cachedId] : undefined;
  if (cached && cached.status === 'ready') return cached;
  const { default: url } = await import('../assets/pn-encerramento.m4a');
  const blob = await (await fetch(url)).blob();
  const file = new File([blob], 'encerramento-primeiras-noticias-v2.m4a', { type: 'audio/mp4' });
  const m = await mediaApi.upload(file);
  getEditor().upsertMedia(m);
  const ready = await waitReady(m.id);
  try {
    localStorage.setItem(KEY, ready.id);
  } catch {
    /* sem armazenamento */
  }
  return ready;
}
