/**
 * Matéria para o SITE (Primeiras Notícias / WEBSG) a partir de uma pauta
 * capturada: título, subtítulo, chapéu, categoria, palavras-chave e texto,
 * só com fatos da fonte, conferidos, sem "cara de IA" — e com as IMAGENS da
 * matéria original nas mesmas posições (parágrafo, imagem, parágrafo...).
 */
import type { Block, Pauta } from './pautas';
import { cleanText, slopIssues, unverifiedFacts, type Chat } from './writer';

export const CATEGORIAS = ['Policial', 'Política', 'Cidades', 'Esporte', 'Economia', 'Saúde', 'Educação', 'Cultura', 'Brasil', 'Mundo', 'Entretenimento'] as const;

export interface SiteStory {
  titulo: string;
  subtitulo: string;
  /** chapéu curto acima do título (ex.: POLÍCIA) */
  minititulo: string;
  categoria: string;
  palavrasChave: string[];
  paragrafos: string[];
  /** imagens que entram na matéria (só as que deu para baixar) */
  imagens: { src: string; caption: string }[];
  /** texto final em HTML, com as imagens nos lugares e os créditos */
  html: string;
  unverified: string[];
  style: string[];
  model: string | null;
  steps: string[];
  costUsd: number;
  /** tom escolhido pela IA (entre os cadastrados) e o nome do áudio */
  tom?: string;
  audio?: string;
  /** trecho do título destacado no post em vídeo (só se estiver mesmo no título) */
  destaque?: string;
}

const SYSTEM = `Você é redator do portal Primeiras Notícias (Paraíba). Reescreva a notícia da FONTE como matéria para o site, em português do Brasil, estilo de portal de notícias, direto ao ponto.
REGRAS
1. Use SOMENTE informações da FONTE. Não invente nem deduza nomes, idades, números, horários, locais, causas, falas ou desdobramentos.
2. Traga o máximo de detalhes concretos da fonte. Falas entre aspas só se estiverem na fonte, atribuídas.
3. Primeiro parágrafo = o fato principal (o quê, quem, onde, quando). Sem introdução genérica, opinião, conselhos ao leitor ou conclusão.
4. Parágrafos curtos (1 a 3 frases), voz ativa, de 5 a 12 parágrafos conforme o tamanho da fonte.
5. PROIBIDO: travessão (—), emojis, exclamação, perguntas retóricas, "vale ressaltar", "é importante destacar", "em meio a", "chocou a comunidade", "trágico", "cenário", "crucial", "fundamental", "não apenas... mas também", "em suma", "confira".
6. Não copie frases inteiras da fonte: reescreva com as mesmas informações.
Responda SOMENTE com JSON:
{"titulo": "até 90 caracteres, letras normais", "subtitulo": "uma frase que complementa o título", "minititulo": "1 a 3 palavras em maiúsculas (ex.: POLÍCIA)", "categoria": "uma de: ${CATEGORIAS.join(', ')}", "palavras_chave": ["5 termos"], "destaque": "o trecho do título (2 a 4 palavras, copiado EXATAMENTE como está no título) que é o coração da notícia, para ser destacado no vídeo (ex.: título 'Bolsonaro não poderá votar no segundo turno' → 'não poderá votar')", "paragrafos": ["..."]}`;

const CHECK = `Você é checador de fatos. Compare a MATÉRIA (JSON) com a FONTE. Remova ou corrija tudo que não está na fonte (nomes, números, datas, locais, causas, falas). Corrija ortografia. Não acrescente nada. Devolva o MESMO formato JSON da matéria, mais "problemas": ["..."].`;

