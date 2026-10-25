/**
 * POSTADOR NO CELULAR (só no app; o web é só para ver antes do APK).
 * Um botão só: automático ligado ou desligado. Ligado, faz DUAS coisas separadas:
 *
 *  BLOG — de manhã (a partir das 7h) captura as notícias e publica DE UMA VEZ o
 *  lote do dia: as melhores pautas inéditas (que ainda não estão no site).
 *
 *  INSTAGRAM — nos horários de pico dos seguidores, olha as matérias publicadas
 *  no blog (as do app e as da redação) e posta como Reels SÓ a que teve melhor
 *  desempenho (visualizações por hora desde que saiu). Também dá para escolher
 *  uma matéria da lista e postar na mão.
 *
 * Tudo roda numa FILA fora da tela: navegar pelo app ou sair dele não para o
 * trabalho (no celular o serviço nativo segura o app acordado e mostra o passo
 * na notificação). Cada passo aparece na hora em "O que está fazendo".
 */
import { capturePautas, extractBlocks, sameStory, type Pauta } from './pautas';
import { cachedTrends } from './trends';
import { aiChat } from './openrouter';
import { writeStory } from './writer';
import { withTrendingHashtags } from './hashtags';
import { styleCaption } from './unicodeStyle';
import { listNews, siteActiveUsers, type SiteNews } from './websg';
import { mediaInsights, onlineFollowers, collabUsernames, postComment, publishReel } from './instagram';
import { cidadeDoTitulo, NOTA_MINIMA, notas, ordenar } from './igPick';
import { keyEngagementWord, reorderByIgHeat } from './igEngagement';
import { brt, learnedBoost, measure, normalizeState, postingSlots, recordActive, recordViews, report, type LearnState } from './learning';
import { loadTones, noteTrackUse, resolveTone, TRECHO_S } from './tones';
import { ensureDefaultTones } from './defaultTones';
import { maintainTokens } from './igToken';
import { getAiKey, nativeHttp, nativePost } from './client';
import { siteList, getIgConfig, getSiteConfig, nativeIgHttp, nativePautaHttp, nativeSiteHttp, setIgConfig, withBase } from './postadorClient';
import { blogPublicadasHoje, firstPhoto, loadQueue, morePhotos, postToBlog } from './blogPost';
import { videoTexts } from './videoTexts';
import { censorCaption } from './censor';
import { releases } from './release';
import { downloadFromLink } from './downloadClient';
import { createStoryVideo } from '../ui/storyVideo';
import { exporter, media as mediaApi, projects } from '../platform/api';
import { postadorNative } from '../platform/postadorNative';
import { projectDuration } from '../core/timeline';
import type { MediaAsset } from '../core/model';

// ---------------------------------------------------------------- configuração e estado (no aparelho)

export interface AutoConfig {
  /** automático ligado (lote do blog de manhã + Instagram nos picos) */
  ativo: boolean;
}
const CFG_KEY = 'pn-autopost-cfg';
const ST_KEY = 'pn-autopost-state';
const BLOG_KEY = 'pn-autopost-blog';
const LOG_KEY = 'pn-autopost-log';
const GAP_KEY = 'pn-ig-proximo';
/** intervalo sorteado entre Reels automáticos (ms): 3 a 5 min */
export const igGapMs = (rnd = Math.random()) => Math.round((3 + rnd * 2) * 60_000);

/** blog: lote da manhã a partir das 7h (tenta até 12h se algo falhar) */
export const BLOG_HOUR = 6;
const BLOG_UNTIL = 12;
/** quantas matérias o lote da manhã publica */
export const BLOG_LOTE = 10;
const BLOG_RETRY_MIN = 20;
const MAX_AGE_H = 12;
/** Instagram: depois do horário, continua tentando por 1h30 (até 3 vezes) */
const WINDOW_MIN = 90;
const MAX_TRIES = 3;
/** até 2 Reels por horário de pico (se tiver matéria boa o bastante pros dois) */
const SLOT_CAP = 2;
/** Instagram automático: no máximo 8 Reels por dia, espalhados (picos + a cada ~1h40 das 8h às 22h) */
export const IG_MAX_DIA = 8;

