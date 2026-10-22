/**
 * AUTOMÁTICO NO CELULAR (só no app; o web é só para ver antes do APK).
 * Um botão só: ligado ou desligado. Ligado, faz DUAS coisas separadas:
 *
 *  BLOG — ao longo do dia (de hora em hora, das 6h às 23h) captura as notícias,
 *  escolhe a melhor pauta inédita (que ainda não está no site) e PUBLICA no blog.
 *
 *  INSTAGRAM — nos horários de pico dos seguidores, olha as últimas matérias
 *  publicadas no blog (as do app e as da redação) e posta como Reels SÓ a que
 *  teve melhor desempenho (visualizações por hora desde que saiu).
 *
 * O serviço nativo acorda o app a cada 5 min, mesmo com a tela bloqueada. Se
 * algo falhar (internet, celular dormindo), tenta de novo nos próximos tiques.
 */
import { capturePautas, extractBlocks, sameStory, type Pauta } from './pautas';
import { cachedTrends } from './trends';
import { aiChat } from './openrouter';
import { writeStory } from './writer';
import { withTrendingHashtags } from './hashtags';
import { styleCaption } from './unicodeStyle';
import { listNews, siteActiveUsers, type SiteNews } from './websg';
import { mediaInsights, onlineFollowers, collabUsernames, publishReel } from './instagram';
import { brt, learnedBoost, measure, normalizeState, postingSlots, recordActive, recordViews, report, type LearnState } from './learning';
import { loadTones, noteTrackUse, resolveTone, tonesForAi, TRECHO_S } from './tones';
import { maintainTokens } from './igToken';
import { pickHighlight } from './siteWriter';
import { getAiKey, nativeHttp, nativePost } from './client';
import { getIgConfig, getSiteConfig, nativeIgHttp, nativePautaHttp, nativeSiteHttp, setIgConfig, withBase } from './postadorClient';
import { firstPhoto, loadQueue, postToBlog } from './blogPost';
import { createStoryVideo } from '../ui/storyVideo';
import { exporter, media as mediaApi, projects } from '../platform/api';
import { projectDuration } from '../core/timeline';
import type { MediaAsset } from '../core/model';
import type { Chat } from './writer';

// ---------------------------------------------------------------- configuração e estado (no aparelho)

export interface AutoConfig {
  /** automático ligado (blog ao longo do dia + Instagram nos picos) */
  ativo: boolean;
}
const CFG_KEY = 'pn-autopost-cfg';
const ST_KEY = 'pn-autopost-state';
const RUN_KEY = 'pn-autopost-runs';
const BLOG_KEY = 'pn-autopost-blog';

/** blog: das 6h às 23h, de hora em hora, no máximo 12 por dia */
export const BLOG_FROM = 6;
export const BLOG_TO = 23;
const BLOG_EVERY_MIN = 60;
const BLOG_RETRY_MIN = 20;
const BLOG_MAX_DAY = 12;
const MAX_AGE_H = 12;
/** Instagram: depois do horário, continua tentando por 1h30 (até 3 vezes) */
const WINDOW_MIN = 90;
const MAX_TRIES = 3;

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

/** controle do blog: última tentativa, quantas hoje */
interface BlogCtl {
  lastTry: string | null;
  lastOk: string | null;
  day: string;
  count: number;
}

const log = (st: LearnState, m: string) => {
  const line = `${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} ${m}`;
  st.log.push(line);
  st.log = st.log.slice(-300);
  console.log('[automático]', m);
};

// ---------------------------------------------------------------- horários do Instagram (com tentativas)

/** Horário em aberto: começou há pouco (até 1h30), não foi usado e ainda tem tentativa. */
export function openSlot(st: LearnState, now: Date, tries: Record<string, number>): string | null {
  const { slots } = postingSlots(st);
  const { h, m, day } = brt(now);
  const nowMin = h * 60 + m;
  for (const s of slots) {
    const [hh, mm] = s.split(':').map(Number);
    const t = hh! * 60 + mm!;
    const key = `${day} ${s}`;
    if (nowMin >= t - 5 && nowMin <= t + WINDOW_MIN && !st.slotsUsed.includes(key) && (tries[key] ?? 0) < MAX_TRIES) return key;
  }
  return null;
}