function parse(content: string): Partial<{ titulo: string; subtitulo: string; minititulo: string; categoria: string; palavras_chave: string[]; paragrafos: string[]; problemas: string[]; tom: string; audio: string; destaque: string }> | null {
  const m = /\{[\s\S]*\}/.exec(content);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

/** pedido extra: escolher o tom e o áudio do post em vídeo entre os cadastrados */
function toneRule(tones: ToneOption[]): string {
  const ok = tones.filter((x) => x.audios.length);
  if (!ok.length) return '';
  return `

TOM DO VÍDEO: escolha o tom pelo ASSUNTO real da notícia, comparando com o nome e a "dica" de cada tom (ex.: tom Policial só para crime, prisão, operação policial, violência; política, economia ou cultura NÃO são policiais). Se nenhum tom combinar claramente, escolha o mais geral/neutro da lista. Dentro do tom, escolha o áudio cujo nome combina melhor com o clima (ex.: "urgente" para fato grave e recente). Opções (JSON): ${JSON.stringify(ok)}. Acrescente ao JSON: "tom": "nome exato do tom", "audio": "nome exato do áudio".`;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Posição das imagens: cada imagem da fonte fica depois da mesma fração do
 * texto em que estava (ex.: imagem depois do 2º de 8 parágrafos → depois do
 * parágrafo equivalente na matéria nova). A primeira imagem abre a matéria.
 */
export function placeImages(blocks: Block[], newCount: number): { after: number; src: string; caption: string }[] {
  const total = Math.max(1, blocks.filter((b) => b.type === 'p').length);
  let before = 0;
  const out: { after: number; src: string; caption: string }[] = [];
  for (const b of blocks) {
    if (b.type === 'p') before++;
    else if (b.type === 'img' && b.ok && b.src) {
      const after = out.length === 0 ? 0 : Math.min(newCount, Math.max(1, Math.round((before / total) * newCount)));
      out.push({ after, src: b.src, caption: b.caption ?? '' });
    }
  }
  return out;
}

export function buildHtml(paragrafos: string[], blocks: Block[], source: string, url: string): { html: string; imagens: { src: string; caption: string }[] } {
  const imgs = placeImages(blocks, paragrafos.length);
  const fig = (i: { src: string; caption: string }) =>
    `<figure><img src="${esc(i.src)}" alt="${esc(i.caption || source)}" /><figcaption>${esc(i.caption ? `${i.caption} (Foto: reprodução/${source})` : `Foto: reprodução/${source}`)}</figcaption></figure>`;
  const parts: string[] = [];
  // imagens com after=0 abrem a matéria (a primeira costuma virar a foto principal)
  imgs.filter((i) => i.after === 0).forEach((i) => parts.push(fig(i)));
  paragrafos.forEach((p, k) => {
    parts.push(`<p>${esc(p)}</p>`);
    imgs.filter((i) => i.after === k + 1).forEach((i) => parts.push(fig(i)));
  });
  // vídeos do YouTube entram como vídeo incorporado; outros, como link
  for (const v of blocks.filter((b) => b.type === 'video' && b.src)) {
    const yt = /(?:embed\/|v=|youtu\.be\/)([A-Za-z0-9_-]{6,})/.exec(v.src!)?.[1];
    parts.push(yt ? `<p><iframe width="560" height="315" src="https://www.youtube.com/embed/${yt}" frameborder="0" allowfullscreen></iframe></p>` : `<p>Vídeo: <a href="${esc(v.src!)}" target="_blank" rel="noopener">${esc(v.src!)}</a></p>`);
  }
  parts.push(`<p><em>Com informações de <a href="${esc(url)}" target="_blank" rel="noopener">${esc(source)}</a>.</em></p>`);
  return { html: parts.join('\n'), imagens: imgs.map(({ src, caption }) => ({ src, caption })) };
}

export type ToneOption = { tom: string; dica: string; audios: string[] };

export async function writeSiteStory(p: Pauta, rawChat: Chat | null, prompt = '', tones: ToneOption[] = []): Promise<SiteStory> {
  const steps: string[] = [];
  let costUsd = 0;
  const chat: Chat | null = rawChat
    ? async (m, o) => {
        const r = await rawChat(m, o);
        costUsd += r.costUsd ?? 0;
        return r;
      }
    : null;
  const fonteTexto = p.blocks
    .filter((b) => b.type === 'p')
    .map((b) => b.text)
    .join('\n');
  const fonte = `FONTE: ${p.source} — ${p.title}\n${p.url}\n\n${fonteTexto || p.snippet || p.title}`;
  const sources = [{ url: p.url, title: p.title, source: p.source, date: p.date, text: fonteTexto }];
  let j: ReturnType<typeof parse> = null;
  let model: string | null = null;
  if (chat && fonteTexto.length > 200) {
    try {
      const r = await chat(
        [
          { role: 'system', content: SYSTEM + (prompt.trim() ? `\n\nPEDIDO DO JORNALISTA (sem quebrar as regras): ${prompt.trim()}` : '') + toneRule(tones) },
          { role: 'user', content: fonte },
        ],
        { json: true, maxTokens: 3000 },
      );
      j = parse(r.content);
      model = r.model;
      steps.push(`Escrita: ${r.model}`);
    } catch (e) {
      steps.push(`IA indisponível (${(e as Error).message})`);
    }
    if (j?.paragrafos?.length) {
      try {
        const r = await chat([
          { role: 'system', content: CHECK },
          { role: 'user', content: `${fonte}\n\nMATÉRIA:\n${JSON.stringify(j)}` },
        ], { json: true, maxTokens: 3000 });
        const c = parse(r.content);
        if (c?.paragrafos?.length) {
          j = { ...j, ...c, tom: j.tom, audio: j.audio, destaque: c.destaque || j.destaque };
          steps.push(c.problemas?.length ? `Checagem corrigiu: ${c.problemas.slice(0, 5).join('; ')}` : 'Checagem: nenhum dado fora da fonte.');
        }
      } catch {
        steps.push('Checagem da IA indisponível (feita só a conferência automática).');
      }
    }
  } else if (!fonteTexto) steps.push('A fonte não trouxe texto suficiente para escrever.');
  // reserva sem IA: rascunho curto, atribuído à fonte (para o jornalista completar)
  if (!j?.paragrafos?.length) {
    const ps = p.blocks.filter((b) => b.type === 'p').slice(0, 4).map((b) => b.text!);
    j = { titulo: p.title, subtitulo: '', minititulo: (p.city ?? 'NOTÍCIA').toUpperCase(), categoria: p.city ? 'Cidades' : 'Brasil', palavras_chave: [], paragrafos: ps.length ? [`Segundo o ${p.source}, ${ps[0]!.charAt(0).toLowerCase()}${ps[0]!.slice(1)}`, ...ps.slice(1)] : [p.snippet || p.title] };
    steps.push('Rascunho sem IA (revise antes de publicar).');
  }
  const paragrafos = (j.paragrafos ?? []).map((x) => cleanText(String(x))).filter((x) => x.length > 0);
  const all = `${j.titulo}\n${j.subtitulo}\n${paragrafos.join('\n')}`;
  const style = slopIssues(all);
  const unverified = unverifiedFacts(`TITULO\n\n${all}`, sources);
  if (unverified.length) steps.push(`Conferir na fonte: ${unverified.join(', ')}`);
  const categoria = CATEGORIAS.find((c) => c.toLowerCase() === String(j.categoria ?? '').toLowerCase()) ?? (p.city ? 'Cidades' : 'Brasil');
  const { html, imagens } = buildHtml(paragrafos, p.blocks, p.source, p.url);
  if (imagens.length) steps.push(`${imagens.length} imagem(ns) da fonte nos mesmos lugares do texto original.`);
  return {
    titulo: cleanText(String(j.titulo ?? p.title)).slice(0, 120),
    subtitulo: cleanText(String(j.subtitulo ?? '')),
    minititulo: cleanText(String(j.minititulo ?? '')).toUpperCase().slice(0, 30),
    categoria,
    palavrasChave: (j.palavras_chave ?? []).map(String).slice(0, 8),
    paragrafos,
    imagens,
    html,
    unverified,
    style,
    model,
    steps,
    costUsd,
    tom: j.tom ? String(j.tom) : undefined,
    audio: j.audio ? String(j.audio) : undefined,
    destaque: pickHighlight(cleanText(String(j.titulo ?? p.title)), String(j.destaque ?? ''), (j.palavras_chave ?? []).map(String)),
  };
}

const foldTxt = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/**
 * Trecho a destacar: o que a IA escolheu, se estiver mesmo no título (até 5
 * palavras); senão, a primeira palavra-chave que aparece no título.
 */
export function pickHighlight(titulo: string, destaque: string, palavras: string[]): string | undefined {
  const d = destaque.replace(/[*"“”]/g, '').trim();
  if (d && d.split(/\s+/).length <= 5 && foldTxt(titulo).includes(foldTxt(d))) return d;
  return palavras.find((k) => k.trim().length >= 3 && foldTxt(titulo).includes(foldTxt(k.trim())))?.trim();
}
