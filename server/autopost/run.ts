/**
 * AUTOMAÇÃO DO POSTADOR (roda pelo cron do GitHub Actions a cada 30 min, ou à
 * mão: `npm run autopost`). Uma rodada:
 *
 *  1. ESTATÍSTICA — entra no painel do site, lê os acessos das matérias
 *     (vira a curva de audiência por hora) e mede as matérias com 36 h+
 *     (site + Instagram). Atualiza os pesos do que dá audiência.
 *  2. HORÁRIO — só posta se agora for ~25 min antes de um pico de audiência
 *     (ou com AUTOPOST_FORCAR=1), até AUTOPOST_MAX_DIA posts por dia.
 *  3. PAUTA — captura as notícias (JP, Cabedelo, Bayeux, Campina + nacionais),
 *     ranqueia com trends + imagens + o que aprendeu, e pega a melhor inédita.
 *  4. MATÉRIA — a IA escreve para o site (com as imagens nos lugares), já
 *     escolhendo o trecho destacado do título e o tom/áudio; recebe as regras
 *     aprendidas. Publica no painel do site.
 *  5. VÍDEO — monta o post em vídeo (mesmo motor do app) e publica como Reels,
 *     com a legenda no padrão do app (negrito, créditos, 5 hashtags em alta).
 *
 * Segurança: sem AUTOPOST_ATIVO=1 tudo roda em ENSAIO (não publica nada).
 * Nenhuma senha/token fica em arquivo: tudo vem das variáveis (Secrets).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { capturePautas, sameStory, type Pauta } from '../../src/news/pautas';
import { cachedTrends } from '../../src/news/trends';
import { aiChat } from '../../src/news/openrouter';
import { writeSiteStory, type ToneOption } from '../../src/news/siteWriter';
import { writeStory } from '../../src/news/writer';
import { withTrendingHashtags } from '../../src/news/hashtags';
import { styleCaption } from '../../src/news/unicodeStyle';
import { addNews, listNews, siteActiveUsers, WEBSG_DEFAULT, type WebsgConfig } from '../../src/news/websg';
import { mediaInsights, onlineFollowers, publishReel, type IgConfig } from '../../src/news/instagram';
import { dueSlot, learnedBoost, measure, normalizeState, postingSlots, postsToday, recordActive, recordViews, report, writerRules, type LearnState } from '../../src/news/learning';
import { resolveTone, type Tone } from '../../src/news/tones';
import { nodeHttp } from '../news';
import { nodePautaHttp } from '../pautas';
import { nodeIgHttp, nodePrepareCover, nodeSiteHttp } from '../siteHttp';
import { renderStoryVideo } from './render';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { maintainTokens, type TokenMeta } from '../../src/news/igToken';

// chaves locais (no PC); no GitHub Actions vêm dos Secrets
for (const f of ['.env.local', '.env']) {
  try {
    process.loadEnvFile(f);
  } catch {
    /* arquivo opcional */
  }
}

const env = (k: string, d = '') => (process.env[k] ?? d).trim();
const ATIVO = env('AUTOPOST_ATIVO') === '1';
const FORCAR = env('AUTOPOST_FORCAR') === '1';
const MAX_DIA = Number(env('AUTOPOST_MAX_DIA', '4')) || 4;
const PUBLICAR_SITE = env('AUTOPOST_SITE_PUBLICAR', '1') !== '0';
const DADOS = env('AUTOPOST_DADOS', 'autopost-dados');
const TONS = env('AUTOPOST_TONS', 'autopost/tons');
const APP_URL = env('AUTOPOST_APP_URL', 'http://localhost:5173/');
const SECONDS = 8;
/** regra: só notícia de até 12 h (ajustável para testes) */
const MAX_AGE_H = Number(env('AUTOPOST_IDADE_MAX_H', '12')) || 12;

