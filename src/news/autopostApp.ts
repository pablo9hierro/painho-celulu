/**
 * POSTADOR AUTOMÁTICO NO CELULAR (só no app; o web é só para ver antes do APK).
 *
 * A cada "tique" (a cada 5 min, acordado pelo serviço nativo mesmo com a tela
 * bloqueada):
 *  1. renova os tokens quando for a hora;
 *  2. lê a estatística (acessos do site, pessoas no site agora, seguidores
 *     online no Instagram) e mede as matérias com 36 h+ (aprendizado);
 *  3. se for o horário de postar (~25 min antes de um pico), escolhe a melhor
 *     pauta, escreve a matéria (com destaque e tom), publica no site, monta o
 *     vídeo no próprio celular (com a trilha do tom) e posta o Reels.
 * Se falhar ou o celular estava "dormindo", tenta de novo nos próximos tiques
 * enquanto a janela do horário estiver aberta (até 3 tentativas por horário).
 */
import { capturePautas, sameStory, type Pauta } from './pautas';
import { cachedTrends } from './trends';
import { aiChat } from './openrouter';
import { writeSiteStory } from './siteWriter';
import { writeStory } from './writer';
import { withTrendingHashtags } from './hashtags';
import { styleCaption } from './unicodeStyle';
import { addNews, listNews, siteActiveUsers } from './websg';
import { mediaInsights, onlineFollowers, publishReel } from './instagram';
import { brt, learnedBoost, measure, normalizeState, postingSlots, postsToday, recordActive, recordViews, report, writerRules, type LearnState } from './learning';
import { loadTones, resolveTone, tonesForAi } from './tones';
import { maintainTokens } from './igToken';
import { getAiKey, nativeHttp, nativePost } from './client';
import { canvasCover, fetchPhoto, getIgConfig, getSiteConfig, nativeIgHttp, nativePautaHttp, nativeSiteHttp, setIgConfig, withBase } from './postadorClient';
import { createStoryVideo } from '../ui/storyVideo';
import { exporter, media as mediaApi, projects } from '../platform/api';
import { projectDuration } from '../core/timeline';
import type { MediaAsset } from '../core/model';

// ---------------------------------------------------------------- configuração e estado (no aparelho)

export interface AutoConfig {
  /** automação ligada */
  ativo: boolean;
  /** publica de verdade (false = ensaio: faz tudo menos publicar) */
  valendo: boolean;
  /** publica no site já como "Publicado" (false = "Revisão") */
  sitePublicar: boolean;
  maxDia: number;
}
const CFG_KEY = 'pn-autopost-cfg';
const ST_KEY = 'pn-autopost-state';
const RUN_KEY = 'pn-autopost-runs';
const MAX_AGE_H = 12;
/** depois do horário, continua tentando por este tanto (celular dormindo, sem internet...) */
const WINDOW_MIN = 90;
const MAX_TRIES = 3;

export function getAutoConfig(): AutoConfig {
  try {
    return { ativo: false, valendo: false, sitePublicar: true, maxDia: 4, ...(JSON.parse(localStorage.getItem(CFG_KEY) ?? '{}') as Partial<AutoConfig>) };
  } catch {
    return { ativo: false, valendo: false, sitePublicar: true, maxDia: 4 };
  }
}
export function setAutoConfig(c: AutoConfig) {
  try {
    localStorage.setItem(CFG_KEY, JSON.stringify(c));
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
/** tentativas por horário: "2026-10-22 20:35" → n */
function getTries(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(RUN_KEY) ?? '{}') as Record<string, number>;
  } catch {
    return {};
  }
}
function setTries(t: Record<string, number>) {
  try {
    const keep = Object.fromEntries(Object.entries(t).slice(-40));
    localStorage.setItem(RUN_KEY, JSON.stringify(keep));
  } catch {
    /* sem armazenamento */
  }
}

const log = (st: LearnState, m: string) => {
  const line = `${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })} ${m}`;
  st.log.push(line);
  st.log = st.log.slice(-300);
  console.log('[postador]', m);
};

// ---------------------------------------------------------------- horário (com tentativas)