export function getAutoConfig(): AutoConfig {
  try {
    const c = JSON.parse(localStorage.getItem(CFG_KEY) ?? '{}') as Partial<AutoConfig>;
    return { ativo: c.ativo === true };
  } catch {
    return { ativo: false };
  }
}
export function setAutoConfig(c: AutoConfig) {
  try {
    localStorage.setItem(CFG_KEY, JSON.stringify({ ativo: c.ativo }));
  } catch {
    /* sem armazenamento */
  }
}
export function loadState(): LearnState {
  try {
    return normalizeState(JSON.parse(localStorage.getItem(ST_KEY) ?? 'null'));
  } catch {
    return normalizeState(null);
  }
}
function saveState(st: LearnState) {
  try {
    localStorage.setItem(ST_KEY, JSON.stringify(st));
  } catch {
    /* sem armazenamento */
  }
}
function readJson<T>(k: string, d: T): T {
  try {
    return { ...d, ...(JSON.parse(localStorage.getItem(k) ?? '{}') as T) };
  } catch {
    return d;
  }
}
function writeJson(k: string, v: unknown) {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* sem armazenamento */
  }
}

/** controle do lote do blog no dia */
export interface BlogCtl {
  lastTry: string | null;
  day: string;
  count: number;
  /** acabaram as pautas boas do dia (ou o lote foi completado) */
  done: boolean;
}
const emptyCtl = (): BlogCtl => ({
  lastTry: null,
  day: '',
  count: 0,
  done: false,
});

// ---------------------------------------------------------------- status ao vivo