/** Hora de postar no blog? (6h–23h, 1 por hora, 20 min para tentar de novo, até 12 no dia) */
export function blogDue(ctl: BlogCtl, now: Date): boolean {
  const { h, day } = brt(now);
  if (h < BLOG_FROM || h >= BLOG_TO) return false;
  const count = ctl.day === day ? ctl.count : 0;
  if (count >= BLOG_MAX_DAY) return false;
  const since = (iso: string | null) => (iso ? (now.getTime() - new Date(iso).getTime()) / 60_000 : Infinity);
  return since(ctl.lastOk) >= BLOG_EVERY_MIN && since(ctl.lastTry) >= BLOG_RETRY_MIN;
}

/**
 * Melhor matéria do blog para o Instagram: das publicadas nas últimas 24 h
 * (com pelo menos 1 h no ar para os números valerem), que ainda não foram ao
 * Instagram, a de mais visualizações por hora.
 */
export function bestForInstagram(list: SiteNews[], postedSiteIds: Set<number>, now: Date): { item: SiteNews; perHour: number } | null {
  const scored = list
    .filter((n) => n.date && typeof n.views === 'number' && !postedSiteIds.has(n.id) && !/revis|inativ|agend/i.test(n.status ?? ''))
    .map((n) => ({ item: n, age: (now.getTime() - new Date(n.date!).getTime()) / 3600_000 }))
    .filter((x) => x.age >= 1 && x.age <= 24)
    .map((x) => ({ item: x.item, perHour: x.item.views! / Math.max(1, x.age) }))
    .sort((a, b) => b.perHour - a.perHour);
  return scored[0] ?? null;
}

// ---------------------------------------------------------------- vídeo no próprio celular

async function renderVideo(input: Parameters<typeof createStoryVideo>[0]): Promise<Uint8Array> {
  const id = await createStoryVideo(input);
  const p = await projects.get(id);
  const ids = [...new Set(p.clips.map((c) => ('mediaId' in c ? (c as { mediaId: string }).mediaId : '')).filter(Boolean))];
  const media: Record<string, MediaAsset> = {};
  for (const m of ids) media[m] = await mediaApi.get(m);
  const { blob } = await exporter.exportVideo(p, media, { width: p.width, height: p.height, fps: 30, duration: projectDuration(p), crf: 20 }, () => undefined, new AbortController().signal);
  return new Uint8Array(await blob.arrayBuffer());
}

// ---------------------------------------------------------------- estatística

