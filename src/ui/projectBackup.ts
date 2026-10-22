/**
 * Cópia de segurança INSTANTÂNEA do projeto aberto. Quando o app vai para o
 * segundo plano ou fecha, o salvamento normal (IndexedDB/servidor) pode ser
 * interrompido no meio; esta cópia é gravada na hora (localStorage, síncrono)
 * e, ao reabrir, é usada se ainda existir — nenhuma edição se perde.
 * Ela é apagada assim que o salvamento normal termina.
 */
import { ProjectSchema, type Project } from '../core/model';

const key = (id: string) => `pn-backup-${id}`;

export function writeBackup(p: Project) {
  try {
    localStorage.setItem(key(p.id), JSON.stringify(p));
  } catch {
    /* armazenamento cheio/indisponível: segue só com o salvamento normal */
  }
}

export function clearBackup(id: string) {
  try {
    localStorage.removeItem(key(id));
  } catch {
    /* nada */
  }
}

/** Cópia pendente deste projeto (validada); null se não houver. */
export function readBackup(id: string): Project | null {
  try {
    const raw = localStorage.getItem(key(id));
    if (!raw) return null;
    const parsed = ProjectSchema.safeParse(JSON.parse(raw));
    return parsed.success && parsed.data.id === id ? parsed.data : null;
  } catch {
    return null;
  }
}
