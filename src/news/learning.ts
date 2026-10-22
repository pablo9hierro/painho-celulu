/**
 * Aprendizado do Postador (sem IA, só estatística):
 *
 * 1. HORÁRIOS: a cada rodada a automação lê os acessos das matérias no painel
 *    do site; a diferença entre uma leitura e a anterior é o tráfego daquela
 *    hora. Somado dia a dia, vira a curva de audiência por hora (0–23h, horário
 *    de Brasília). Junta com a hora em que os seguidores do Instagram estão
 *    online. Os disparos acontecem ~25 min ANTES dos picos.
 * 2. DESEMPENHO: 36 h depois de postada, cada matéria é medida (acessos no
 *    site + visualizações no Instagram). Palavra-chave, editoria, cidade e tom
 *    de quem foi melhor ganham peso; de quem foi pior, perdem.
 * 3. REGRAS: os pesos viram (a) pontos no ranking das pautas e (b) instruções
 *    para o redator da IA ("o que mais deu audiência...").
 *
 * Tudo cabe num JSON pequeno, salvo entre as rodadas.
 */
export interface LearnedStory {
  /** link da pauta original */
  url: string;
  title: string;
  categoria: string;
  city?: string;
  keywords: string[];
  tom?: string;
  destaque?: string;
  postedAt: string;
  siteId?: number | null;
  igId?: string | null;
  siteViews?: number;
  igViews?: number;
  measuredAt?: string;
}

export interface LearnState {
  v: 1;
  stories: LearnedStory[];
  /** tráfego do site por hora (soma das médias por hora) e quantas medições */
  siteHour: number[];
  siteHourN: number[];
  /** usuários ativos no site por hora (GA4 do painel, amostrado a cada rodada) */
  gaHour?: number[];
  gaHourN?: number[];
  /** seguidores online por hora (Instagram) */
  igHour?: number[] | null;
  igHourAt?: string;
  /** última leitura de acessos: id → acessos */
  snap?: { at: string; views: Record<string, number> };
  weights: Record<string, { n: number; w: number }>;
  /** horários já usados: "2026-10-21 18:35" */
  slotsUsed: string[];
  log: string[];
}

export const emptyState = (): LearnState => ({ v: 1, stories: [], siteHour: new Array(24).fill(0), siteHourN: new Array(24).fill(0), weights: {}, slotsUsed: [], log: [] });

export function normalizeState(s: Partial<LearnState> | null | undefined): LearnState {
  const e = emptyState();
  if (!s || s.v !== 1) return e;
  return {
    ...e,
    ...s,
    siteHour: Array.isArray(s.siteHour) && s.siteHour.length === 24 ? s.siteHour : e.siteHour,
    siteHourN: Array.isArray(s.siteHourN) && s.siteHourN.length === 24 ? s.siteHourN : e.siteHourN,
    stories: Array.isArray(s.stories) ? s.stories : [],
    weights: s.weights ?? {},
    slotsUsed: Array.isArray(s.slotsUsed) ? s.slotsUsed.slice(-200) : [],
    log: Array.isArray(s.log) ? s.log.slice(-300) : [],
  };
}

/** hora/dia em Brasília (UTC-3, sem horário de verão) */
export function brt(d: Date) {
  const t = new Date(d.getTime() - 3 * 3600_000);
  return { h: t.getUTCHours(), m: t.getUTCMinutes(), day: t.toISOString().slice(0, 10) };
}

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

// ---------------------------------------------------------------- horários

