/**
 * Redação da legenda/matéria para o Instagram a partir das notícias encontradas.
 *
 * Etapas (cada uma com reserva, para nunca ficar sem texto):
 * 1. a IA escreve, só com fatos das fontes, em português do Brasil, direto ao ponto;
 * 2. a IA confere a própria legenda contra as fontes e remove o que não está lá;
 * 3. validação anti-"cara de IA" (lista de vícios) — se achar, a IA reescreve;
 * 4. conferência automática de números, datas e nomes contra o texto das fontes
 *    (o que não for encontrado aparece como aviso para o jornalista);
 * 5. limite de caracteres da legenda do Instagram.
 * Sem IA disponível, monta um rascunho simples a partir das próprias manchetes.
 */
import type { ArticleText } from './search';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}
export type Chat = (messages: ChatMessage[], opts?: { json?: boolean; maxTokens?: number; /** para o painel de gastos */ label?: string }) => Promise<{ content: string; model: string; /** custo desta chamada em dólar */ costUsd?: number }>;

export interface StoryResult {
  text: string;
  /** dados da legenda que não foram encontrados nas fontes */
  unverified: string[];
  /** vícios de texto de IA que sobraram (normalmente vazio) */
  style: string[];
  model: string | null;
  steps: string[];
  /** custo total da IA nesta matéria (US$) */
  costUsd: number;
}

/** limite da legenda do Instagram */
export const IG_LIMIT = 2200;
const TARGET = 2000;

export const SYSTEM_PROMPT = `Você é redator do portal Primeiras Notícias (Paraíba, Brasil). Escreva em português do Brasil, no estilo de portal de notícias regional, direto ao ponto.

REGRAS OBRIGATÓRIAS
1. Use SOMENTE informações que estão nas FONTES. Não invente nem deduza nomes, idades, números, horários, datas, locais, causas, motivações, citações ou desdobramentos. Se não estiver nas fontes, não escreva.
2. Traga o máximo de detalhes concretos das fontes: o que aconteceu, quem, quando, onde, como, números, órgãos e autoridades envolvidos, e falas entre aspas apenas se estiverem nas fontes.
3. A primeira frase do corpo já conta o fato principal. Sem introdução, sem contexto genérico, sem opinião, sem conclusão, sem "moral da história".
8. CADA PARÁGRAFO TRAZ INFORMAÇÃO NOVA: nunca repita o fato principal com outras palavras (ex.: abrir com "PM salva homem que caiu do prédio" e no 2º parágrafo dizer de novo "o homem caiu e o PM salvou" é PROIBIDO). Depois do primeiro parágrafo, siga com os DETALHES que estão nas fontes, nesta ordem, só o que existir: como aconteceu passo a passo (horário, local exato, rua, bairro), quem são os envolvidos (nome, idade, profissão, cargo), o que disseram (falas entre aspas, atribuídas), o que a polícia/órgão fez (prisão, delegacia, perícia, hospital, estado de saúde), números, antecedentes/contexto citado nas fontes e o que acontece a seguir. Use TODOS os dados concretos das fontes; se as fontes forem várias, junte os detalhes de todas. Texto jornalístico, fluido, sem ser seco: frases ligadas com sentido, não uma lista de frases soltas.
4. Frases curtas, voz ativa, parágrafos de 1 a 3 frases.
5. PROIBIDO: conselhos ou recomendações ao leitor (só se forem fala de autoridade presente nas fontes, entre aspas e atribuída), travessão (—), emojis, ponto de exclamação, perguntas retóricas e estas expressões: "vale ressaltar", "vale destacar", "é importante destacar", "é importante ressaltar", "em meio a", "chocou a comunidade", "trágico", "cenário", "crucial", "fundamental", "não apenas", "mas também", "em suma", "em resumo", "confira", "fique ligado", "desdobramentos ainda são aguardados".
6. Se as fontes divergirem num dado, atribua cada versão ao veículo ("segundo o [veículo]"), sem misturar números de fontes diferentes.
7. Revise ortografia e acentuação.

FORMATO (legenda do Instagram)
Linha 1: manchete em letras normais (com maiúscula só no início e em nomes próprios), até 90 caracteres. O app converte para maiúsculas.
Linha em branco.
Corpo: de 2 a 5 parágrafos curtos.
Linha em branco.
Exatamente 5 hashtags relacionadas ao fato (sem inventar local).
NÃO escreva linha de fonte ou créditos: o app acrescenta os créditos no rodapé automaticamente.

No máximo ${TARGET} caracteres no total. Responda apenas com a legenda, sem comentários.`;

