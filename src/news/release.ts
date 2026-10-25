/**
 * Release / publicidade disfarçada de notícia: matéria de prefeitura, governo
 * ou órgão falando bem de si (obra inaugurada, campanha, evento, entrega,
 * "gestão do prefeito fulano"), nota institucional, divulgação de empresa. Isso
 * NÃO vai para o blog nem para o Instagram — só notícia de verdade (polícia,
 * política, acontecimento, denúncia, acidente, cidade). A IA olha título e
 * começo do texto, de todas de uma vez (uma chamada só).
 */
import type { Chat } from './writer';

export interface ParaChecar {
  id: string;
  titulo: string;
  texto: string;
}

/** sinais claros sem IA (reserva) */
const SINAIS = /\b(prefeitura (de|municipal)|secretaria (municipal|de estado)|governo do estado|gest[aã]o (do|da) prefeit|inaugura|entrega (de|da|do)|campanha|programa\b|realiza[cç][aã]o de|promove|parceria|agenda cultural|festival|feira|capacita[cç][aã]o|curso gratuito|inscri[cç][oõ]es abertas)/i;

export function pareceRelease(titulo: string, texto = ''): boolean {
  const t = `${titulo} ${texto.slice(0, 400)}`;
  // crime/polícia/denúncia nunca é release, mesmo citando prefeitura
  if (/\b(pres[oa]|pris[aã]o|pol[ií]cia|crime|morto|morta|assassin|tiro|den[uú]ncia|investiga|acidente|operação|flagra|agress)/i.test(t)) return false;
  return SINAIS.test(t);
}

/** ids das matérias que são release/institucional (IA; sem IA, pelos sinais claros) */
export async function releases(chat: Chat | null, itens: ParaChecar[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!itens.length) return out;
  if (chat) {
    try {
      const r = await chat(
        [
          {
            role: 'system',
            content: `Você é editor de um portal de notícias. Para cada item, diga se é RELEASE (texto de divulgação de prefeitura, governo, órgão público, político ou empresa falando bem de si: obra, inauguração, entrega, campanha, evento, programa, capacitação, elogio à gestão, nota institucional) ou NOTÍCIA de verdade (crime, polícia, política com conflito ou denúncia, acidente, tragédia, decisão da Justiça, problema na cidade, fato que o povo comenta).
Responda SÓ JSON: {"releases": ["id", ...]} com os ids que são release.`,
          },
          { role: 'user', content: JSON.stringify(itens.slice(0, 40).map((i) => ({ id: i.id, titulo: i.titulo, inicio: i.texto.slice(0, 300) }))) },
        ],
        { json: true, maxTokens: 600, label: 'filtrar release' },
      );
      const j = JSON.parse(/\{[\s\S]*\}/.exec(r.content)?.[0] ?? '{}') as { releases?: unknown[] };
      for (const id of j.releases ?? []) out.add(String(id));
      return out;
    } catch {
      /* sem IA: sinais claros */
    }
  }
  for (const i of itens) if (pareceRelease(i.titulo, i.texto)) out.add(i.id);
  return out;
}