/** Registra uma leitura de acessos e reparte o crescimento pelas horas que passaram. */
export function recordViews(st: LearnState, now: Date, views: { id: number; views?: number }[]) {
  const cur: Record<string, number> = {};
  for (const v of views) if (typeof v.views === 'number') cur[String(v.id)] = v.views;
  if (!Object.keys(cur).length) return;
  const prev = st.snap;
  if (prev) {
    const hours = (now.getTime() - new Date(prev.at).getTime()) / 3600_000;
    // só usa intervalos curtos (uma rodada perdida ainda vale; um dia parado, não)
    if (hours > 0.2 && hours <= 3) {
      let delta = 0;
      for (const [id, v] of Object.entries(cur)) if (prev.views[id] !== undefined && v >= prev.views[id]!) delta += v - prev.views[id]!;
      const perHour = delta / hours;
      // atribui à hora do meio do intervalo
      const mid = brt(new Date((now.getTime() + new Date(prev.at).getTime()) / 2)).h;
      st.siteHour[mid] = (st.siteHour[mid] ?? 0) + perHour;
      st.siteHourN[mid] = (st.siteHourN[mid] ?? 0) + 1;
    }
  }
  st.snap = { at: now.toISOString(), views: cur };
}

/** Registra os usuários ativos agora (GA4) na hora de Brasília correspondente. */
export function recordActive(st: LearnState, now: Date, users: number) {
  if (!(users >= 0)) return;
  st.gaHour ??= new Array(24).fill(0);
  st.gaHourN ??= new Array(24).fill(0);
  const h = brt(now).h;
  st.gaHour[h] = (st.gaHour[h] ?? 0) + users;
  st.gaHourN[h] = (st.gaHourN[h] ?? 0) + 1;
}

/** curva típica de portal de notícias regional (até ter dados próprios) */
const DEFAULT_CURVE = [2, 1, 1, 1, 1, 3, 6, 9, 8, 7, 7, 8, 10, 9, 7, 6, 6, 7, 9, 10, 10, 9, 7, 4];

export function audienceCurve(st: LearnState): { curve: number[]; source: string } {
  const measured = st.siteHourN.filter((n) => n > 0).length;
  const site = st.siteHour.map((s, i) => (st.siteHourN[i] ? s / st.siteHourN[i]! : 0));
  const norm = (a: number[]) => {
    const max = Math.max(...a, 1e-9);
    return a.map((x) => x / max);
  };
  const parts: { a: number[]; w: number; name: string }[] = [];
  // a medida mais direta: gente no site em cada hora (Google Analytics 4)
  const gaMeasured = (st.gaHourN ?? []).filter((n) => n > 0).length;
  if (st.gaHour && st.gaHourN && gaMeasured >= 18) parts.push({ a: norm(st.gaHour.map((s, i) => (st.gaHourN![i] ? s / st.gaHourN![i]! : 0))), w: 2, name: 'usuários ativos no site (Google Analytics)' });
  // site só entra com as 24 horas razoavelmente medidas (horas sem dado puxariam o pico)
  if (measured >= 18) parts.push({ a: norm(site), w: 1, name: 'acessos do site' });
  if (st.igHour && st.igHour.some((x) => x > 0)) parts.push({ a: norm(st.igHour), w: 1, name: 'seguidores online no Instagram' });
  if (!parts.length) return { curve: norm(DEFAULT_CURVE), source: 'curva padrão de portal de notícias (ainda medindo a audiência real)' };
  const curve = new Array(24).fill(0).map((_, h) => parts.reduce((s, p) => s + p.a[h]! * p.w, 0) / parts.reduce((s, p) => s + p.w, 0));
  return { curve, source: parts.map((p) => p.name).join(' + ') };
}

/**
 * Horários de disparo: os `k` maiores picos (com pelo menos 3 h entre eles,
 * entre 6h e 23h), menos `leadMin` minutos.
 */