const FACT_PROMPT = `Você é checador de fatos de uma redação. Compare a LEGENDA com as FONTES.
1. Liste toda informação da legenda que NÃO aparece nas fontes (nomes, números, idades, datas, horários, locais, causas, falas, qualificações).
2. Quando as fontes divergirem num dado (números, horários, nomes), não misture: atribua cada versão ao seu veículo ("segundo o G1...") ou use só a versão confirmada por mais fontes.
3. Corrija qualquer erro de ortografia, acentuação ou digitação. A manchete (1ª linha) fica em letras normais.
4. Devolva a legenda corrigida: remova ou ajuste só esses trechos. Não acrescente nada novo. Mantenha o formato, as regras de estilo e o tamanho.
Responda SOMENTE com JSON válido, sem comentários: {"problemas": ["..."], "legenda": "..."}`;

const SPELL_PROMPT = `Você é revisor de português do Brasil. Corrija SOMENTE erros de ortografia, acentuação, concordância e digitação do texto. Não mude palavras corretas, não reescreva frases, não acrescente nem remova informação, mantenha quebras de linha e hashtags. Responda só com o texto revisado.`;

/** Remove frases repetidas (a IA às vezes repete um dado em dois parágrafos). */
export function dedupeSentences(text: string): string {
  const seen = new Set<string>();
  return text
    .split('\n')
    .map((line) => {
      if (/^\s*(#|fontes?:|cr[ée]ditos:|com informa)/i.test(line) || !line.trim()) return line;
      const parts = line.match(/[^.!?]+[.!?]*\s*/g) ?? [line];
      return parts
        .filter((s) => {
          const k = s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9%]/g, '');
          if (k.length < 12) return true;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        })
        .join('')
        .trim();
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

/** 1ª linha (manchete) em maiúsculas, feita pelo app (a IA erra palavras em CAIXA ALTA). */
export function headlineUpper(text: string): string {
  const lines = text.split('\n');
  const i = lines.findIndex((l) => l.trim());
  if (i >= 0 && !/^\s*(#|fontes?:|cr[ée]ditos:|com informa)/i.test(lines[i]!)) lines[i] = lines[i]!.replace(/\*+/g, '').trim().toLocaleUpperCase('pt-BR');
  return lines.join('\n');
}

const FOOTER_LINE = /^\s*(fontes?:|cr[ée]ditos:|com informa[cç][õo]es de)/i;

/** Nome legível do veículo (sem "www." nem domínio quando for só o endereço). */
export function outletName(source: string): string {
  const s = source.trim().replace(/^www\./i, '');
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(s) ? s.replace(/\.(com|org|net)(\.br)?$|\.br$/i, '') : s;
}

/** Linha de créditos do rodapé, com os veículos de onde a matéria foi tirada. */
export function creditsLine(sources: { source: string }[]): string {
  const names = [...new Set(sources.map((s) => outletName(s.source)).filter(Boolean))].slice(0, 6);
  return names.length ? `Créditos: ${names.join(' · ')}` : '';
}

/** Linha de fonte/créditos e hashtags do fim da legenda. */
export function footerOf(text: string): { fonte: string; tags: string } {
  const lines = text.split('\n');
  const fonte = lines.find((l) => FOOTER_LINE.test(l))?.trim() ?? '';
  const tags = lines.filter((l) => /^\s*#/.test(l)).join(' ').trim();
  return { fonte, tags };
}

/**
 * Rodapé arrumado: corpo, linha em branco, créditos (veículos usados), linha em
 * branco, hashtags. Os créditos são montados pelo app (não pela IA).
 */
export function ensureFooter(text: string, footer: { fonte: string; tags: string }, sources: ArticleText[]): string {
  const lines = text.split('\n');
  const tags = lines.filter((l) => /^\s*#/.test(l)).join(' ').trim() || footer.tags;
  const body = lines
    .filter((l) => !/^\s*#/.test(l) && !FOOTER_LINE.test(l))
    .join('\n')
    .trim();
  const credits = creditsLine(sources);
  return [body, credits, tags].filter(Boolean).join('\n\n');
}

/** Vícios típicos de texto gerado por IA em português (e coisas proibidas na legenda). */
const SLOP: [RegExp, string][] = [
  [/—/, 'travessão (—)'],
  [/!/, 'ponto de exclamação'],
  [/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, 'emoji'],
  [/vale (ressaltar|destacar|lembrar)/i, '"vale ressaltar/destacar"'],
  [/é importante (destacar|ressaltar|mencionar|lembrar)/i, '"é importante destacar"'],
  [/em meio a/i, '"em meio a"'],
  [/chocou (a|toda a) (comunidade|cidade|população)/i, '"chocou a comunidade"'],
  [/\btrágic[oa]\b/i, '"trágico"'],
  [/\bcenário\b/i, '"cenário"'],
  [/\bcrucia(l|is)\b/i, '"crucial"'],
  [/\bfundamenta(l|is)\b/i, '"fundamental"'],
  [/não apenas[\s\S]{0,80}mas também/i, '"não apenas... mas também"'],
  [/\bem (suma|resumo)\b/i, '"em suma/em resumo"'],
  [/\bconfira\b/i, '"confira"'],
  [/fique (ligado|atento)/i, '"fique ligado"'],
  [/\bmergulh/i, '"mergulhar"'],
  [/\bjornada\b/i, '"jornada"'],
  [/\bdesvend/i, '"desvendar"'],
  [/\?\s/, 'pergunta retórica'],
  [/\bpor fim,/i, '"por fim,"'],
  [/sem precedentes/i, '"sem precedentes"'],
  [/reforça a importância/i, '"reforça a importância"'],
  [/recomenda-se|é (aconselhável|recomendável)|não se esqueça|lembre-se de/i, 'conselho ao leitor (enrolação)'],
];

export function slopIssues(text: string): string[] {
  const out = SLOP.filter(([re]) => re.test(text)).map(([, label]) => label);
  // conectivos repetidos demais
  const many = (re: RegExp, n: number, label: string) => {
    if ((text.match(re) ?? []).length > n) out.push(label);
  };
  many(/\balém disso\b/gi, 1, '"além disso" repetido');
  many(/\bno entanto\b/gi, 1, '"no entanto" repetido');
  const rep = repeatedParagraphs(text.split(/\n+/).filter((l) => l.trim() && !/^\s*#/.test(l)));
  if (rep.length) out.push(`parágrafo ${rep.map((r) => r + 1).join(', ')} repete o que já foi dito (traga um detalhe novo das fontes no lugar)`);
  return out;
}

/** palavras com conteúdo (4+ letras, sem as comuns) */
function contentWords(s: string): Set<string> {
  const fold = s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  return new Set(fold.split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !COMMON.has(w)));
}
const COMMON = new Set(['para', 'pela', 'pelo', 'como', 'mais', 'esta', 'este', 'essa', 'esse', 'isso', 'onde', 'quando', 'sobre', 'entre', 'ainda', 'tambem', 'foram', 'sido', 'segundo', 'apos', 'durante', 'contra', 'desde', 'mesmo', 'muito', 'pode', 'ser', 'havia', 'teve', 'seus', 'suas', 'dele', 'dela']);

/**
 * Parágrafos que repetem um anterior (a mesma informação com outras palavras):
 * a maior parte das palavras com conteúdo já apareceu num parágrafo anterior.
 */
export function repeatedParagraphs(paragraphs: string[]): number[] {
  const sets = paragraphs.map(contentWords);
  const out: number[] = [];
  for (let i = 1; i < sets.length; i++) {
    const cur = sets[i]!;
    if (cur.size < 4) continue;
    for (let j = 0; j < i; j++) {
      let shared = 0;
      for (const w of cur) if (sets[j]!.has(w)) shared++;
      if (shared >= 4 && shared / cur.size >= 0.6) {
        out.push(i);
        break;
      }
    }
  }
  return out;
}

/** Correções automáticas finais (seguras): travessão, exclamação, espaços. */
export function cleanText(text: string): string {
  return text
    .replace(/\s*—\s*/g, ', ')
    .replace(/!+/g, '.')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]️?/gu, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/ {2,}/g, ' ')
    .trim();
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9%,.:/ ]/g, ' ')
    .replace(/\s+/g, ' ');

const STOP = new Set(['fonte', 'fontes', 'segundo', 'de', 'da', 'do', 'das', 'dos', 'em', 'no', 'na', 'nos', 'nas', 'o', 'a', 'os', 'as', 'e', 'um', 'uma', 'com', 'por', 'para', 'que', 'ao', 'pela', 'pelo']);

/**
 * Conferência automática: números e nomes próprios da legenda que não aparecem
 * no texto das fontes (sinal de possível invenção).
 */
export function unverifiedFacts(text: string, sources: ArticleText[]): string[] {
  const corpus = norm(sources.map((s) => `${s.title} ${s.source} ${s.text}`).join(' '));
  const body = text
    .split('\n')
    .filter((l) => !/^\s*(fonte|cr[ée]dito|com informa|#)/i.test(l))
    .join('\n');
  const found = new Set<string>();
  // números (idade, quantidades, horários, valores)
  for (const m of body.matchAll(/\d+(?:[.,:h]\d+)*/g)) {
    const n = m[0];
    if (!corpus.includes(norm(n).trim())) found.add(n);
  }
  // nomes próprios (sequências com inicial maiúscula fora do início de frase)
  const words = body.split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!.replace(/[^\p{L}-]/gu, '');
    if (!/^\p{Lu}\p{Ll}/u.test(w)) continue;
    const prev = words[i - 1] ?? '';
    if (i === 0 || /[.:\n]$/.test(prev)) continue; // início de frase
    let name = w;
    while (i + 1 < words.length && !/[.,;:!?)\]]$/.test(words[i]!)) {
      const nx = words[i + 1]!.replace(/[^\p{L}-]/gu, '');
      if (/^\p{Lu}\p{Ll}/u.test(nx) || (['de', 'da', 'do', 'dos', 'das'].includes(nx) && /^\p{Lu}/u.test((words[i + 2] ?? '').replace(/[^\p{L}]/gu, '')))) {
        name += ' ' + nx;
        i++;
      } else break;
    }
    if (STOP.has(name.toLowerCase())) continue;
    if (!corpus.includes(norm(name).trim())) found.add(name);
  }
  return [...found].slice(0, 12);
}

/** Corta no limite do Instagram sem quebrar no meio de uma frase. */
export function fitLimit(text: string, limit = IG_LIMIT): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const end = Math.max(cut.lastIndexOf('\n\n'), cut.lastIndexOf('. '));
  return (end > limit * 0.6 ? cut.slice(0, end + 1) : cut).trim();
}

function sourcesBlock(query: string, sources: ArticleText[]): string {
  const parts = sources.map((s, i) => {
    const date = s.date ? new Date(s.date).toLocaleDateString('pt-BR') : 'sem data';
    return `[${i + 1}] ${s.source} — ${s.title} — ${date}\n${s.url}\nTexto: ${s.text || '(só a manchete)'}`;
  });
  return `Pauta pedida pelo jornalista: ${query}\n\nFONTES:\n${parts.join('\n\n')}`;
}

/** Rascunho sem IA (reserva final): manchete + resumo das fontes. */
export function templateStory(query: string, sources: ArticleText[]): string {
  const main = sources[0];
  if (!main) return '';
  const lead = (main.text || main.title).split(/(?<=\.)\s+/).slice(0, 3).join(' ');
  const tags = query
    .split(/[\s,]+/)
    .filter((w) => w.length > 3 && !/^\d/.test(w))
    .slice(0, 3)
    .map((w) => '#' + w.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w]/g, ''));
  return fitLimit(cleanText(`${main.title.toLocaleUpperCase('pt-BR')}\n\n${lead}\n\n${creditsLine(sources)}\n\n${['#PrimeirasNoticias', ...tags].join(' ')}`));
}

function parseJson(content: string): { problemas?: string[]; legenda?: string } | null {
  const m = /\{[\s\S]*\}/.exec(content);
  if (!m) return null;
  try {
    return JSON.parse(m[0]) as { problemas?: string[]; legenda?: string };
  } catch {
    return null;
  }
}

export async function writeStory(query: string, sources: ArticleText[], rawChat: Chat | null, extraPrompt = ''): Promise<StoryResult> {
  const steps: string[] = [];
  let costUsd = 0;
  const chat: Chat | null = rawChat
    ? async (m, o) => {
        const r = await rawChat(m, o);
        costUsd += r.costUsd ?? 0;
        return r;
      }
    : null;
  const usable = sources.filter((s) => s.title);
  if (!usable.length) return { text: '', unverified: [], style: [], model: null, steps: ['Nenhuma fonte para escrever.'], costUsd: 0 };
  const block = sourcesBlock(query, usable);
  let text = '';
  let model: string | null = null;
  if (chat) {
    try {
      const sys = extraPrompt.trim() ? `${SYSTEM_PROMPT}\n\nPEDIDO DO JORNALISTA (siga sem quebrar as regras acima): ${extraPrompt.trim()}` : SYSTEM_PROMPT;
      const r = await chat(
        [
          { role: 'system', content: sys },
          { role: 'user', content: block },
        ],
        { maxTokens: 1800 },
      );
      text = cleanText(r.content);
      model = r.model;
      steps.push(`Escrita: ${r.model}`);
    } catch (e) {
      steps.push(`IA indisponível (${(e as Error).message}); usado rascunho automático.`);
    }
  }
  if (!text) {
    return { text: templateStory(query, usable), unverified: [], style: [], model: null, steps: [...steps, 'Rascunho montado a partir das manchetes (sem IA).'], costUsd };
  }
  const footer = footerOf(text);
  // 2) checagem de fatos pela IA
  if (chat) {
    try {
      const r = await chat(
        [
          { role: 'system', content: FACT_PROMPT },
          { role: 'user', content: `${block}\n\nLEGENDA:\n${text}` },
        ],
        { json: true, maxTokens: 2200 },
      );
      const j = parseJson(r.content);
      if (j?.legenda && j.legenda.length > 80) {
        text = cleanText(j.legenda);
        steps.push(j.problemas?.length ? `Checagem removeu/ajustou: ${j.problemas.slice(0, 6).join('; ')}` : 'Checagem: nenhum dado fora das fontes.');
      } else steps.push('Checagem da IA não respondeu no formato esperado (mantido o texto).');
    } catch {
      steps.push('Checagem da IA indisponível (feita só a conferência automática).');
    }
  }
  // 2b) revisão ortográfica (só ortografia; se mexer demais, descarta)
  if (chat) {
    try {
      const r = await chat(
        [
          { role: 'system', content: SPELL_PROMPT },
          { role: 'user', content: text },
        ],
        { maxTokens: 1800 },
      );
      const t2 = cleanText(r.content);
      if (t2.length > 80 && Math.abs(t2.length - text.length) / text.length < 0.08) {
        if (t2 !== text) steps.push('Revisão ortográfica aplicada.');
        text = t2;
      }
    } catch {
      /* segue sem a revisão */
    }
  }

  // 3) anti-"cara de IA"
  let style = slopIssues(text);
  if (style.length && chat) {
    try {
      const r = await chat(
        [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `${block}\n\nReescreva esta legenda sem estes problemas: ${style.join(', ')}. Não acrescente nenhuma informação nova, mantenha os fatos e o formato.\n\nLEGENDA:\n${text}` },
        ],
        { maxTokens: 1800 },
      );
      const t2 = cleanText(r.content);
      if (t2.length > 80) text = t2;
      steps.push(`Revisão de estilo: ${style.join(', ')}`);
    } catch {
      /* segue com a limpeza automática */
    }
  }
  text = fitLimit(headlineUpper(ensureFooter(dedupeSentences(cleanText(text)), footer, usable)));
  style = slopIssues(text);
  // 4) conferência automática contra as fontes
  const unverified = unverifiedFacts(text, usable);
  if (unverified.length) steps.push(`Conferir nas fontes: ${unverified.join(', ')}`);
  return { text, unverified, style, model, steps, costUsd };
}
