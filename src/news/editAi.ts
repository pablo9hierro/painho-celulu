/**
 * Edição por comando de voz/texto: a IA (OpenRouter) não "assiste" o vídeo —
 * ela recebe a LISTA DOS ITENS da timeline (tipo, nome, início, duração) e,
 * quando existe transcrição (legendas já geradas), o texto falado com o tempo
 * de cada frase, para entender pedidos como "corte quando ele falar X". A
 * partir disso, ela devolve uma pequena lista de AÇÕES de um vocabulário fixo,
 * que o app aplica de verdade na timeline com o mesmo código do editor manual
 * (cortar, mudar velocidade, criar manchete, dar zoom/pan, desfocar).
 *
 * Isso evita depender de um modelo caro de visão por vídeo: o controle fica
 * com o jornalista (ele diz O QUÊ e QUANDO pelo comando de voz) e a IA só
 * traduz a fala em passos — rápido, barato e confiável.
 */
import { z } from 'zod';
import type { Chat } from './writer';
import { HEADLINE_PRESETS } from '../core/presets';
import type { Clip, Project } from '../core/model';
import { clipEnd, deleteClips, findClip, projectDuration, setSpeed, splitClip } from '../core/timeline';
import { createBlurClip, createTextClip } from '../core/factory';
import { placeClip } from '../core/timeline';
import { effectiveTransform, updateClip } from '../core/edit';
import type { VisualClip } from '../core/model';

const ActionSchema = z.discriminatedUnion('tipo', [
  z.object({ tipo: z.literal('cortar'), inicio: z.number().min(0), fim: z.number().min(0) }),
  z.object({ tipo: z.literal('velocidade'), clipId: z.string(), fator: z.number().min(0.25).max(4) }),
  z.object({
    tipo: z.literal('manchete'),
    preset: z.string(),
    texto: z.string().min(1).max(140),
    inicio: z.number().min(0),
    duracao: z.number().min(0.5).max(30),
  }),
  z.object({
    tipo: z.literal('zoom'),
    clipId: z.string(),
    inicio: z.number().min(0),
    duracao: z.number().min(0.3).max(20),
    direcao: z.enum(['aproximar', 'afastar']),
    foco: z.enum(['centro', 'esquerda', 'direita', 'topo', 'base']),
  }),
  z.object({
    tipo: z.literal('desfoque'),
    inicio: z.number().min(0),
    duracao: z.number().min(0.3).max(30),
    area: z.enum(['centro', 'topo', 'base', 'esquerda', 'direita', 'tudo']),
  }),
  z.object({ tipo: z.literal('excluir'), clipId: z.string() }),
]);
export type EditAction = z.infer<typeof ActionSchema>;

export interface EditContext {
  duration: number;
  clips: { id: string; tipo: string; nome: string; inicio: number; duracao: number }[];
  /** frase, tempo e quem fala (se já houver legendas geradas) */
  falas: { inicio: number; fim: number; falante: number; texto: string }[];
}

export function buildContext(p: Project): EditContext {
  const clips = p.clips
    .filter((c) => c.type !== 'frame')
    .map((c) => ({ id: c.id, tipo: c.type, nome: c.name, inicio: Math.round(c.start * 10) / 10, duracao: Math.round(c.duration * 10) / 10 }))
    .sort((a, b) => a.inicio - b.inicio);
  const falas = p.clips
    .filter((c): c is Extract<Clip, { type: 'text' }> => c.type === 'text' && c.preset === 'pn-legenda')
    .map((c) => ({ inicio: Math.round(c.start * 10) / 10, fim: Math.round((c.start + c.duration) * 10) / 10, falante: c.caption?.speaker ?? 1, texto: c.fields.title }))
    .sort((a, b) => a.inicio - b.inicio);
  return { duration: Math.round(projectDuration(p) * 10) / 10, clips, falas };
}

const PRESET_LIST = HEADLINE_PRESETS.filter((p) => !p.hidden && p.category !== 'encerramento').map((p) => `${p.id} (${p.name}: ${p.description})`);