export function postingSlots(st: LearnState, k = 4, leadMin = 25): { slots: string[]; peaks: number[]; source: string } {
  const { curve, source } = audienceCurve(st);
  // suaviza (média com vizinhas) para não pegar pico solto
  const smooth = curve.map((v, h) => (curve[(h + 23) % 24]! + 2 * v + curve[(h + 1) % 24]!) / 4);
  const order = smooth.map((v, h) => ({ v, h })).filter((x) => x.h >= 6 && x.h <= 23).sort((a, b) => b.v - a.v);
  const peaks: number[] = [];
  for (const o of order) {
    if (peaks.length >= k) break;
    if (peaks.every((p) => Math.abs(p - o.h) >= 3)) peaks.push(o.h);
  }
  peaks.sort((a, b) => a - b);
  const slots = peaks.map((h) => {
    const t = h * 60 - leadMin;
    const hh = Math.floor(((t % 1440) + 1440) % 1440 / 60);
    const mm = ((t % 60) + 60) % 60;
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  });
  return { slots, peaks, source };
}

/** É hora de postar? (dentro de [horário-5min, horário+janela] e ainda não usado hoje) */
export function dueSlot(st: LearnState, now: Date, windowMin = 35, k = 4): string | null {
  const { slots } = postingSlots(st, k);
  const { h, m, day } = brt(now);
  const nowMin = h * 60 + m;
  for (const s of slots) {
    const [hh, mm] = s.split(':').map(Number);
    const t = hh! * 60 + mm!;
    if (nowMin >= t - 5 && nowMin <= t + windowMin && !st.slotsUsed.includes(`${day} ${s}`)) return `${day} ${s}`;
  }
  return null;
}

export function postsToday(st: LearnState, now: Date): number {
  const day = brt(now).day;
  return st.stories.filter((s) => brt(new Date(s.postedAt)).day === day).length;
}

// ---------------------------------------------------------------- desempenho

const MATURE_H = 36;

/** Mede as matérias com 36 h+ que ainda não foram medidas. Devolve quantas mediu. */
export function measure(st: LearnState, now: Date, siteViews: Map<number, number>, igViews: Map<string, number>): number {
  let n = 0;
  for (const s of st.stories) {
    if (s.measuredAt) continue;
    if ((now.getTime() - new Date(s.postedAt).getTime()) / 3600_000 < MATURE_H) continue;
    const sv = s.siteId ? siteViews.get(s.siteId) : undefined;
    const iv = s.igId ? igViews.get(s.igId) : undefined;
    if (sv === undefined && iv === undefined) continue;
    s.siteViews = sv;
    s.igViews = iv;
    s.measuredAt = now.toISOString();
    n++;
  }
  if (n) recomputeWeights(st);
  return n;
}

/** média geométrica (audiência é multiplicativa: 2x melhor e 2x pior se anulam) */
const geoMean = (a: number[]) => (a.length ? Math.exp(a.reduce((s, x) => s + Math.log(x), 0) / a.length) : 0);

/** desempenho relativo de cada matéria medida (1 = matéria típica) */
function relative(st: LearnState): { s: LearnedStory; r: number }[] {
  const measured = st.stories.filter((s) => s.measuredAt);
  const ms = geoMean(measured.map((s) => s.siteViews ?? 0).filter((x) => x > 0));
  const mi = geoMean(measured.map((s) => s.igViews ?? 0).filter((x) => x > 0));
  return measured.map((s) => {
    const parts: number[] = [];
    if (s.siteViews !== undefined && ms > 0) parts.push(s.siteViews / ms);
    if (s.igViews !== undefined && mi > 0) parts.push(s.igViews / mi);
    return { s, r: parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : 1 };
  });
}

const featureKeys = (s: { categoria?: string; city?: string; keywords?: string[]; tom?: string }) => [
  ...(s.categoria ? [`cat:${fold(s.categoria)}`] : []),
  ...(s.city ? [`cid:${fold(s.city)}`] : []),
  ...(s.tom ? [`tom:${fold(s.tom)}`] : []),
  ...(s.keywords ?? []).filter((k) => k.trim().length >= 3).slice(0, 8).map((k) => `kw:${fold(k)}`),
];

