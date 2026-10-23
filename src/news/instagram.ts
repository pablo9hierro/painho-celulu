/**
 * Publicação no Instagram pela API oficial (Graph API, conta Profissional
 * ligada a uma Página do Facebook). Reels por ENVIO DIRETO do arquivo
 * ("resumable upload"): não precisa hospedar o vídeo em lugar nenhum.
 *
 * Também lê o que alimenta o aprendizado: desempenho de cada post e o horário
 * em que os seguidores estão online.
 *
 * Mesma lógica no PC, no app e na automação; só o transporte muda.
 */
export const IG_API = 'https://graph.facebook.com/v21.0';
/** token do Login do Instagram (IGAA...) usa graph.instagram.com; o da Página do Facebook (EAA...), graph.facebook.com */
export const base = (c: { token: string }) => (c.token.startsWith('IG') ? 'https://graph.instagram.com/v21.0' : IG_API);

export interface IgHttp {
  /** GET que devolve JSON */
  get(url: string): Promise<unknown>;
  /** POST de formulário que devolve JSON */
  post(url: string, params: Record<string, string>): Promise<unknown>;
  /** envio dos bytes do vídeo (rupload) */
  upload(url: string, headers: Record<string, string>, data: Uint8Array): Promise<unknown>;
}

export interface IgConfig {
  userId: string;
  token: string;
}

type IgErr = { error?: { code?: number; message?: string } };

function check<T>(j: unknown): T {
  const e = (j as IgErr)?.error;
  if (e) throw new Error(`Instagram [${e.code ?? '?'}]: ${e.message ?? 'erro'}`);
  return j as T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** O container precisa ficar FINISHED antes de publicar (senão: erro 9007). */
async function waitContainer(http: IgHttp, c: IgConfig, id: string, timeoutMs: number, log?: (m: string) => void) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const j = check<{ status_code?: string; status?: string }>(await http.get(`${base(c)}/${id}?fields=status_code,status&access_token=${encodeURIComponent(c.token)}`));
    if (j.status_code === 'FINISHED') return;
    if (j.status_code === 'ERROR') throw new Error(`O Instagram não conseguiu processar o vídeo: ${j.status ?? 'erro'}`);
    if (j.status_code === 'EXPIRED') throw new Error('O envio expirou antes de publicar.');
    log?.(`Instagram processando o vídeo (${j.status_code ?? '...'})`);
    await sleep(5000);
  }
  throw new Error('O Instagram demorou demais para processar o vídeo.');
}

/** criação do container é instável do lado do Instagram: tenta algumas vezes */
async function retry<T>(fn: () => Promise<T>, log?: (m: string) => void, n = 5): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= n) throw e;
      log?.(`Tentativa ${i}/${n} falhou (${(e as Error).message}); tentando de novo...`);
      await sleep(3000 * i);
    }
  }
}

/** @perfil → "perfil" (até 3, como o Instagram permite) */
export function collabUsernames(list: string): string[] {
  return [...new Set(list.split(/[\s,;]+/).map((x) => x.trim().replace(/^@/, '').toLowerCase()).filter((x) => /^[a-z0-9._]{1,30}$/.test(x)))].slice(0, 3);
}