const websg: WebsgConfig = { base: env('WEBSG_URL', WEBSG_DEFAULT), user: env('WEBSG_USER'), pass: env('WEBSG_PASS') };
// posta com o token do Facebook (aceita envio direto do vídeo); o do Instagram (IGAA) fica de reserva
const ig: IgConfig = { userId: env('INSTAGRAM_USER_ID'), token: env('INSTAGRAM_FB_TOKEN') || env('INSTAGRAM_ACCESS_TOKEN') };
/** mesma configuração, para a renovação trocar o token no meio da rodada */
const IG_CFG = ig;
const aiKey = env('AI_API_KEY') || env('OPENROUTER_API_KEY') || env('GEMINI_API_KEY');
const hasSite = !!(websg.user && websg.pass);
const hasIg = !!(ig.userId && ig.token);

const statePath = join(DADOS, 'estado.json');

// ---- tokens renovados: guardados CRIPTOGRAFADOS no branch de dados (chave só nos Secrets)
const tokenPath = join(DADOS, 'tokens.enc');
const CHAVE = env('AUTOPOST_CHAVE');
const keyOf = () => createHash('sha256').update(CHAVE).digest();
function loadTokenMeta(): TokenMeta {
  if (!CHAVE || !existsSync(tokenPath)) return {};
  try {
    const raw = Buffer.from(readFileSync(tokenPath, 'utf8'), 'base64');
    const d = createDecipheriv('aes-256-gcm', keyOf(), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8')) as TokenMeta;
  } catch {
    return {};
  }
}
function saveTokenMeta(m: TokenMeta) {
  if (!CHAVE) return;
  mkdirSync(DADOS, { recursive: true });
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keyOf(), iv);
  const enc = Buffer.concat([c.update(JSON.stringify(m), 'utf8'), c.final()]);
  writeFileSync(tokenPath, Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64'));
}
async function tokens(st: LearnState) {
  const saved = loadTokenMeta();
  // token do Instagram já renovado numa rodada anterior vale mais que o dos Secrets
  if (saved.igToken) process.env.INSTAGRAM_ACCESS_TOKEN = saved.igToken;
  const ig = env('INSTAGRAM_ACCESS_TOKEN');
  const fb = env('INSTAGRAM_FB_TOKEN') || (ig.startsWith('EAA') ? ig : '');
  const appToken = env('INSTAGRAM_APP_ID') && env('INSTAGRAM_APP_SECRET') ? `${env('INSTAGRAM_APP_ID')}|${env('INSTAGRAM_APP_SECRET')}` : undefined;
  if (!ig && !fb) return;
  if (saved.fbToken) process.env.INSTAGRAM_FB_TOKEN = saved.fbToken;
  const r = await maintainTokens(nodeIgHttp, { igToken: ig.startsWith('IG') ? ig : undefined, fbToken: env('INSTAGRAM_FB_TOKEN') || fb || undefined, appToken, appId: env('INSTAGRAM_APP_ID'), appSecret: env('INSTAGRAM_APP_SECRET') }, saved);
  if (r.igToken) process.env.INSTAGRAM_ACCESS_TOKEN = r.igToken;
  if (r.fbToken) {
    process.env.INSTAGRAM_FB_TOKEN = r.fbToken;
    r.meta.fbToken = r.fbToken;
    IG_CFG.token = r.fbToken;
  }
  if (CHAVE) saveTokenMeta(r.meta);
  else if (r.log.length) r.warnings.push('Sem AUTOPOST_CHAVE nos Secrets: o token renovado não fica guardado entre as rodadas.');
  for (const l of [...r.log, ...r.warnings]) log(st, `Instagram: ${l}`);
}
const log = (st: LearnState, m: string) => {
  const line = `${new Date().toISOString()} ${m}`;
  console.log(line);
  st.log.push(line);
  st.log = st.log.slice(-300);
};

function loadState(): LearnState {
  try {
    return normalizeState(JSON.parse(readFileSync(statePath, 'utf8')));
  } catch {
    return normalizeState(null);
  }
}
function saveState(st: LearnState) {
  mkdirSync(DADOS, { recursive: true });
  writeFileSync(statePath, JSON.stringify(st, null, 1));
  writeFileSync(join(DADOS, 'relatorio.json'), JSON.stringify({ atualizado: new Date().toISOString(), ...report(st) }, null, 1));
}

/** tons da automação: pasta autopost/tons/<Tom>/<nome do áudio>.mp3 */
function loadTones(): { tones: Tone[]; files: Map<string, string> } {
  const files = new Map<string, string>();
  const tones: Tone[] = [];
  // 1) tons enviados pelo app (branch de dados): nomes exatamente como cadastrados
  const idx = join(DADOS, 'tons', 'tons.json');
  if (existsSync(idx)) {
    try {
      const j = JSON.parse(readFileSync(idx, 'utf8')) as { dicas?: Record<string, string>; audios?: { tom: string; nome: string; arquivo: string }[] };
      for (const a of j.audios ?? []) {
        const file = join(DADOS, a.arquivo);
        if (!existsSync(file)) continue;
        let tone = tones.find((x) => x.name === a.tom);
        if (!tone) {
          tone = { id: a.tom, name: a.tom, hint: j.dicas?.[a.tom] ?? '', tracks: [] };
          tones.push(tone);
        }
        tone.tracks.push({ mediaId: a.arquivo, name: a.nome });
        files.set(a.arquivo, file);
      }
      if (tones.length) return { tones, files };
    } catch {
      /* índice estragado: tenta a pasta manual */
    }
  }
  // 2) reserva: pasta manual autopost/tons/<Tom>/<nome>.mp3
  if (!existsSync(TONS)) return { tones, files };
  for (const dir of readdirSync(TONS, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const tone: Tone = { id: dir.name, name: dir.name, hint: '', tracks: [] };
    const hintFile = join(TONS, dir.name, 'dica.txt');
    if (existsSync(hintFile)) tone.hint = readFileSync(hintFile, 'utf8').trim();
    for (const f of readdirSync(join(TONS, dir.name))) {
      if (!/\.(mp3|m4a|aac|wav|ogg)$/i.test(f)) continue;
      const id = `${dir.name}/${f}`;
      tone.tracks.push({ mediaId: id, name: basename(f, extname(f)) });
      files.set(id, join(TONS, dir.name, f));
    }
    if (tone.tracks.length) tones.push(tone);
  }
  return { tones, files };
}

async function download(url: string, referer: string): Promise<{ data: Uint8Array; type: string } | null> {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0 Safari/537.36', Referer: referer, Accept: 'image/*' }, signal: AbortSignal.timeout(20_000) });
    const type = r.headers.get('content-type') ?? '';
    if (!r.ok || !type.startsWith('image/')) return null;
    const data = new Uint8Array(await r.arrayBuffer());
    return data.length > 8000 ? { data, type } : null;
  } catch {
    return null;
  }
}

async function stats(st: LearnState) {
  const now = new Date();
  const site = new Map<number, number>();
  if (hasSite) {
    try {
      const list = await listNews(nodeSiteHttp(), websg, 3);
      recordViews(st, now, list);
      for (const n of list) if (typeof n.views === 'number') site.set(n.id, n.views);
      log(st, `Painel: ${list.length} matérias lidas${site.size ? ` (${site.size} com acessos)` : ' (o painel não mostrou acessos na lista)'}.`);
      const ga = await siteActiveUsers(nodeSiteHttp(), websg).catch(() => null);
      if (ga) {
        recordActive(st, now, ga.users);
        log(st, `Google Analytics: ${ga.users} pessoa(s) no site agora.`);
      }
    } catch (e) {
      log(st, `Painel indisponível: ${(e as Error).message}`);
    }
  }
  const igViews = new Map<string, number>();
  if (hasIg) {
    // seguidores online por hora: atualiza 1x por dia
    if (!st.igHourAt || now.getTime() - new Date(st.igHourAt).getTime() > 20 * 3600_000) {
      const h = await onlineFollowers(nodeIgHttp, ig);
      if (h) {
        st.igHour = h;
        st.igHourAt = now.toISOString();
        log(st, 'Instagram: horários dos seguidores online atualizados.');
      }
    }
    for (const s of st.stories.filter((x) => x.igId && !x.measuredAt && now.getTime() - new Date(x.postedAt).getTime() > 36 * 3600_000).slice(0, 10)) {
      const m = await mediaInsights(nodeIgHttp, ig, s.igId!);
      const v = m.views ?? m.reach;
      if (typeof v === 'number') igViews.set(s.igId!, v);
    }
  }
  const n = measure(st, now, site, igViews);
  if (n) log(st, `Desempenho medido em ${n} matéria(s); pesos do aprendizado atualizados.`);
}

async function main() {
  const st = loadState();
  const mode = ATIVO ? 'VALENDO' : 'ENSAIO (nada é publicado; ligue com AUTOPOST_ATIVO=1)';
  log(st, `Rodada do Postador — ${mode}. Site: ${hasSite ? 'configurado' : 'sem senha'} · Instagram: ${hasIg ? 'configurado' : 'sem token'} · IA: ${aiKey ? 'ok' : 'sem chave'}`);
  await tokens(st).catch((e) => log(st, `Instagram: manutenção do token falhou (${(e as Error).message})`));
  await stats(st);

  const now = new Date();
  const { slots, source } = postingSlots(st);
  const slot = FORCAR ? `forçado ${now.toISOString()}` : dueSlot(st, now);
  if (!slot) {
    log(st, `Fora do horário. Próximos disparos (Brasília): ${slots.join(', ')} — base: ${source}.`);
    return saveState(st);
  }
  if (!FORCAR && postsToday(st, now) >= MAX_DIA) {
    log(st, `Limite de ${MAX_DIA} posts hoje atingido.`);
    return saveState(st);
  }
  log(st, `Horário de postar (${slot}).`);

  // 3) pauta
  let trending: string[] = [];
  try {
    const t = await cachedTrends(nodeHttp, 600_000);
    trending = [...t.searches.map((s) => s.term), ...t.hashtags.map((h) => h.tag)];
  } catch {
    /* sem trends */
  }
  const pautas = await capturePautas(nodePautaHttp, { window: '1d', trending, maxAgeHours: MAX_AGE_H });
  const used = st.stories;
  const fresh = pautas
    .filter((p) => p.readable && p.paragraphs >= 3 && p.imagesOk >= 1)
    .filter((p) => !used.some((u) => u.url === p.url || sameStory(u.title, p.title)))
    .map((p) => {
      const b = learnedBoost(st, { title: p.title, city: p.city });
      return { p, score: p.score + b.pts, why: b.why };
    })
    .sort((a, b) => b.score - a.score);
  if (!fresh.length) {
    log(st, 'Nenhuma pauta inédita com texto e foto agora.');
    return saveState(st);
  }
  const pick: Pauta = fresh[0]!.p;
  log(st, `Pauta escolhida (${fresh[0]!.score} pts${fresh[0]!.why.length ? `; aprendizado: ${fresh[0]!.why.join(', ')}` : ''}): ${pick.title} — ${pick.source}`);

  // 4) matéria do site (com destaque e tom na MESMA chamada da IA)
  const { tones, files } = loadTones();
  const toneOpts: ToneOption[] = tones.map((t) => ({ tom: t.name, dica: t.hint, audios: t.tracks.map((k) => k.name) }));
  const chat = aiChat(aiKey);
  const story = await writeSiteStory(pick, chat, writerRules(st), toneOpts);
  if (!story.model) {
    log(st, `A IA não escreveu (${story.steps.join(' / ')}); sem publicar rascunho automático.`);
    return saveState(st);
  }
  if (story.unverified.length) log(st, `Atenção: dados a conferir — ${story.unverified.join(', ')}`);
  const tone = resolveTone(tones, story.tom, story.audio, `${story.titulo} ${story.paragrafos.join(' ')}`, story.categoria);
  const cover = story.imagens[0] ? await download(story.imagens[0].src, pick.url) : null;

  let siteId: number | null = null;
  if (hasSite && ATIVO) {
    try {
      const r = await addNews(nodeSiteHttp(), websg, {
        titulo: story.titulo,
        subtitulo: story.subtitulo,
        minititulo: story.minititulo,
        categoria: story.categoria,
        palavrasChave: story.palavrasChave,
        html: story.html,
        foto: cover ? { data: cover.data, type: cover.type, name: `capa.${cover.type.includes('png') ? 'png' : 'jpg'}` } : null,
        publicar: PUBLICAR_SITE,
      }, { prepareCover: nodePrepareCover });
      siteId = r.id;
      log(st, `Site: ${r.steps.slice(-1)[0]}`);
    } catch (e) {
      log(st, `Site: falhou — ${(e as Error).message}`);
    }
  } else log(st, `Site: ${hasSite ? 'ensaio' : 'sem senha'} — publicaria "${story.titulo}".`);

  // 5) vídeo + Reels
  mkdirSync(join(DADOS, 'videos'), { recursive: true });
  const out = join(DADOS, 'videos', `post-${Date.now()}.mp4`);
  await renderStoryVideo({
    appUrl: APP_URL,
    // chapéu = editoria da matéria (o minititulo da IA às vezes erra: POLÍCIA numa de política)
    kicker: story.categoria || story.minititulo || 'Notícia',
    title: story.titulo,
    subtitle: story.subtitulo,
    keywords: [story.destaque ?? '', ...story.palavrasChave].filter(Boolean),
    photo: cover,
    audioPath: tone ? files.get(tone.track.mediaId) ?? null : null,
    seconds: SECONDS,
    out,
    log: (m) => log(st, m),
  });
  log(st, `Vídeo pronto${tone ? ` com a trilha "${tone.track.name}" (tom ${tone.tone.name}, escolha ${tone.how === 'ia' ? 'da IA' : 'automática'})` : ' (sem trilha cadastrada)'}${story.destaque ? `; destaque: "${story.destaque}"` : ''}.`);

  // legenda no padrão do app (fatos da fonte, negrito, créditos e 5 hashtags em alta)
  const texts = [{ url: pick.url, title: pick.title, source: pick.source, date: pick.date, text: pick.blocks.filter((b) => b.type === 'p').map((b) => b.text).join('\n') }];
  let caption = '';
  try {
    const cap = await withTrendingHashtags(await writeStory(story.titulo, texts, chat, 'Legenda do Reels com o post em vídeo desta matéria.'), texts, nodeHttp);
    caption = styleCaption(cap.text);
  } catch (e) {
    log(st, `Legenda: ${(e as Error).message}`);
  }
  if (!caption) caption = `${story.titulo}\n\n${story.subtitulo}\n\nMatéria completa em primeirasnoticias.com.br`;

  let igId: string | null = null;
  if (hasIg && ATIVO) {
    try {
      const r = await publishReel(nodeIgHttp, ig, new Uint8Array(readFileSync(out)), caption, { coverAtMs: (SECONDS - 0.5) * 1000, log: (m) => log(st, m) });
      igId = r.id;
    } catch (e) {
      log(st, `Instagram: falhou — ${(e as Error).message}`);
    }
  } else log(st, `Instagram: ${hasIg ? 'ensaio' : 'sem token'} — vídeo salvo em ${out}.`);

  if (ATIVO && (siteId || igId)) {
    st.stories.push({ url: pick.url, title: story.titulo, categoria: story.categoria, city: pick.city ?? undefined, keywords: story.palavrasChave, tom: tone?.tone.name, destaque: story.destaque, postedAt: new Date().toISOString(), siteId, igId });
    st.stories = st.stories.slice(-400);
  }
  if (!FORCAR && slot) st.slotsUsed.push(slot);
  saveState(st);
}

main().catch((e) => {
  console.error('Falha na rodada do Postador:', e);
  process.exitCode = 1;
});
