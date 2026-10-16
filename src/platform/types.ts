/** Contratos de plataforma. A UI React só conhece estas interfaces. */
import type { MediaAsset, Project } from '../core/model';

export interface ProjectSummary {
  id: string;
  name: string;
  format: Project['format'];
  thumb: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExportSettings {
  width: number;
  height: number;
  fps: number;
  duration: number;
  /** 14 (alta) … 28 (leve) */
  crf: number;
}

export interface ExportProgress {
  phase: 'preparing' | 'rendering' | 'encoding' | 'done';
  frame: number;
  total: number;
  fps: number;
}

export interface ProjectStore {
  list(): Promise<ProjectSummary[]>;
  get(id: string): Promise<Project>;
  create(p: Project): Promise<void>;
  save(p: Project, thumb?: string | null): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface MediaService {
  list(): Promise<MediaAsset[]>;
  get(id: string): Promise<MediaAsset>;
  upload(file: File, onProgress?: (f: number) => void): Promise<MediaAsset>;
  remove(id: string): Promise<void>;
  brand(): Promise<MediaAsset[]>;
  uploadBrand(file: File): Promise<void>;
  /** exclui uma imagem de marca enviada pelo usuário */
  removeBrand(id: string): Promise<void>;
  waveform(url: string): Promise<{ perSec: number; peaks: number[] }>;
}

/** Gera o MP4 final e devolve o arquivo pronto para ir à memória do aparelho. */
export interface Exporter {
  exportVideo(
    project: Project,
    media: Record<string, MediaAsset>,
    settings: ExportSettings,
    onProgress: (p: ExportProgress) => void,
    signal: AbortSignal,
  ): Promise<{ blob: Blob; fileName: string }>;
}

/** Armazenamento do DISPOSITIVO (Downloads/Documentos do PC ou do celular). */
export interface DeviceStorage {
  /** salva e devolve uma descrição de onde ficou */
  saveVideo(blob: Blob, fileName: string): Promise<string>;
  /** abre o menu de compartilhar do sistema (só no app nativo) */
  share?(fileName: string): Promise<void>;
}

export function exportFileName(projectName: string): string {
  const slug =
    projectName
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase()
      .slice(0, 60) || 'video';
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  return `${slug}-${stamp}.mp4`;
}