/** Publica um Reel enviando o próprio arquivo MP4. Devolve o id do post. */
export async function publishReel(
  http: IgHttp,
  c: IgConfig,
  video: Uint8Array,
  caption: string,
  opts: { coverAtMs?: number; shareToFeed?: boolean; log?: (m: string) => void; /** convite de collab (usernames sem @) */ collaborators?: string[]; /** nome do áudio original */ audioName?: string } = {},
): Promise<{ id: string; containerId: string; collab: string[] }> {
  if (!c.userId || !c.token) throw new Error('Configure o ID da conta e o token do Instagram.');
  const log = opts.log;
  const create = (collab: string[]) =>
    retry(
      async () =>
        check<{ id: string; uri?: string }>(
          await http.post(`${base(c)}/${c.userId}/media`, {
            media_type: 'REELS',
            upload_type: 'resumable',
            caption: caption.slice(0, 2200),
            share_to_feed: opts.shareToFeed === false ? 'false' : 'true',
            ...(opts.coverAtMs !== undefined ? { thumb_offset: String(Math.round(opts.coverAtMs)) } : {}),
            // convite de collab: a outra conta aceita no app dela e o Reel aparece nos dois perfis
            ...(collab.length ? { collaborators: JSON.stringify(collab) } : {}),
            ...(opts.audioName ? { audio_name: opts.audioName.slice(0, 80) } : {}),
            access_token: c.token,
          }),
        ),
      log,
      // com convite de collab, erro de convite não melhora tentando de novo
      collab.length ? 2 : 5,
    );
  let collab = opts.collaborators ?? [];
  let container: { id: string; uri?: string };
  try {
    container = await create(collab);
  } catch (e) {
    if (!collab.length) throw e;
    // a collab não pode derrubar o post: tenta sem o convite
    log?.(`Convite de collab recusado (${(e as Error).message}); postando sem collab.`);
    collab = [];
    container = await create(collab);
  }
  if (collab.length) log?.(`Convite de collab para @${collab.join(', @')}.`);
  log?.(`Container criado (${container.id}); enviando o vídeo (${(video.length / 1048576).toFixed(1)} MB)...`);
  const up = check<{ success?: boolean }>(
    await http.upload(container.uri || `https://rupload.facebook.com/ig-api-upload/v21.0/${container.id}`, { Authorization: `OAuth ${c.token}`, offset: '0', file_size: String(video.length) }, video),
  );
  if (up.success === false) throw new Error('O Instagram recusou o envio do vídeo.');
  await waitContainer(http, c, container.id, 300_000, log);
  const pub = await retry(async () => check<{ id: string }>(await http.post(`${base(c)}/${c.userId}/media_publish`, { creation_id: container.id, access_token: c.token })), log);
  log?.(`Reel publicado (${pub.id}).`);
  return { id: pub.id, containerId: container.id, collab };
}

export async function account(http: IgHttp, c: IgConfig): Promise<{ id: string; username: string; followers_count?: number }> {
  return check(await http.get(`${base(c)}/${c.userId}?fields=id,username,followers_count&access_token=${encodeURIComponent(c.token)}`));
}

/** Desempenho de um post (o que der para ler; métricas indisponíveis ficam de fora). */
export async function mediaInsights(http: IgHttp, c: IgConfig, mediaId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const metric of ['views', 'reach', 'likes', 'comments', 'shares', 'saved']) {
    try {
      const j = check<{ data?: { name: string; values?: { value: number }[]; total_value?: { value: number } }[] }>(await http.get(`${base(c)}/${mediaId}/insights?metric=${metric}&access_token=${encodeURIComponent(c.token)}`));
      const d = j.data?.[0];
      const v = d?.total_value?.value ?? d?.values?.[0]?.value;
      if (typeof v === 'number') out[metric] = v;
    } catch {
      /* métrica não disponível para este tipo de post */
    }
  }
  return out;
}

/**
 * Seguidores online por hora do dia (0–23, horário de Brasília), média dos
 * dias que o Instagram devolver. null se a conta não tiver esse dado.
 */
export async function onlineFollowers(http: IgHttp, c: IgConfig): Promise<number[] | null> {
  try {
    const j = check<{ data?: { values?: { value: Record<string, number> }[] }[] }>(await http.get(`${base(c)}/${c.userId}/insights?metric=online_followers&period=lifetime&access_token=${encodeURIComponent(c.token)}`));
    const vals = j.data?.[0]?.values ?? [];
    const sum = new Array(24).fill(0);
    let n = 0;
    for (const v of vals) {
      if (!v.value || !Object.keys(v.value).length) continue;
      n++;
      // horas em UTC-8 (Pacífico) segundo a documentação da Meta → Brasília (UTC-3) = +5
      for (const [h, count] of Object.entries(v.value)) sum[(Number(h) + 5) % 24] += count;
    }
    return n ? sum.map((x) => x / n) : null;
  } catch {
    return null;
  }
}

/** Renova o token de 60 dias (precisa ainda estar válido). */
export async function refreshToken(http: IgHttp, token: string, appId: string, appSecret: string): Promise<{ access_token: string; expires_in?: number }> {
  return check(await http.get(`${IG_API}/oauth/access_token?grant_type=fb_exchange_token&client_id=${encodeURIComponent(appId)}&client_secret=${encodeURIComponent(appSecret)}&fb_exchange_token=${encodeURIComponent(token)}`));
}

/** Publica um comentário no post (ex.: a descrição de novo). Fixar o comentário não existe na API. */
export async function postComment(http: IgHttp, c: IgConfig, mediaId: string, message: string): Promise<string> {
  const j = check<{ id: string }>(await http.post(`${base(c)}/${mediaId}/comments`, { message: message.slice(0, 2200), access_token: c.token }));
  return j.id;
}