async function stats(st: LearnState, now: Date): Promise<SiteNews[]> {
  const site = withBase(getSiteConfig());
  let list: SiteNews[] = [];
  const views = new Map<number, number>();
  if (site.user && site.pass) {
    try {
      list = await listNews(nativeSiteHttp, site, 2);
      recordViews(st, now, list);
      for (const n of list) if (typeof n.views === 'number') views.set(n.id, n.views);
      const ga = await siteActiveUsers(nativeSiteHttp, site).catch(() => null);
      if (ga) recordActive(st, now, ga.users);
    } catch (e) {
      log(st, `Painel do site indisponível: ${(e as Error).message}`);
    }
  }
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

// ---------------------------------------------------------------- BLOG: uma postagem automática

export async function blogOnce(st: LearnState, sitePosts: SiteNews[]): Promise<boolean> {
  let trending: string[] = [];
  try {
    const t = await cachedTrends(nativeHttp, 600_000);
    trending = [...t.searches.map((s) => s.term), ...t.hashtags.map((h) => h.tag)];
  } catch {
    /* sem trends */
  }
  const pautas = await capturePautas(nativePautaHttp, { window: '1d', trending, maxAgeHours: MAX_AGE_H });
  const onSite = [...sitePosts.map((n) => n.title), ...loadQueue().map((q) => q.story.titulo), ...loadQueue().map((q) => q.pautaTitulo)];
  const fresh = pautas
    .filter((p) => p.readable && p.paragraphs >= 3 && p.imagesOk >= 1)
    // não repete o que já está no site (do app ou da redação)
    .filter((p) => !onSite.some((t) => sameStory(t, p.title)) && !loadQueue().some((q) => q.pautaUrl === p.url))
    .map((p) => ({ p, score: p.score + learnedBoost(st, { title: p.title, city: p.city }).pts }))
    .sort((a, b) => b.score - a.score);
  if (!fresh.length) {
    log(st, 'Blog: nenhuma notícia nova (até 12 h, com foto) que ainda não esteja no site.');
    return false;
  }
  const pick: Pauta = fresh[0]!.p;
  const r = await postToBlog(pick);
  log(st, `Blog: publicada "${r.story.titulo}"${r.siteId ? ` (nº ${r.siteId})` : ''}.`);
  return true;
}

// ---------------------------------------------------------------- INSTAGRAM: a melhor do blog vira Reels

/** destaque do título e tom/áudio para uma matéria da redação (uma chamada curta à IA) */
async function highlightAndTone(chat: Chat | null, titulo: string, texto: string): Promise<{ destaque?: string; tom?: string; audio?: string }> {
  const tones = tonesForAi(loadTones()).filter((t) => t.audios.length);
  if (!chat) return {};
  try {
    const r = await chat(
      [
        {
          role: 'system',
          content: `Para o post em vídeo desta notícia, responda SÓ com JSON {"destaque": "trecho de 2 a 4 palavras copiado EXATAMENTE do título, o coração da notícia", "tom": "nome exato de um tom", "audio": "nome exato de um áudio desse tom"}. Escolha o tom pelo assunto real (Policial só para crime/prisão/operação/violência; se nada combinar, o mais geral). Tons: ${JSON.stringify(tones)}`,
        },
        { role: 'user', content: `TÍTULO: ${titulo}\n\n${texto.slice(0, 3000)}` },
      ],
      { json: true, maxTokens: 300 },
    );
    const j = JSON.parse(/\{[\s\S]*\}/.exec(r.content)?.[0] ?? '{}') as { destaque?: string; tom?: string; audio?: string };
    return { destaque: pickHighlight(titulo, j.destaque ?? '', []), tom: j.tom, audio: j.audio };
  } catch {
    return {};
  }
}

const meta = (html: string, p: string) => new RegExp(`<meta[^>]+(?:property|name)=["']${p}["'][^>]*content=["']([^"']*)["']`, 'i').exec(html)?.[1] ?? '';

export async function instagramOnce(st: LearnState, sitePosts: SiteNews[]): Promise<boolean> {
  const now = new Date();
  const posted = new Set(st.stories.filter((s) => s.igId && s.siteId).map((s) => s.siteId!));
  const best = bestForInstagram(sitePosts, posted, now);
  if (!best) {
    log(st, 'Instagram: nenhuma matéria do blog com pelo menos 1 h no ar (últimas 24 h) que ainda não foi ao Instagram.');
    return false;
  }
  const n = best.item;
  log(st, `Instagram: a melhor do blog é "${n.title}" (${n.views} visualizações, ${best.perHour.toFixed(0)}/h).`);
  const chat = aiChat(getAiKey(), nativePost);
  // dados da matéria: do app (já tem tudo) ou da página pública do site
  const mine = loadQueue().find((q) => q.siteId === n.id);
  let titulo = n.title;
  let subtitulo = '';
  let categoria = n.categoria ?? 'Notícia';
  let texto = '';
  let imagens: { src: string }[] = [];
  let destaque: string | undefined;
  let tom: string | undefined;
  let audio: string | undefined;
  let palavras: string[] = [];
  if (mine) {
    ({ titulo, subtitulo, categoria, destaque, tom, audio } = mine.story);
    palavras = mine.story.palavrasChave;
    texto = mine.story.paragrafos.join('\n');
    imagens = mine.story.imagens;
  } else {
    const page = await nativeHttp.getText(n.url);
    const ex = extractBlocks(page.text, n.url);
    texto = ex.blocks.filter((b) => b.type === 'p').map((b) => b.text).join('\n');
    subtitulo = meta(page.text, 'og:description') || meta(page.text, 'description');
    imagens = [...(ex.ogImage ? [{ src: ex.ogImage }] : []), ...ex.blocks.filter((b) => b.type === 'img' && b.src).map((b) => ({ src: b.src! }))];
    ({ destaque, tom, audio } = await highlightAndTone(chat, titulo, texto));
  }
  const photo = await firstPhoto(imagens, n.url);
  if (!photo) {
    log(st, 'Instagram: a foto da matéria não baixou; fica para o próximo horário.');
    return false;
  }
  const tone = resolveTone(loadTones(), tom, audio, `${titulo} ${texto.slice(0, 2000)}`, categoria);
  const video = await renderVideo({
    kicker: categoria,
    title: titulo,
    subtitle: subtitulo.slice(0, 180),
    keywords: [destaque ?? '', ...palavras].filter(Boolean),
    photo,
    audioId: tone?.track.mediaId ?? null,
    audioStart: tone?.track.inicio,
    audioDur: tone?.track.dur ?? TRECHO_S,
  });
  if (tone) noteTrackUse(tone.track.name);
  log(st, `Instagram: vídeo pronto${tone ? ` com a trilha "${tone.track.name}"` : ''}${destaque ? `, destaque "${destaque}"` : ''}.`);
  const texts = [{ url: n.url, title: titulo, source: 'Primeiras Notícias', date: n.date ?? null, text: texto }];
  let caption = '';
  try {
    caption = styleCaption((await withTrendingHashtags(await writeStory(titulo, texts, chat, 'Legenda do Reels com o post em vídeo desta matéria.'), texts, nativeHttp)).text);
  } catch {
    /* reserva abaixo */
  }
  if (!caption) caption = `${titulo}\n\n${subtitulo}\n\nMatéria completa em primeirasnoticias.com.br`;
  const ig = getIgConfig();
  const token = ig.fbToken || ig.igToken;
  if (!token || !ig.userId) {
    log(st, 'Instagram: sem token. Coloque em ⚙ Configurações.');
    return false;
  }
  const r = await publishReel(nativeIgHttp, { userId: ig.userId, token }, video, caption, { coverAtMs: 7500, collaborators: collabUsernames(ig.collab), log: (m) => log(st, `Instagram: ${m}`) });
  st.stories.push({ url: n.url, title: titulo, categoria, keywords: palavras, tom: tone?.tone.name, destaque, postedAt: now.toISOString(), siteId: n.id, igId: r.id });
  st.stories = st.stories.slice(-400);
  log(st, `Instagram: Reels publicado.`);
  return true;
}

// ---------------------------------------------------------------- tique (a cada 5 min)

let running = false;

export async function tick(force?: 'blog' | 'instagram'): Promise<void> {
  if (!getAutoConfig().ativo && !force) return;
  if (running) return;
  running = true;
  const st = loadState();
  try {
    const now = new Date();
    // tokens: só renova perto de vencer
    const ig = getIgConfig();
    if (ig.igToken || ig.fbToken) {
      const r = await maintainTokens(nativeIgHttp, { igToken: ig.igToken || undefined }, ig.meta, now).catch(() => null);
      if (r) {
        setIgConfig({ ...ig, igToken: r.igToken ?? ig.igToken, meta: { ...r.meta, igToken: undefined } });
        for (const l of [...r.log, ...r.warnings]) log(st, `Instagram: ${l}`);
      }
    }
    const sitePosts = await stats(st, now);

    // BLOG ao longo do dia
    const ctl = readJson<BlogCtl>(BLOG_KEY, { lastTry: null, lastOk: null, day: '', count: 0 });
    if (force === 'blog' || (!force && blogDue(ctl, now))) {
      const day = brt(now).day;
      ctl.lastTry = now.toISOString();
      try {
        if (await blogOnce(st, sitePosts)) {
          ctl.lastOk = now.toISOString();
          ctl.count = (ctl.day === day ? ctl.count : 0) + 1;
          ctl.day = day;
        }
      } catch (e) {
        log(st, `Blog falhou: ${(e as Error).message}. Tenta de novo em 20 min.`);
      }
      writeJson(BLOG_KEY, ctl);
    }

    // INSTAGRAM nos horários de pico: a melhor do blog
    if (force === 'instagram') {
      await instagramOnce(st, sitePosts);
      return;
    }
    if (force) return;
    const tries = readJson<Record<string, number>>(RUN_KEY, {});
    const slot = openSlot(st, now, tries);
    if (!slot) return;
    tries[slot] = (tries[slot] ?? 0) + 1;
    writeJson(RUN_KEY, Object.fromEntries(Object.entries(tries).slice(-40)));
    let ok = false;
    try {
      ok = await instagramOnce(st, sitePosts);
    } catch (e) {
      log(st, `Instagram falhou: ${(e as Error).message}. Tenta de novo no próximo tique.`);
    }
    if (ok || tries[slot]! >= MAX_TRIES) st.slotsUsed.push(slot);
  } finally {
    saveState(st);
    running = false;
  }
}

export function autopostReport() {
  const st = loadState();
  const ctl = readJson<BlogCtl>(BLOG_KEY, { lastTry: null, lastOk: null, day: '', count: 0 });
  const hoje = brt(new Date()).day;
  return { ...report(st), log: st.log.slice(-40).reverse(), blogHoje: ctl.day === hoje ? ctl.count : 0, instagramHoje: st.stories.filter((s) => s.igId && brt(new Date(s.postedAt)).day === hoje).length };
}

/** relógio interno (o serviço nativo também chama a cada 5 min) */
let timer: number | null = null;
export function startAutopostClock() {
  if (timer) return;
  window.addEventListener('postador-tick', () => void tick());
  timer = window.setInterval(() => void tick(), 5 * 60_000);
  void tick();
}
