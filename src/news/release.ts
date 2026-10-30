/**
 * Release / "babação": matéria de prefeitura, governo, câmara ou político
 * falando bem de si sem fato nenhum para o leitor ("prefeito promove ação de
 * bem-estar", "gestão fulano é referência", "câmara homenageia"). Isso NÃO vai
 * para o blog nem para o Instagram.
 * Informação de serviço é notícia, mesmo vinda da prefeitura: horário de
 * funcionamento, calendário, o que abre/fecha, inscrição, vacinação, mudança no
 * trânsito, inauguração com data e local. A IA olha título e começo do texto,
 * de todas de uma vez (uma chamada só).
 */
import type { Chat } from './writer';

export interface ParaChecar {
  id: string;
  titulo: string;
  texto: string;
}

/** sinais claros de babação sem IA (reserva) */
const SINAIS =
  /(gest[aã]o (do|da) prefeit|prefeit[oa] [\p{L} ]{0,30}(visita|participa|prestigia|recebe|acompanha|celebra|comemora|destaca|refor[cç]a|promove)|promove a[cç][aã]o|bem-estar|qualidade de vida|homenage|mo[cç][aã]o de aplauso|voto de aplauso|t[ií]tulo de cidad[aã]o|refer[eê]ncia (em|no|na|para)|compromisso com|investe (em|na|no)|reafirma|celebra parceria|firma parceria|cuidando (de|da|do))/iu;
/** informação útil para o povo (no título): notícia, mesmo vindo da prefeitura */
const SERVICO =
  /(?<!\p{L})(hor[aá]rios?|funcionamento|calend[aá]rio|como fica|veja (o|os|a|as|como|quando|onde)|abre|abrem|fecha|fecham|fechad[oa]s?|interdi\p{L}*|desvio|tr[aâ]nsito|inscri[cç]\p{L}*|vagas?|matr[ií]culas?|vacina\p{L}*|falta (de )?[aá]gua|sem (energia|[aá]gua)|pagamento|sal[aá]rios?|reajuste|tarifa|concurso|edital|prazo|feriado|ponto facultativo|finados)(?!\p{L})/iu;

/** título de serviço (horário, calendário, inscrição...): nunca é release */
export const eServico = (titulo: string) => SERVICO.test(titulo);

export function pareceRelease(titulo: string, texto = ''): boolean {
  const t = `${titulo} ${texto.slice(0, 400)}`;
  // crime/polícia/denúncia nunca é release, mesmo citando prefeitura
  if (/\b(pres[oa]|pris[aã]o|pol[ií]cia|crime|morto|morta|assassin|tiro|den[uú]ncia|investiga|acidente|operação|flagra|agress)/i.test(t)) return false;
  if (eServico(titulo)) return false;
  return SINAIS.test(t);
}

/** ids das matérias que são release/babação (IA; sem IA, pelos sinais claros) */
export async function releases(chat: Chat | null, itens: ParaChecar[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!itens.length) return out;
  if (chat) {
    try {
      const r = await chat(
        [
          {
            role: 'system',
            content: `Você é editor de um portal de notícias. Para cada item, diga se é RELEASE ("babação") ou NOTÍCIA.
RELEASE é só texto de prefeitura, governo, câmara, político ou empresa elogiando a si mesmo SEM informação útil para o leitor: "prefeito promove ação para melhorar o bem-estar", "gestão fulano é referência", "prefeitura reforça compromisso com...", "câmara homenageia", prefeito visitando/participando de evento, balanço de obras para se exibir.
NOTÍCIA é todo o resto, INCLUSIVE quando vem da prefeitura ou do governo mas informa algo que o povo precisa saber: horário de funcionamento, calendário, o que abre e fecha no feriado, cemitérios no Finados, inscrições, vagas, concurso, vacinação, mudança no trânsito, falta d'água, pagamento de salário, inauguração com data e local, evento com programação. E também crime, polícia, política, denúncia, acidente, Justiça, problema na cidade.
Na dúvida, é NOTÍCIA.
Responda SÓ JSON: {"releases": ["id", ...]} com os ids que são release.`,
          },
          { role: 'user', content: JSON.stringify(itens.slice(0, 40).map((i) => ({ id: i.id, titulo: i.titulo, inicio: i.texto.slice(0, 300) }))) },
        ],
        { json: true, maxTokens: 600, label: 'filtrar release' },
      );
      const j = JSON.parse(/\{[\s\S]*\}/.exec(r.content)?.[0] ?? '{}') as { releases?: unknown[] };
      // a IA às vezes erra para o lado da prefeitura: serviço no título nunca sai
      const servico = new Set(itens.filter((i) => eServico(i.titulo)).map((i) => i.id));
      for (const id of j.releases ?? []) if (!servico.has(String(id))) out.add(String(id));
      return out;
    } catch {
      /* sem IA: sinais claros */
    }
  }
  for (const i of itens) if (pareceRelease(i.titulo, i.texto)) out.add(i.id);
  return out;
}
