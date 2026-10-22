/**
 * Arquivo original de uma mídia como Blob, sem copiar para a memória:
 * - no app (modo local) vem direto do IndexedDB (guardado em disco);
 * - no PC (servidor) é baixado do servidor local.
 * Leituras parciais (`Blob.slice`) permitem trabalhar com vídeos longos.
 */
import type { MediaAsset } from '../core/model';
import { idbGet } from './local/idb';

const cache = new Map<string, Promise<Blob>>();

export function mediaBlob(m: MediaAsset): Promise<Blob> {
  const hit = cache.get(m.id);
  if (hit) return hit;
  const p = (async () => {
    if (m.url.startsWith('blob:')) {
      try {
        const b = await idbGet<Blob>('blobs', m.id);
        if (b) return b;
      } catch {
        /* cai para o fetch */
      }
    }
    return (await fetch(m.url)).blob();
  })();
  // não guarda falhas (permite tentar de novo)
  p.catch(() => cache.delete(m.id));
  cache.set(m.id, p);
  if (cache.size > 24) cache.delete(cache.keys().next().value!);
  return p;
}
