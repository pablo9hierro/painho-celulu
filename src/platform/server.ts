/**
 * Plataforma "servidor local" (PC): API Node em 127.0.0.1 com SQLite e FFmpeg.
 */
import type { ExportSettings, Exporter, MediaService, ProjectStore } from './types';
import { runExport } from '../engine/exporter';

export interface ExportInfo {
  id: string;
  projectId: string;
  status: 'rendering' | 'mixing' | 'done' | 'delivered' | 'error' | 'cancelled';
  progress: number;
  fileName: string | null;
  filePath: string | null;
  error: string | null;
  settings: ExportSettings;
  createdAt: string;
  finishedAt: string | null;
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new Error('Sem conexão com o servidor local. Ele está rodando? (npm run dev)');
  }
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) msg = body.error;
    } catch {
      /* corpo não-JSON */
    }
    throw new Error(msg);
  }
  const ct = res.headers.get('content-type') ?? '';
  return (ct.includes('json') ? res.json() : res.text()) as Promise<T>;
}

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const serverProjects: ProjectStore = {
  list: () => req('/api/projects'),
  get: (id) => req(`/api/projects/${id}`),
  create: async (p) => {
    await req('/api/projects', jsonInit('POST', p));
  },
  save: async (p, thumb) => {
    await req(`/api/projects/${p.id}`, jsonInit('PUT', { project: p, thumb }));
  },
  remove: async (id) => {
    await req(`/api/projects/${id}`, { method: 'DELETE' });
  },
};

/** Upload com progresso (XHR, porque fetch não reporta progresso de envio). */
function uploadXhr<T>(url: string, file: File, onProgress?: (f: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', url);
    x.setRequestHeader('Content-Type', 'application/octet-stream');
    x.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    x.onload = () => {
      try {
        const body = JSON.parse(x.responseText || '{}') as T & { error?: string };
        if (x.status >= 200 && x.status < 300) resolve(body);
        else reject(new Error(body.error ?? `Falha no envio (${x.status})`));
      } catch {
        reject(new Error(`Falha no envio (${x.status})`));
      }
    };
    x.onerror = () => reject(new Error('Sem conexão com o servidor local.'));
    x.send(file);
  });
}

export const serverMedia: MediaService = {
  list: () => req('/api/media'),
  get: (id) => req(`/api/media/${id}`),
  upload: (file, onProgress) => uploadXhr(`/api/media?name=${encodeURIComponent(file.name)}`, file, onProgress),
  remove: async (id) => {
    await req(`/api/media/${id}`, { method: 'DELETE' });
  },
  brand: () => req('/api/brand'),
  uploadBrand: async (file) => {
    await uploadXhr(`/api/brand?name=${encodeURIComponent(file.name)}`, file);
  },
  removeBrand: async (id) => {
    await req(`/api/brand/${encodeURIComponent(id.replace(/^brand:/, ''))}`, { method: 'DELETE' });
  },
  waveform: (url) => req(url),
};

/** API de baixo nível da exportação via FFmpeg (usada por engine/exporter.ts). */
export const exportsApi = {
  start: (p: unknown, s: ExportSettings) => req<{ id: string; totalFrames: number }>('/api/exports', jsonInit('POST', { project: p, settings: s })),
  pushFrames: async (id: string, frames: Blob[]) => {
    const body = new Blob(frames, { type: 'application/octet-stream' });
    await req(`/api/exports/${id}/frames`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Frame-Count': String(frames.length) },
      body,
    });
  },
  finish: (id: string) => req<{ file: string }>(`/api/exports/${id}/finish`, { method: 'POST' }),
  cancel: async (id: string) => {
    await req(`/api/exports/${id}`, { method: 'DELETE' });
  },
  list: (projectId?: string) => req<ExportInfo[]>(`/api/exports${projectId ? `?projectId=${projectId}` : ''}`),
  fetchFile: async (id: string) => {
    const res = await fetch(`/api/exports/${id}/file?inline=1`);
    if (!res.ok) throw new Error('Não foi possível obter o vídeo exportado.');
    return res.blob();
  },
  discard: async (id: string) => {
    await req(`/api/exports/${id}/file`, { method: 'DELETE' });
  },
};

export const serverExporter: Exporter = {
  async exportVideo(project, media, settings, onProgress, signal) {
    const r = await runExport(project, media, settings, onProgress, signal);
    const blob = await exportsApi.fetchFile(r.id);
    // a cópia interna do app é apagada: o vídeo vai só para a memória do aparelho
    await exportsApi.discard(r.id).catch(() => undefined);
    return { blob, fileName: r.file };
  },
};

export async function serverHealth(): Promise<{ ok: boolean; ffmpeg: string | null; error: string | null }> {
  return req('/api/health');
}
