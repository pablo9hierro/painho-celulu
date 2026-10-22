/**
 * Leva os tons cadastrados no app (áudios + nomes + dica) para a automação:
 * grava no branch de dados do repositório (autopost-dados/tons/...) pela API do
 * GitHub. O cron lê de lá e escolhe a trilha pelo tom que a IA identificou.
 * Igual no PC e no app (só usa fetch).
 */
import type { Tone } from './tones';

export interface GithubCfg {
  /** dono/repositório, ex.: pablo9hierro/painho-celulu */
  repo: string;
  /** token do GitHub com permissão de escrever no repositório (Contents: write) */
  token: string;
  branch?: string;
}

export const TONES_INDEX = 'tons/tons.json';
const BRANCH = 'autopost-dados';

const b64 = (d: Uint8Array) => {
  let s = '';
  for (let i = 0; i < d.length; i += 0x8000) s += String.fromCharCode(...d.subarray(i, i + 0x8000));
  return btoa(s);
};
const safe = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w .()-]+/g, '').trim().replace(/\s+/g, ' ') || 'sem-nome';

async function gh(cfg: GithubCfg, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`https://api.github.com/repos/${cfg.repo}/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(init?.headers ?? {}) },
  });
}

/** garante o branch de dados (cria a partir do principal se ainda não existir) */
async function ensureBranch(cfg: GithubCfg, branch: string) {
  const r = await gh(cfg, `git/ref/heads/${branch}`);
  if (r.ok) return;
  const repo = (await (await gh(cfg, '')).json()) as { default_branch?: string; message?: string };
  if (!repo.default_branch) throw new Error(`GitHub: ${repo.message ?? 'repositório não encontrado'}`);
  const base = (await (await gh(cfg, `git/ref/heads/${repo.default_branch}`)).json()) as { object?: { sha: string } };
  const c = await gh(cfg, 'git/refs', { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: base.object!.sha }) });
  if (!c.ok) throw new Error(`GitHub: não consegui criar o branch ${branch} (${c.status})`);
}

async function putFile(cfg: GithubCfg, branch: string, path: string, content: Uint8Array, message: string) {
  const cur = await gh(cfg, `contents/${encodeURI(path)}?ref=${branch}`);
  const sha = cur.ok ? ((await cur.json()) as { sha?: string }).sha : undefined;
  const r = await gh(cfg, `contents/${encodeURI(path)}`, { method: 'PUT', body: JSON.stringify({ message, content: b64(content), branch, ...(sha ? { sha } : {}) }) });
  if (!r.ok) throw new Error(`GitHub recusou ${path} (${r.status}: ${((await r.json().catch(() => ({}))) as { message?: string }).message ?? ''})`);
}

export interface SyncedTrack {
  tom: string;
  nome: string;
  arquivo: string;
}

/**
 * Envia os tons. `readAudio` devolve os bytes de um áudio da biblioteca.
 * O índice tons.json diz ao cron quais tons/áudios valem (os tirados do app somem dali).
 */
export async function syncTones(cfg: GithubCfg, tones: Tone[], readAudio: (mediaId: string) => Promise<{ data: Uint8Array; ext: string }>, onProgress?: (m: string) => void): Promise<{ enviados: number; indice: SyncedTrack[] }> {
  const branch = cfg.branch || BRANCH;
  if (!cfg.repo || !cfg.token) throw new Error('Configure o repositório e o token do GitHub para enviar os tons à automação.');
  await ensureBranch(cfg, branch);
  const indice: SyncedTrack[] = [];
  let enviados = 0;
  for (const t of tones.filter((x) => x.name.trim() && x.tracks.length)) {
    for (const k of t.tracks) {
      const { data, ext } = await readAudio(k.mediaId);
      const arquivo = `tons/${safe(t.name)}/${safe(k.name)}.${ext}`;
      onProgress?.(`Enviando "${k.name}" (${t.name})…`);
      await putFile(cfg, branch, arquivo, data, `Tons: ${t.name} / ${k.name}`);
      indice.push({ tom: t.name.trim(), nome: k.name.trim(), arquivo });
      enviados++;
    }
  }
  const dicas = Object.fromEntries(tones.map((t) => [t.name.trim(), t.hint.trim()]));
  await putFile(cfg, branch, TONES_INDEX, new TextEncoder().encode(JSON.stringify({ atualizado: new Date().toISOString(), dicas, audios: indice }, null, 1)), 'Tons: índice');
  return { enviados, indice };
}