function prompt(ctx: EditContext): string {
  return [
    'Você edita um vídeo de notícia a partir de um comando falado pelo jornalista. Responda SÓ com JSON: {"acoes":[...]}.',
    'Vocabulário das ações (use só isto, em português):',
    '- {"tipo":"cortar","inicio":N,"fim":N}: remove o trecho de N a N segundos de TODO o vídeo (todas as camadas), juntando o que sobra.',
    '- {"tipo":"velocidade","clipId":"...","fator":N}: muda a velocidade de um item (0.25 a 4; 1 = normal, 2 = dobro, 0.5 = câmera lenta).',
    `- {"tipo":"manchete","preset":"um id da lista abaixo","texto":"...","inicio":N,"duracao":N}: cria uma manchete/elemento de texto.`,
    '- {"tipo":"zoom","clipId":"...","inicio":N,"duracao":N,"direcao":"aproximar"|"afastar","foco":"centro"|"esquerda"|"direita"|"topo"|"base"}: dá um zoom (Pan/Crop) num vídeo ou imagem.',
    '- {"tipo":"desfoque","inicio":N,"duracao":N,"area":"centro"|"topo"|"base"|"esquerda"|"direita"|"tudo"}: borra uma parte do quadro (ex.: cobrir um rosto ou uma logo).',
    '- {"tipo":"excluir","clipId":"..."}: remove um item inteiro (ex.: uma manchete ou desfoque que não serve mais).',
    `Manchetes disponíveis: ${PRESET_LIST.join(' | ')}`,
    `O vídeo dura ${ctx.duration}s. Itens na timeline (id, tipo, nome, início, duração): ${JSON.stringify(ctx.clips)}`,
    ctx.falas.length ? `O que é falado, com o tempo exato (use para entender "quando ele fala X"): ${JSON.stringify(ctx.falas)}` : 'Ainda não há transcrição da fala neste projeto: para comandos que dependam do que é falado, avise no "aviso".',
    'Nunca invente um clipId que não está na lista. Se o pedido não fizer sentido com o que existe, devolva "acoes":[] e explique em "aviso".',
    'Responda: {"acoes":[...], "aviso": "opcional, uma frase curta se algo não pôde ser feito"}',
  ].join('\n');
}

export interface PlanResult {
  actions: EditAction[];
  aviso?: string;
  costUsd: number;
}

/** Transforma UM comando falado em ações. Uma chamada por comando (mais confiável que juntar vários). */
export async function planEdit(chat: Chat, ctx: EditContext, comando: string): Promise<PlanResult> {
  const r = await chat(
    [
      { role: 'system', content: prompt(ctx) },
      { role: 'user', content: comando },
    ],
    { json: true, maxTokens: 900, label: 'editar vídeo' },
  );
  let j: { acoes?: unknown[]; aviso?: string } = {};
  try {
    j = JSON.parse(/\{[\s\S]*\}/.exec(r.content)?.[0] ?? '{}');
  } catch {
    return { actions: [], aviso: 'Não entendi o comando; tente de novo com outras palavras.', costUsd: r.costUsd ?? 0 };
  }
  const known = new Set(ctx.clips.map((c) => c.id));
  const actions: EditAction[] = [];
  for (const raw of j.acoes ?? []) {
    const parsed = ActionSchema.safeParse(raw);
    if (!parsed.success) continue;
    const a = parsed.data;
    if ('clipId' in a && !known.has(a.clipId)) continue;
    actions.push(a);
  }
  return { actions, aviso: j.aviso, costUsd: r.costUsd ?? 0 };
}

// ---------------------------------------------------------------- aplica de verdade na timeline

/** Remove um trecho de TODO o projeto (todas as camadas), fechando o espaço. */
export function cutRange(p: Project, inicio: number, fim: number): Project {
  const a = Math.min(inicio, fim);
  const b = Math.max(inicio, fim);
  if (b - a < 0.05) return p;
  let project = p;
  // corta cada item que cruza as bordas a/b, nas duas pontas
  for (const edge of [a, b]) {
    for (const c of [...project.clips]) {
      if (c.start < edge - 1e-3 && clipEnd(c) > edge + 1e-3) project = splitClip(project, c.id, edge).project;
    }
  }
  const middle = project.clips.filter((c) => c.start >= a - 1e-3 && clipEnd(c) <= b + 1e-3);
  project = deleteClips(project, middle.map((c) => c.id));
  // fecha o buraco em TODAS as camadas (o corte vale para o vídeo inteiro)
  const span = b - a;
  project = { ...project, clips: project.clips.map((c) => (c.start >= b - 1e-3 ? { ...c, start: Math.max(0, c.start - span) } : c)) };
  return project;
}