export function recomputeWeights(st: LearnState) {
  const acc: Record<string, { n: number; sum: number }> = {};
  for (const { s, r } of relative(st)) {
    // log: 2x melhor e 2x pior pesam igual (opostos)
    const lr = Math.log2(Math.max(0.05, r));
    for (const k of featureKeys(s)) {
      acc[k] ??= { n: 0, sum: 0 };
      acc[k].n++;
      acc[k].sum += lr;
    }
  }
  const w: LearnState['weights'] = {};
  for (const [k, a] of Object.entries(acc)) w[k] = { n: a.n, w: a.sum / (a.n + 2) }; // encolhe para 0 com poucos dados
  st.weights = w;
}

/** pontos extras no ranking de uma pauta pelo que já se aprendeu (−20 a +20) */
export function learnedBoost(st: LearnState, p: { title: string; city?: string | null; categoria?: string; keywords?: string[] }): { pts: number; why: string[] } {
  const title = fold(p.title);
  const why: string[] = [];
  let pts = 0;
  for (const [k, { w, n }] of Object.entries(st.weights)) {
    if (n < 2 || Math.abs(w) < 0.1) continue;
    const [kind, val] = [k.slice(0, 3), k.slice(4)];
    const hit = kind === 'kw' ? title.includes(val) || (p.keywords ?? []).some((x) => fold(x) === val) : kind === 'cid' ? fold(p.city ?? '') === val : kind === 'cat' ? fold(p.categoria ?? '') === val : false;
    if (!hit) continue;
    const add = w * 8;
    pts += add;
    why.push(`${val} (${add > 0 ? '+' : ''}${add.toFixed(0)})`);
  }
  return { pts: Math.max(-20, Math.min(20, pts)), why };
}

const label = (k: string) => {
  const v = k.slice(4);
  return k.startsWith('cat:') ? `editoria ${v}` : k.startsWith('cid:') ? `cidade ${v}` : k.startsWith('tom:') ? `tom ${v}` : `"${v}"`;
};

/** Regras para o redator da IA, a partir do que deu (e não deu) audiência. */
export function writerRules(st: LearnState): string {
  const ranked = Object.entries(st.weights).filter(([, x]) => x.n >= 2);
  if (!ranked.length) return '';
  const best = ranked.filter(([, x]) => x.w > 0.15).sort((a, b) => b[1].w - a[1].w).slice(0, 6);
  const worst = ranked.filter(([, x]) => x.w < -0.15).sort((a, b) => a[1].w - b[1].w).slice(0, 4);
  const rel = relative(st);
  const top = rel.sort((a, b) => b.r - a.r).slice(0, 3).map((x) => `"${x.s.title}" (${x.r.toFixed(1)}x a média)`);
  const lines: string[] = [];
  if (best.length) lines.push(`Assuntos que mais deram audiência: ${best.map(([k, x]) => `${label(k)} (${Math.pow(2, x.w).toFixed(1)}x)`).join(', ')}. Quando a fonte trouxer esses elementos, coloque-os no título e no primeiro parágrafo.`);
  if (worst.length) lines.push(`Renderam menos: ${worst.map(([k]) => label(k)).join(', ')}. Não force esses termos no título.`);
  if (top.length) lines.push(`Títulos que mais funcionaram (inspire-se no formato, não copie): ${top.join('; ')}.`);
  return lines.length ? `APRENDIDO COM AS MATÉRIAS ANTERIORES (sem inventar nada além da fonte):\n- ${lines.join('\n- ')}` : '';
}

export function report(st: LearnState) {
  const { slots, peaks, source } = postingSlots(st);
  return {
    slots,
    peaks,
    source,
    stories: st.stories.length,
    measured: st.stories.filter((s) => s.measuredAt).length,
    rules: writerRules(st),
    top: relative(st)
      .sort((a, b) => b.r - a.r)
      .slice(0, 10)
      .map(({ s, r }) => ({ title: s.title, r: Number(r.toFixed(2)), site: s.siteViews, ig: s.igViews })),
  };
}
