/**
 * Antes de qualquer upload de imagem: se for uma imagem sem transparência com
 * fundo liso (logo que virou JPG com fundo branco), remove o fundo e envia um
 * PNG transparente. Fotos e PNGs que já são transparentes passam intactos.
 */
import { removeFlatBackground, type CutoutOptions } from '../core/cutout';
import type { MediaService } from './types';

const IMAGE = /^image\/(jpeg|png|webp|bmp)$/;
const IMAGE_EXT = /\.(jpe?g|png|webp|bmp)$/i;
/** maior lado processado (logos não precisam de mais que isso) */
const MAX_SIDE = 2400;

async function decode(file: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/** Devolve o mesmo arquivo ou um PNG com o fundo liso removido. */
export async function cutoutImage(file: File, opts?: CutoutOptions): Promise<File> {
  if (!(IMAGE.test(file.type) || IMAGE_EXT.test(file.name))) return file;
  try {
    const img = await decode(file);
    const k = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * k));
    const h = Math.max(1, Math.round(img.naturalHeight * k));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h);
    if (!removeFlatBackground(data.data, w, h, opts)) return file;
    ctx.putImageData(data, 0, 0);
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'));
    if (!blob) return file;
    const name = (file.name || 'imagem').replace(/\.[^.]+$/, '') + '.png';
    return new File([blob], name, { type: 'image/png', lastModified: Date.now() });
  } catch {
    return file; // na dúvida, envia o original
  }
}

/** Envolve o serviço de mídia: todo upload de imagem passa pela remoção de fundo. */
export function withCutout(svc: MediaService): MediaService {
  return {
    ...svc,
    upload: async (file, onProgress) => svc.upload(await cutoutImage(file), onProgress),
    uploadBrand: async (file) => svc.uploadBrand(await cutoutImage(file)),
  };
}