/** Horário em aberto: começou há pouco (até 90 min), não foi usado e ainda tem tentativa. */
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

async function stats(st: LearnState, now: Date) {
  const site = withBase(getSiteConfig());
  const views = new Map<number, number>();
  if (site.user && site.pass) {
    try {
      const list = await listNews(nativeSiteHttp, site, 3);
      recordViews(st, now, list);
      for (const n of list) if (typeof n.views === 'number') views.set(n.id, n.views);
      const ga = await siteActiveUsers(nativeSiteHttp, site).catch(() => null);
      if (ga) recordActive(st, now, ga.users);
    } catch (e) {
      log(st, `Painel indisponível: ${(e as Error).message}`);
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
  if (n) log(st, `Desempenho medido em ${n} matéria(s); aprendizado atualizado.`);
}

// ---------------------------------------------------------------- uma postagem completa

export async function postOnce(st: LearnState, cfg: AutoConfig, why: string): Promise<boolean> {
  const now = new Date();
  log(st, `${why}: procurando a melhor pauta…`);
  let trending: string[] = [];
  try {
    const t = await cachedTrends(nativeHttp, 600_000);
    trending = [...t.searches.map((s) => s.term), ...t.hashtags.map((h) => h.tag)];
  } catch {
    /* sem trends */
  }
  const pautas = await capturePautas(nativePautaHttp, { window: '1d', trending, maxAgeHours: MAX_AGE_H });
  const fresh = pautas
    .filter((p) => p.readable && p.paragraphs >= 3 && p.imagesOk >= 1)
    .filter((p) => !st.stories.some((u) => u.url === p.url || sameStory(u.title, p.title)))
    .map((p) => ({ p, score: p.score + learnedBoost(st, { title: p.title, city: p.city }).pts }))
    .sort((a, b) => b.score - a.score);
  if (!fresh.length) {
    log(st, 'Nenhuma pauta inédita (até 12 h, com texto e foto) agora.');
    return false;
  }
  const pick: Pauta = fresh[0]!.p;
  log(st, `Pauta: ${pick.title} — ${pick.source} (${fresh[0]!.score} pts)`);

  const tones = loadTones();
  const chat = aiChat(getAiKey(), nativePost);
  const story = await writeSiteStory(pick, chat, writerRules(st), tonesForAi(tones));
  if (!story.model) {
    log(st, `A IA não escreveu (${story.steps.join(' / ')}). Sem publicar rascunho.`);
    return false;
  }
  const tone = resolveTone(tones, story.tom, story.audio, `${story.titulo} ${story.paragrafos.join(' ')}`, story.categoria);

  // foto (a primeira que baixar)
  let photo: File | null = null;
  for (const im of story.imagens) {
    try {
      photo = await fetchPhoto(im.src, pick.url);
      break;
    } catch {
      /* próxima */
    }
  }
  if (!photo) {
    log(st, 'Nenhuma foto da matéria baixou: pauta pulada.');
    return false;
  }

  // site
  let siteId: number | null = null;
  const site = withBase(getSiteConfig());
  if (site.user && site.pass && cfg.valendo) {
    try {
      const r = await addNews(nativeSiteHttp, site, {
        titulo: story.titulo,
        subtitulo: story.subtitulo,
        minititulo: story.minititulo,
        categoria: story.categoria,
        palavrasChave: story.palavrasChave,
        html: story.html,
        foto: { data: new Uint8Array(await photo.arrayBuffer()), type: photo.type, name: photo.name },
        publicar: cfg.sitePublicar,
      }, { prepareCover: canvasCover });
      siteId = r.id;
      log(st, `Site: ${r.steps.slice(-1)[0]}`);
    } catch (e) {
      log(st, `Site falhou: ${(e as Error).message}`);
    }
  } else log(st, `Site: ${cfg.valendo ? 'sem acesso configurado' : 'ensaio'} — "${story.titulo}"`);

  // vídeo no celular
  const video = await renderVideo({
    kicker: story.categoria || story.minititulo || 'Notícia',
    title: story.titulo,
    subtitle: story.subtitulo,
    keywords: [story.destaque ?? '', ...story.palavrasChave].filter(Boolean),
    photo,
    audioId: tone?.track.mediaId ?? null,
  });
  log(st, `Vídeo pronto (${(video.length / 1048576).toFixed(1)} MB)${tone ? `, trilha "${tone.track.name}" (${tone.tone.name})` : ''}${story.destaque ? `, destaque "${story.destaque}"` : ''}.`);

  // legenda no padrão do app
  const texts = [{ url: pick.url, title: pick.title, source: pick.source, date: pick.date, text: pick.blocks.filter((b) => b.type === 'p').map((b) => b.text).join('\n') }];
  let caption = '';
  try {
    caption = styleCaption((await withTrendingHashtags(await writeStory(story.titulo, texts, chat, 'Legenda do Reels com o post em vídeo desta matéria.'), texts, nativeHttp)).text);
  } catch {
    /* reserva abaixo */
  }
  if (!caption) caption = `${story.titulo}\n\n${story.subtitulo}\n\nMatéria completa em primeirasnoticias.com.br`;

  // Instagram
  let igId: string | null = null;
  const ig = getIgConfig();
  const token = ig.fbToken || ig.igToken;
  if (token && ig.userId && cfg.valendo) {
    try {
      const r = await publishReel(nativeIgHttp, { userId: ig.userId, token }, video, caption, { coverAtMs: 7500, log: (m) => log(st, m) });
      igId = r.id;
    } catch (e) {
      log(st, `Instagram falhou: ${(e as Error).message}`);
    }
  } else log(st, `Instagram: ${cfg.valendo ? 'sem token configurado' : 'ensaio (vídeo ficou nos projetos)'}`);

  if (cfg.valendo && (siteId || igId)) {
    st.stories.push({ url: pick.url, title: story.titulo, categoria: story.categoria, city: pick.city ?? undefined, keywords: story.palavrasChave, tom: tone?.tone.name, destaque: story.destaque, postedAt: now.toISOString(), siteId, igId });
    st.stories = st.stories.slice(-400);
    return true;
  }
  return !cfg.valendo; // ensaio conta como "feito"
}

// ---------------------------------------------------------------- tique (chamado a cada 5 min)

let running = false;

export async function tick(force?: 'postar' | 'estatistica'): Promise<void> {
  const cfg = getAutoConfig();
  if (!cfg.ativo && !force) return;
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
    // estatística no máximo a cada 25 min
    const last = st.snap?.at ? new Date(st.snap.at).getTime() : 0;
    if (force === 'estatistica' || now.getTime() - last > 25 * 60_000) await stats(st, now);

    if (force === 'postar') {
      await postOnce(st, cfg, 'Postagem manual');
      return;
    }
    const tries = getTries();
    const slot = openSlot(st, now, tries);
    if (!slot) return;
    if (postsToday(st, now) >= cfg.maxDia) {
      st.slotsUsed.push(slot);
      log(st, `Limite de ${cfg.maxDia} posts hoje.`);
      return;
    }
    tries[slot] = (tries[slot] ?? 0) + 1;
    setTries(tries);
    let ok = false;
    try {
      ok = await postOnce(st, cfg, `Horário ${slot.slice(11)} (tentativa ${tries[slot]}/${MAX_TRIES})`);
    } catch (e) {
      log(st, `Falhou: ${(e as Error).message}. Tenta de novo no próximo tique.`);
    }
    if (ok || tries[slot]! >= MAX_TRIES) st.slotsUsed.push(slot);
  } finally {
    saveState(st);
    running = false;
  }
}

export function autopostReport() {
  const st = loadState();
  return { ...report(st), log: st.log.slice(-30).reverse(), ultimaEstatistica: st.snap?.at ?? null };
}

/** liga o relógio interno (o serviço nativo também chama tick() a cada 5 min) */
let timer: number | null = null;
export function startAutopostClock() {
  if (timer) return;
  window.addEventListener('postador-tick', () => void tick());
  timer = window.setInterval(() => void tick(), 5 * 60_000);
  void tick();
}