export interface AutoStatus {
  /** o que está rodando agora (null = parado) */
  job: string | null;
  step: string;
  /** 0..1 quando dá para medir (montagem do vídeo) */
  pct: number | null;
  /** o que está esperando na fila */
  queue: string[];
  last: { ok: boolean; msg: string; at: string } | null;
}
let status: AutoStatus = {
  job: null,
  step: '',
  pct: null,
  queue: [],
  last: null,
};
const listeners = new Set<(s: AutoStatus) => void>();
export function getAutopostStatus(): AutoStatus {
  return status;
}
export function onAutopostStatus(fn: (s: AutoStatus) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
let lastAviso = 0;
function setStatus(p: Partial<AutoStatus>) {
  status = { ...status, ...p };
  for (const l of listeners) l(status);
  // notificação do celular: o passo atual (sem inundar o sistema)
  if (status.job && Date.now() - lastAviso > 1500) {
    lastAviso = Date.now();
    void postadorNative.aviso(`${status.job}: ${status.step}${status.pct !== null ? ` ${Math.round(status.pct * 100)}%` : ''}`);
  }
}

function liveLog(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(LOG_KEY) ?? '[]') as string[];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
/** registra NA HORA (aparece na tela enquanto trabalha) */
const log = (st: LearnState | null, m: string) => {
  const line = `${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} ${m}`;
  if (st) st.log = [...st.log, line].slice(-300);
  writeJson(LOG_KEY, [...liveLog(), line].slice(-200));
  console.log('[postador]', m);
  setStatus({ step: m.replace(/^(Blog|Instagram): /, '') });
};

// ---------------------------------------------------------------- horários

/** Horário do Instagram em aberto: começou há pouco (até 1h30), não foi usado e ainda tem tentativa. */
export function openSlot(st: LearnState, now: Date, tries: Record<string, number>): string | null {
  const { slots } = postingSlots(st);
  const { h, m, day } = brt(now);
  const nowMin = h * 60 + m;
  for (const s of slots) {
    const [hh, mm] = s.split(':').map(Number);
    const t = hh! * 60 + mm!;
    const key = `${day} ${s}`;
    const usos = st.slotsUsed.filter((x) => x === key).length;
    if (nowMin >= t - 5 && nowMin <= t + WINDOW_MIN && usos < SLOT_CAP && (tries[key] ?? 0) < MAX_TRIES) return key;
  }
  return null;
}

/** Hora do lote do blog? (das 7h às 12h, uma vez por dia; se parou no meio, continua 20 min depois) */
export function blogDue(ctl: BlogCtl, now: Date): boolean {
  const { h, day } = brt(now);
  if (h < BLOG_HOUR || h >= BLOG_UNTIL) return false;
  if (ctl.day === day && (ctl.done || ctl.count >= BLOG_LOTE)) return false;
  const since = ctl.lastTry ? (now.getTime() - new Date(ctl.lastTry).getTime()) / 60_000 : Infinity;
  return ctl.day !== day || since >= BLOG_RETRY_MIN;
}

/**
 * Melhor matéria do blog para o Instagram: das publicadas nas últimas 24 h
 * (com pelo menos 1 h no ar para os números valerem), que ainda não foram ao
 * Instagram, a de mais visualizações por hora.
 */
export function rankForInstagram(list: SiteNews[], postedSiteIds: Set<number>, now: Date): { item: SiteNews; perHour: number }[] {
  return list
    .filter((n) => n.date && typeof n.views === 'number' && !postedSiteIds.has(n.id) && !/revis|inativ|agend/i.test(n.status ?? ''))
    .map((n) => ({ item: n, age: (now.getTime() - new Date(n.date!).getTime()) / 3600_000 }))
    .filter((x) => x.age >= 1 && x.age <= 24)
    .map((x) => ({ item: x.item, perHour: x.item.views! / Math.max(1, x.age) }))
    .sort((a, b) => b.perHour - a.perHour);
}

/** vídeos da matéria que dá para baixar (arquivo ou Instagram; YouTube não) */
function articleVideos(html: string, url: string): string[] {
  return extractBlocks(html, url)
    .blocks.filter((b) => b.type === 'video' && b.src && (b.kind === 'arquivo' || b.kind === 'instagram'))
    .map((b) => b.src!);
}

export function bestForInstagram(list: SiteNews[], postedSiteIds: Set<number>, now: Date): { item: SiteNews; perHour: number } | null {
  const scored = list
    .filter((n) => n.date && typeof n.views === 'number' && !postedSiteIds.has(n.id) && !/revis|inativ|agend/i.test(n.status ?? ''))
    .map((n) => ({
      item: n,
      age: (now.getTime() - new Date(n.date!).getTime()) / 3600_000,
    }))
    .filter((x) => x.age >= 1 && x.age <= 24)
    .map((x) => ({ item: x.item, perHour: x.item.views! / Math.max(1, x.age) }))
    .sort((a, b) => b.perHour - a.perHour);
  return scored[0] ?? null;
}

// ---------------------------------------------------------------- vídeo no próprio celular

/** o MP4 tem faixa de áudio AAC? (o Instagram só aceita AAC) */
export function hasAacAudio(mp4: Uint8Array): boolean {
  for (let i = 0; i + 3 < mp4.length; i++) if (mp4[i] === 0x6d && mp4[i + 1] === 0x70 && mp4[i + 2] === 0x34 && mp4[i + 3] === 0x61) return true;
  return false;
}

/** Monta e grava o vídeo. `cleanup` apaga do aparelho o projeto, a foto e o vídeo (a música fica para os próximos). */
async function renderVideo(input: Parameters<typeof createStoryVideo>[0]): Promise<{ bytes: Uint8Array; cleanup: () => Promise<void> }> {
  setStatus({ step: 'Montando o vídeo (foto, moldura e música)…', pct: null });
  const id = await createStoryVideo(input);
  const p = await projects.get(id);
  const temp = [...new Set(p.clips.filter((c) => c.type === 'image' || c.type === 'video').map((c) => (c as { mediaId: string }).mediaId))];
  const cleanup = async () => {
    await projects.remove(id).catch(() => undefined);
    for (const m of temp) await mediaApi.remove(m).catch(() => undefined);
  };
  try {
    if (!p.clips.some((c) => c.type === 'audio')) throw new Error('o vídeo ficou sem música; não foi postado');
    const ids = [...new Set(p.clips.map((c) => ('mediaId' in c ? (c as { mediaId: string }).mediaId : '')).filter(Boolean))];
    const media: Record<string, MediaAsset> = {};
    for (const m of ids) media[m] = await mediaApi.get(m);
    const { blob } = await exporter.exportVideo(
      p,
      media,
      {
        width: p.width,
        height: p.height,
        fps: 30,
        duration: projectDuration(p),
        crf: 20,
      },
      (pr) =>
        setStatus({
          step: 'Gravando o vídeo',
          pct: pr.total ? Math.min(1, pr.frame / pr.total) : null,
        }),
      new AbortController().signal,
    );
    setStatus({ pct: null });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    // nunca posta mudo: confere a faixa de áudio no arquivo final
    if (!hasAacAudio(bytes)) throw new Error('o vídeo saiu sem áudio AAC neste aparelho; não foi postado');
    return { bytes, cleanup };
  } catch (e) {
    await cleanup();
    throw e;
  }
}

// ---------------------------------------------------------------- estatística

async function stats(st: LearnState, now: Date, pages = 2): Promise<SiteNews[]> {
  setStatus({ step: 'Lendo o painel do site…' });
  const site = withBase(getSiteConfig());
  let list: SiteNews[] = [];
  const views = new Map<number, number>();
  if (site.user && site.pass) {
    try {
      list = await listNews(nativeSiteHttp, site, pages);
      recordViews(st, now, list);
      for (const n of list) if (typeof n.views === 'number') views.set(n.id, n.views);
      const ga = await siteActiveUsers(nativeSiteHttp, site).catch(() => null);
      if (ga) recordActive(st, now, ga.users);
    } catch (e) {
      log(st, `Painel do site indisponível: ${(e as Error).message}`);
    }
  } else log(st, 'Sem usuário/senha do site em ⚙ Configurações.');
  const ig = getIgConfig();
  const token = ig.fbToken || ig.igToken;
  const igViews = new Map<string, number>();
  if (token && ig.userId) {
    const cfg = { userId: ig.userId, token };
    if (!st.igHourAt || now.getTime() - new Date(st.igHourAt).getTime() > 20 * 3600_000) {
      const h = await onlineFollowers(nativeIgHttp, cfg).catch(() => null);
      if (h) {
        st.igHour = h;
        st.igHourAt = now.toISOString();
      }
    }
    for (const s of st.stories.filter((x) => x.igId && !x.measuredAt && now.getTime() - new Date(x.postedAt).getTime() > 36 * 3600_000).slice(0, 10)) {
      const m = await mediaInsights(nativeIgHttp, cfg, s.igId!).catch(() => ({}) as Record<string, number>);
      const v = m.views ?? m.reach;
      if (typeof v === 'number') igViews.set(s.igId!, v);
    }
  }
  const n = measure(st, now, views, igViews);
  if (n) log(st, `Aprendizado: desempenho de ${n} matéria(s) medido.`);
  return list;
}

// ---------------------------------------------------------------- BLOG: lote da manhã

/** Publica até `max` pautas inéditas, uma depois da outra (cada uma conta na hora). */
export async function blogBatch(st: LearnState, sitePosts: SiteNews[], max: number, ctl?: BlogCtl): Promise<number> {
  let trending: string[] = [];
  try {
    const t = await cachedTrends(nativeHttp, 600_000);
    trending = [...t.searches.map((s) => s.term), ...t.hashtags.map((h) => h.tag)];
  } catch {
    /* sem trends */
  }
  setStatus({ step: 'Capturando as notícias de agora…' });
  const pautas = await capturePautas(nativePautaHttp, {
    window: '1d',
    trending,
    maxAgeHours: MAX_AGE_H,
  });
  const onSite = [...sitePosts.map((n) => n.title), ...loadQueue().map((q) => q.story.titulo), ...loadQueue().map((q) => q.pautaTitulo)];
  const fresh = pautas
    .filter((p) => p.readable && p.paragraphs >= 3 && p.imagesOk >= 1)
    // não repete o que já está no site (do app ou da redação)
    .filter((p) => !onSite.some((t) => sameStory(t, p.title)) && !loadQueue().some((q) => q.pautaUrl === p.url))
    .map((p) => ({
      p,
      score: p.score + learnedBoost(st, { title: p.title, city: p.city }).pts,
    }))
    .sort((a, b) => b.score - a.score);
  // a mesma notícia de dois portais conta uma vez só
  let picks: Pauta[] = [];
  for (const { p } of fresh) if (!picks.some((x) => sameStory(x.title, p.title))) picks.push(p);
  // release de prefeitura/órgão (publicidade disfarçada de notícia) não entra
  setStatus({ step: 'Separando release e nota institucional…' });
  const rel = await releases(
    aiChat(getAiKey(), nativePost),
    picks.slice(0, 30).map((p) => ({ id: p.id, titulo: p.title, texto: p.blocks.filter((b) => b.type === 'p').map((b) => b.text ?? '').join(' ') })),
  );
  if (rel.size) {
    log(st, `Blog: ${rel.size} release(s)/nota(s) institucional(is) descartado(s): ${picks.filter((p) => rel.has(p.id)).map((p) => p.title.slice(0, 40)).join('; ')}`);
    picks = picks.filter((p) => !rel.has(p.id));
  }
  if (!picks.length) {
    log(st, 'Blog: nenhuma notícia nova (até 12 h, com foto) que ainda não esteja no site.');
    if (ctl) ctl.done = true;
    return 0;
  }
  let ok = 0;
  let fails = 0;
  for (const pick of picks) {
    if (ok >= max || fails >= 3) break;
    setStatus({
      step: `Blog ${ok + 1} de ${Math.min(max, picks.length)}: escrevendo "${pick.title.slice(0, 60)}"…`,
    });
    try {
      const r = await postToBlog(pick, {
        onStep: (s) => setStatus({ step: `Blog ${ok + 1}: ${s}` }),
      });
      ok++;
      log(st, `Blog: publicada "${r.story.titulo}"${r.siteId ? ` (nº ${r.siteId})` : ''}.`);
      if (ctl) {
        ctl.count++;
        writeJson(BLOG_KEY, ctl);
      }
    } catch (e) {
      fails++;
      log(st, `Blog: falhou "${pick.title.slice(0, 60)}": ${(e as Error).message}`);
    }
  }
  if (ctl && ok < max && picks.length <= ok + fails) ctl.done = true;
  return ok;
}

// ---------------------------------------------------------------- INSTAGRAM: matéria do blog vira Reels

const pageCache = new Map<string, string>();
const meta = (html: string, p: string) => new RegExp(`<meta[^>]+(?:property|name)=["']${p}["'][^>]*content=["']([^"']*)["']`, 'i').exec(html)?.[1] ?? '';

/** Posta UMA matéria do blog como Reels (a escolhida na mão ou a melhor). */
export async function instagramOnce(st: LearnState, sitePosts: SiteNews[], chosen?: SiteNews): Promise<boolean> {
  const now = new Date();
  const ig = getIgConfig();
  const token = ig.fbToken || ig.igToken;
  if (!token || !ig.userId) {
    log(st, 'Instagram: sem token. Coloque em ⚙ Configurações.');
    return false;
  }
  const chat = aiChat(getAiKey(), nativePost);
  let n = chosen;
  let cidadeEscolhida: string | null = chosen ? cidadeDoTitulo(chosen.title) : null;
  if (!n) {
    const posted = new Set(st.stories.filter((s) => s.igId && s.siteId).map((s) => s.siteId!));
    // publicadas no blog nas últimas 24 h que ainda não foram ao Instagram (sem esperar visualização)
    const cands = sitePosts.filter(
      (x) => !posted.has(x.id) && !/revis|inativ|agend/i.test(x.status ?? '') && (!x.date || now.getTime() - new Date(x.date).getTime() <= 24 * 3600_000),
    );
    if (!cands.length) {
      log(st, 'Instagram: nenhuma matéria nova do blog (últimas 24 h) que ainda não foi ao Instagram.');
      return false;
    }
    // a IA dá nota de impacto/polêmica (só para as que ainda não têm nota)
    setStatus({ step: 'Avaliando impacto e polêmica das matérias…' });
    const ns = await notas(chat, cands);
    const hoje = brt(now).day;
    const cidadesHoje = new Set(st.stories.filter((s) => s.igId && s.city && brt(new Date(s.postedAt)).day === hoje).map((s) => s.city!));
    const fortes = ordenar(cands, ns, cidadesHoje);
    if (!fortes.length) {
      log(st, `Instagram: nada forte o bastante agora (nota mínima ${NOTA_MINIMA}/10 de impacto/polêmica); não posta por postar.`);
      return false;
    }
    // desempate pelo engajamento real do Instagram no assunto (só entre as de mesma força)
    setStatus({ step: 'Comparando engajamento no Instagram…' });
    const topo = fortes.filter((x) => x.nota.nota >= fortes[0]!.nota.nota - 1 && (x.nota.cidade ?? '') === (fortes[0]!.nota.cidade ?? ''));
    const porCalor = await reorderByIgHeat(nativeIgHttp, { userId: ig.userId, token }, topo.length > 1 ? topo : fortes.slice(0, 1), (x) => x.nota.hashtag || keyEngagementWord(x.item.categoria ?? '', x.nota.cidade, []), 3);
    let escolha = porCalor[0]!.item;
    // entre as de mesma força, prioriza quem tem vídeo
    setStatus({ step: 'Procurando matéria com vídeo…' });
    for (const { item: c } of porCalor.slice(0, 3)) {
      const html = await nativeHttp.getText(c.item.url).then((r) => r.text).catch(() => '');
      if (html && articleVideos(html, c.item.url).length) {
        escolha = c;
        pageCache.set(c.item.url, html);
        break;
      }
    }
    n = escolha.item;
    cidadeEscolhida = escolha.nota.cidade;
    log(st, `Instagram: escolhida "${n.title}" (${escolha.porque}).`);
  } else log(st, `Instagram: postando "${n.title}" (escolhida na lista).`);
  setStatus({ step: 'Lendo a matéria…' });
  // dados da matéria: do app (já tem tudo) ou da página pública do site
  const mine = loadQueue().find((q) => q.siteId === n.id);
  const html = pageCache.get(n.url) ?? (await nativeHttp.getText(n.url).then((r) => r.text).catch(() => ''));
  pageCache.clear();
  let titulo = n.title;
  let subtitulo = '';
  let categoria = n.categoria ?? 'Notícia';
  let texto = '';
  let imagens: { src: string }[] = [];
  let palavras: string[] = [];
  if (mine) {
    ({ titulo, subtitulo, categoria } = mine.story);
    palavras = mine.story.palavrasChave;
    texto = mine.story.paragrafos.join('\n');
    imagens = mine.story.imagens;
  } else {
    const page = { text: html };
    const ex = extractBlocks(page.text, n.url);
    texto = ex.blocks
      .filter((b) => b.type === 'p')
      .map((b) => b.text)
      .join('\n');
    subtitulo = meta(page.text, 'og:description') || meta(page.text, 'description');
    imagens = [...(ex.ogImage ? [{ src: ex.ogImage }] : []), ...ex.blocks.filter((b) => b.type === 'img' && b.src).map((b) => ({ src: b.src! }))];
  }
  // vídeo da matéria (se tiver): entra no lugar da foto, sem o som original
  let videoFile: File | null = null;
  for (const src of html ? articleVideos(html, n.url).slice(0, 2) : []) {
    setStatus({ step: 'Baixando o vídeo da matéria…' });
    try {
      videoFile = (await downloadFromLink(src)).file;
      log(st, 'Instagram: a matéria tem vídeo; o post vai com o vídeo.');
      break;
    } catch (e) {
      log(st, `Instagram: vídeo da matéria não baixou (${(e as Error).message}); vai com a foto.`);
    }
  }
  setStatus({ step: 'Baixando a foto…' });
  const photo = await firstPhoto(imagens, n.url);
  if (!photo) {
    log(st, 'Instagram: a foto da matéria não baixou; fica para depois.');
    return false;
  }
  // título curto e direto + subtítulo que cabe, destaque e música (uma chamada à IA)
  setStatus({ step: 'Resumindo título e subtítulo para o vídeo…' });
  await ensureDefaultTones();
  const vt = await videoTexts(chat, {
    titulo,
    subtitulo,
    texto,
    palavras,
    destaque: mine?.story.destaque,
  });
  const tone = resolveTone(loadTones(), vt.tom, vt.audio, `${titulo} ${texto.slice(0, 2000)}`, categoria);
  if (!tone) throw new Error('nenhuma música cadastrada nos tons; o post não sai sem música');
  const { bytes: video, cleanup } = await renderVideo({
    kicker: categoria,
    title: vt.titulo,
    subtitle: vt.subtitulo,
    keywords: [vt.destaque ?? '', ...palavras].filter(Boolean),
    photo,
    // sem vídeo e com mais fotos: slide
    morePhotos: videoFile ? [] : await morePhotos(imagens, n.url),
    video: videoFile,
    audioId: tone.track.mediaId,
    audioStart: tone.track.inicio,
    audioDur: tone.track.dur ?? TRECHO_S,
  });
  noteTrackUse(tone.track.name);
  log(st, `Instagram: vídeo pronto com a música "${tone.track.name}".`);
  try {
    setStatus({ step: 'Escrevendo a legenda…' });
    const texts = [
      {
        url: n.url,
        title: titulo,
        source: 'Primeiras Notícias',
        date: n.date ?? null,
        text: texto,
      },
    ];
    let caption = '';
    try {
      // palavras sensíveis disfarçadas (a Meta derruba alcance), depois o negrito
      caption = styleCaption(censorCaption((await withTrendingHashtags(await writeStory(titulo, texts, chat, 'Legenda do Reels com o post em vídeo desta matéria.'), texts, nativeHttp)).text));
    } catch {
      /* reserva abaixo */
    }
    if (!caption) caption = censorCaption(`${titulo}\n\n${vt.subtitulo}\n\nMatéria completa em primeirasnoticias.com.br`);
    setStatus({ step: 'Enviando ao Instagram…' });
    const r = await publishReel(nativeIgHttp, { userId: ig.userId, token }, video, caption, {
      coverAtMs: 7500,
      collaborators: collabUsernames(ig.collab),
      // nome do áudio original do Reels (a música que já está no vídeo)
      audioName: `Primeiras Notícias · ${tone.track.name.replace(/^\w+ - /, '')}`,
      log: (m) => log(st, `Instagram: ${m}`),
    });
    writeJson(GAP_KEY, { at: new Date(Date.now() + igGapMs()).toISOString() });
    st.stories.push({
      url: n.url,
      title: titulo,
      categoria,
      keywords: palavras,
      tom: tone.tone.name,
      destaque: vt.destaque,
      postedAt: now.toISOString(),
      siteId: n.id,
      igId: r.id,
      ...(cidadeEscolhida ? { city: cidadeEscolhida } : {}),
    });
    st.stories = st.stories.slice(-400);
    saveState(st);
    log(st, `Instagram: Reels publicado ("${vt.titulo}").`);
    // a mesma descrição como 1º comentário (fixar o comentário a API não permite: só no app do Instagram)
    try {
      await postComment(nativeIgHttp, { userId: ig.userId, token }, r.id, caption);
      log(st, 'Instagram: descrição publicada também como comentário.');
    } catch (e) {
      log(st, `Instagram: não deu para comentar (${(e as Error).message}).`);
    }
    return true;
  } finally {
    // só serve para postar: apaga do aparelho a foto, o projeto e o vídeo
    await cleanup();
    log(st, 'Instagram: foto e vídeo apagados do aparelho.');
  }
}

/**
 * Ranking do Instagram para o botão "Postar lote": as matérias publicadas no
 * blog nas últimas 24 h que ainda não foram ao Instagram, com nota da IA de
 * impacto/polêmica (sem release/institucional), cidades da casa primeiro.
 */
export async function instagramRanking(): Promise<{ item: SiteNews; nota: number; porque: string }[]> {
  const site = getSiteConfig();
  if (!site.user || !site.pass) throw new Error('Coloque o usuário e a senha do site em ⚙ Configurações.');
  const list = await siteList('', 6);
  const st = loadState();
  const now = new Date();
  const posted = new Set(st.stories.filter((s) => s.igId && s.siteId).map((s) => s.siteId!));
  const cands = list.filter((x) => !posted.has(x.id) && !/revis|inativ|agend/i.test(x.status ?? '') && (!x.date || now.getTime() - new Date(x.date).getTime() <= 24 * 3600_000));
  const ns = await notas(aiChat(getAiKey(), nativePost), cands);
  const hoje = brt(now).day;
  const cidadesHoje = new Set(st.stories.filter((s) => s.igId && s.city && brt(new Date(s.postedAt)).day === hoje).map((s) => s.city!));
  return ordenar(cands, ns, cidadesHoje).map((x) => ({ item: x.item, nota: x.nota.nota, porque: x.porque }));
}

/** Matérias publicadas no blog para a lista do Instagram (as mais novas primeiro). */
export async function instagramList(): Promise<(SiteNews & { noInstagram: boolean; perHour: number | null })[]> {
  const site = getSiteConfig();
  if (!site.user || !site.pass) throw new Error('Coloque o usuário e a senha do site em ⚙ Configurações.');
  // 6 páginas do painel: num dia de lote grande, as primeiras matérias ficavam de fora
  const list = await siteList('', 6);
  const st = loadState();
  const posted = new Set(st.stories.filter((s) => s.igId && s.siteId).map((s) => s.siteId!));
  const now = Date.now();
  return list
    .map((n) => {
      const age = n.date ? (now - new Date(n.date).getTime()) / 3600_000 : null;
      return {
        ...n,
        noInstagram: posted.has(n.id),
        perHour: age !== null && typeof n.views === 'number' ? n.views / Math.max(1, age) : null,
      };
    });
}

// ---------------------------------------------------------------- fila de trabalhos (fora da tela)

export type Job = { kind: 'auto' } | { kind: 'blog' } | { kind: 'instagram'; item?: SiteNews } | { kind: 'lote'; itens: SiteNews[] };
const JOB_NAME = (j: Job) => (j.kind === 'auto' ? 'Automático' : j.kind === 'blog' ? 'Blog' : j.kind === 'lote' ? `Instagram: lote de ${j.itens.length}` : j.item ? `Instagram: ${j.item.title.slice(0, 40)}` : 'Instagram (a melhor)');
const queue: {
  job: Job;
  done: (ok: boolean) => void;
  fail: (e: Error) => void;
}[] = [];
let pumping = false;

/**
 * Coloca um trabalho na fila. Nunca é ignorado: se outro estiver rodando, espera
 * a vez (e aparece em "na fila"). Continua mesmo saindo da tela ou do app.
 */
export function runJob(job: Job): Promise<boolean> {
  // o relógio não empilha: um automático por vez
  if (job.kind === 'auto' && (status.job === 'Automático' || queue.some((q) => q.job.kind === 'auto'))) return Promise.resolve(false);
  return new Promise<boolean>((done, fail) => {
    queue.push({ job, done, fail });
    setStatus({ queue: queue.map((q) => JOB_NAME(q.job)) });
    void pump();
  });
}

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (queue.length) {
      const q = queue.shift()!;
      const name = JOB_NAME(q.job);
      setStatus({
        job: name,
        step: 'Começando…',
        pct: null,
        queue: queue.map((x) => JOB_NAME(x.job)),
      });
      // celular: segura o app trabalhando fora da tela
      if (q.job.kind !== 'auto') await postadorNative.aviso(`${name}: começando…`);
      try {
        const ok = await execute(q.job);
        if (q.job.kind !== 'auto' || ok)
          setStatus({
            last: {
              ok,
              msg: ok ? `${name}: feito ✓` : `${name}: ${status.step}`,
              at: new Date().toISOString(),
            },
          });
        q.done(ok);
      } catch (e) {
        const msg = (e as Error).message;
        log(null, `${name} falhou: ${msg}`);
        setStatus({
          last: {
            ok: false,
            msg: `${name} falhou: ${msg}`,
            at: new Date().toISOString(),
          },
        });
        q.fail(e as Error);
      }
    }
  } finally {
    pumping = false;
    setStatus({ job: null, step: '', pct: null, queue: [] });
    // sem automático, desliga o serviço quando acabar; ligado, volta ao aviso padrão
    if (getAutoConfig().ativo) void postadorNative.aviso('Postador ligado: lote do blog de manhã e Instagram nos horários de pico');
    else void postadorNative.stop();
  }
}

