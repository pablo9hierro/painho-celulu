/**
 * Textos do post em vídeo: o título do site costuma ser longo demais para a
 * placa. A IA reescreve um TÍTULO CURTO e direto (com as palavras-chave) e um
 * SUBTÍTULO que cabe inteiro em 2 linhas — sem reticências. Na mesma chamada,
 * escolhe o trecho de destaque e a música (tom/áudio).
 */
import type { Chat } from './writer';
import { pickHighlight } from './siteWriter';
import { loadTones, tonesForAi } from './tones';

/** cabe na placa em até 3 linhas com a letra grande */
export const VIDEO_TITLE_MAX = 60;
/** cabe inteiro nas 2 linhas do subtítulo */
export const VIDEO_SUB_MAX = 115;

export interface VideoTexts {
  titulo: string;
  subtitulo: string;
  destaque?: string;
  tom?: string;
  audio?: string;
}

const clean = (s: string) => s.replace(/\s+/g, ' ').replace(/(\.\.\.|…)\s*$/, '').trim();
const WEAK_END = /\s+(?:a|o|as|os|de|da|do|das|dos|e|em|na|no|nas|nos|por|para|com|um|uma|que|ao|à|se|sua|seu)$/i;

/**
 * Corta sem reticências: até o fim de uma frase que caiba; senão, até a última
 * palavra inteira (sem terminar em "de", "e", "com"...).
 */
export function fitNoEllipsis(text: string, max: number): string {
  const t = clean(text);
  if (t.length <= max) return t;
  const cut = t.slice(0, max + 1);
  const sentence = cut.match(/^[\s\S]*[.!?](?=\s|$)/)?.[0];
  if (sentence && sentence.length >= max * 0.5) return sentence.trim();
  let w = cut.slice(0, cut.lastIndexOf(' ')).replace(/[,;:–-]+$/, '').trim();
  while (WEAK_END.test(w)) w = w.replace(WEAK_END, '').trim();
  return w.replace(/[,;:–-]+$/, '').trim();
}

export async function videoTexts(
  chat: Chat | null,
  m: { titulo: string; subtitulo: string; texto: string; palavras: string[]; /** destaque já escolhido (matéria do app) */ destaque?: string },
  opts: { /** pedir tom/música também */ tone?: boolean } = { tone: true },
): Promise<VideoTexts> {
  const fallback = (): VideoTexts => {
    const titulo = fitNoEllipsis(m.titulo, VIDEO_TITLE_MAX);
    return { titulo, subtitulo: fitNoEllipsis(m.subtitulo || m.texto.split('\n')[0] || '', VIDEO_SUB_MAX), destaque: pickHighlight(titulo, m.destaque ?? '', m.palavras) };
  };
  if (!chat) return fallback();
  // já cabe e a música já foi escolhida: não precisa da IA
  if (!opts.tone && clean(m.titulo).length <= VIDEO_TITLE_MAX && clean(m.subtitulo).length <= VIDEO_SUB_MAX && clean(m.subtitulo).length >= 20) return fallback();
  const tones = tonesForAi(loadTones()).filter((t) => t.audios.length);
  try {
    const r = await chat(
      [
        {
          role: 'system',
          content: `Você faz a placa de um post em vídeo (Reels) de notícia. Responda SÓ com JSON:
{"titulo": "título CURTO e direto, no máximo ${VIDEO_TITLE_MAX} caracteres: vá ao ponto com as palavras-chave do fato (quem/o quê/onde). Sem reticências, sem caixa alta, sem 'IMAGEM FORTE'/'VÍDEO' e afins",
 "subtitulo": "UMA frase completa, no máximo ${VIDEO_SUB_MAX} caracteres, que complementa o título com o dado mais importante. Termina com ponto final, nunca com reticências",
 "destaque": "trecho de 2 a 4 palavras copiado EXATAMENTE do título que você escreveu, o coração da notícia",
 "tom": "nome exato de um tom", "audio": "nome exato de um áudio desse tom"}
Não invente nada que não esteja na matéria. Escolha o tom pelo assunto real (Policial só para crime/prisão/operação/violência; se nada combinar, o mais geral) e CAPRICHE no áudio pelo clima. Tons: ${JSON.stringify(tones)}`,
        },
        { role: 'user', content: `TÍTULO DO SITE: ${m.titulo}\nSUBTÍTULO DO SITE: ${m.subtitulo}\nPALAVRAS-CHAVE: ${m.palavras.join(', ')}\n\n${m.texto.slice(0, 3000)}` },
      ],
      { json: true, maxTokens: 400 },
    );
    const j = JSON.parse(/\{[\s\S]*\}/.exec(r.content)?.[0] ?? '{}') as Partial<Record<keyof VideoTexts, string>>;
    const fb = fallback();
    const titulo = j.titulo && clean(j.titulo).length >= 15 ? fitNoEllipsis(j.titulo, VIDEO_TITLE_MAX) : fb.titulo;
    const subtitulo = j.subtitulo && clean(j.subtitulo).length >= 20 ? fitNoEllipsis(j.subtitulo, VIDEO_SUB_MAX) : fb.subtitulo;
    return { titulo, subtitulo, destaque: pickHighlight(titulo, j.destaque ?? '', m.palavras), tom: j.tom, audio: j.audio };
  } catch {
    return fallback();
  }
}