const FOCUS: Record<string, { x: number; y: number }> = {
  centro: { x: 0, y: 0 },
  esquerda: { x: -1, y: 0 },
  direita: { x: 1, y: 0 },
  topo: { x: 0, y: -1 },
  base: { x: 0, y: 1 },
};

/** Zoom/Pan de câmera num clipe: dois nós (início e fim) com Pan/Crop, igual ao editor manual. */
function applyZoom(p: Project, a: Extract<EditAction, { tipo: 'zoom' }>): Project {
  const clip = findClip(p, a.clipId);
  if (!clip || (clip.type !== 'video' && clip.type !== 'image')) return p;
  const relStart = Math.max(0, a.inicio - clip.start);
  const relEnd = Math.min(clip.duration, relStart + a.duracao);
  const base = effectiveTransform(clip, relStart);
  const scale = a.direcao === 'aproximar' ? 1.28 : 1 / 1.28;
  const f = FOCUS[a.foco] ?? FOCUS.centro!;
  const target = {
    ...base,
    width: base.width * scale,
    height: base.height * scale,
    x: base.x + (f.x * base.width * (scale - 1)) / 2,
    y: base.y + (f.y * base.height * (scale - 1)) / 2,
  };
  const kept = clip.keyframes.filter((k) => k.t < relStart - 0.05 || k.t > relEnd + 0.05);
  const keyframes = [...kept, { ...base, t: relStart, easing: 'ease-out' as const }, { ...target, t: relEnd, easing: 'ease-out' as const }].sort((x, y) => x.t - y.t);
  const hadKeyframes = clip.keyframes.length > 0;
  return updateClip<VisualClip>(p, clip.id, (c) => ({ ...c, keyframes, transform: hadKeyframes ? c.transform : base }));
}

const AREA: Record<string, { x: number; y: number; width: number; height: number }> = {
  centro: { x: 0.5, y: 0.5, width: 0.5, height: 0.3 },
  topo: { x: 0.5, y: 0.16, width: 1, height: 0.3 },
  base: { x: 0.5, y: 0.84, width: 1, height: 0.3 },
  esquerda: { x: 0.2, y: 0.5, width: 0.4, height: 1 },
  direita: { x: 0.8, y: 0.5, width: 0.4, height: 1 },
  tudo: { x: 0.5, y: 0.5, width: 1, height: 1 },
};

/** Aplica as ações na ordem (puro: fácil de testar e de repetir). */
export function applyEditActions(p: Project, actions: EditAction[]): Project {
  let project = p;
  for (const a of actions) {
    if (a.tipo === 'cortar') project = cutRange(project, a.inicio, a.fim);
    else if (a.tipo === 'velocidade') project = setSpeed(project, a.clipId, a.fator);
    else if (a.tipo === 'excluir') project = deleteClips(project, [a.clipId], true);
    else if (a.tipo === 'zoom') project = applyZoom(project, a);
    else if (a.tipo === 'manchete') {
      if (!HEADLINE_PRESETS.some((pr) => pr.id === a.preset)) continue;
      const c = createTextClip(project, a.preset, Math.max(0, a.inicio));
      c.duration = a.duracao;
      c.fields = { ...c.fields, title: a.texto };
      project = placeClip(project, c);
    } else if (a.tipo === 'desfoque') {
      const area = AREA[a.area] ?? AREA.centro!;
      const rect = { x: area.x * project.width, y: area.y * project.height, width: area.width * project.width, height: area.height * project.height };
      const c = createBlurClip(project, rect, Math.max(0, a.inicio));
      c.duration = a.duracao;
      project = placeClip(project, c);
    }
  }
  return project;
}