async function execute(job: Job): Promise<boolean> {
  const st = loadState();
  try {
    const now = new Date();
    // tokens: só renova perto de vencer
    const ig = getIgConfig();
    if (ig.igToken || ig.fbToken) {
      const r = await maintainTokens(nativeIgHttp, { igToken: ig.igToken || undefined }, ig.meta, now).catch(() => null);
      if (r) {
        setIgConfig({
          ...ig,
          igToken: r.igToken ?? ig.igToken,
          meta: { ...r.meta, igToken: undefined },
        });
        for (const l of [...r.log, ...r.warnings]) log(st, `Instagram: ${l}`);
      }
    }
    if (job.kind === 'instagram' && job.item) return await instagramOnce(st, [], job.item);
    if (job.kind === 'lote') {
      // um atrás do outro (disparo manual: sem esperar intervalo)
      let feitos = 0;
      for (let i = 0; i < job.itens.length; i++) {
        setStatus({ step: `Reels ${i + 1} de ${job.itens.length}: "${job.itens[i]!.title.slice(0, 50)}"` });
        try {
          if (await instagramOnce(st, [], job.itens[i]!)) feitos++;
        } catch (e) {
          log(st, `Instagram falhou em "${job.itens[i]!.title.slice(0, 50)}": ${(e as Error).message}`);
        }
      }
      log(st, `Instagram: lote terminado (${feitos} de ${job.itens.length} publicados).`);
      return feitos > 0;
    }
    const sitePosts = await stats(st, now);
    if (job.kind === 'blog') return (await blogBatch(st, sitePosts, 1)) > 0;
    if (job.kind === 'instagram') return await instagramOnce(st, sitePosts);

    // AUTOMÁTICO: lote do blog de manhã
    let did = false;
    const day = brt(now).day;
    const saved = readJson<BlogCtl>(BLOG_KEY, emptyCtl());
    const ctl: BlogCtl = saved.day === day ? saved : { ...emptyCtl(), day };
    if (blogDue(saved, now)) {
      ctl.lastTry = now.toISOString();
      writeJson(BLOG_KEY, ctl);
      log(st, `Blog: lote da manhã (${ctl.count} de ${BLOG_LOTE} já publicadas hoje).`);
      try {
        did = (await blogBatch(st, sitePosts, BLOG_LOTE - ctl.count, ctl)) > 0 || did;
      } catch (e) {
        log(st, `Blog falhou: ${(e as Error).message}. Tenta de novo em 20 min.`);
      }
      writeJson(BLOG_KEY, ctl);
    }
    // Instagram: manual, pelo botão "Postar lote" (escolhe as melhores do ranking)
    return did;
  } finally {
    // não perde o que outro trabalho gravou no meio (ex.: posts)
    const cur = loadState();
    const known = new Set(st.stories.map((s) => s.igId ?? s.url));
    st.stories = [...st.stories, ...cur.stories.filter((s) => !known.has(s.igId ?? s.url))].slice(-400);
    saveState(st);
  }
}

/** compatível com quem chamava tick(): o relógio usa o automático; os botões, a fila */
export async function tick(force?: 'blog' | 'instagram'): Promise<void> {
  if (force) {
    await runJob({ kind: force });
    return;
  }
  if (!getAutoConfig().ativo) return;
  // sinal de vida (mostra na tela se o celular está acordando o app com a tela bloqueada)
  writeJson('pn-ultimo-sinal', { at: new Date().toISOString() });
  await runJob({ kind: 'auto' }).catch(() => undefined);
}

export function autopostReport() {
  const st = loadState();
  const ctl = readJson<BlogCtl>(BLOG_KEY, emptyCtl());
  const hoje = brt(new Date()).day;
  return {
    ...report(st),
    log: liveLog().slice(-60).reverse(),
    ultimoSinal: readJson<{ at: string | null }>('pn-ultimo-sinal', { at: null }).at,
    blogHoje: Math.max(ctl.day === hoje ? ctl.count : 0, blogPublicadasHoje()),
    instagramHoje: st.stories.filter((s) => s.igId && brt(new Date(s.postedAt)).day === hoje).length,
  };
}

/** relógio interno (o serviço nativo também chama a cada 5 min) */
let timer: number | null = null;
export function startAutopostClock() {
  if (timer) return;
  window.addEventListener('postador-tick', () => void tick());
  timer = window.setInterval(() => void tick(), 5 * 60_000);
  void tick();
}
