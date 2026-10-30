/**
 * Qual matéria do blog vai para o Instagram: NÃO espera visualização no site
 * (assim nada saía durante o dia). A IA dá uma nota de 0 a 10 de potencial de
 * engajamento no Instagram — crime, polêmica, bombástico, tragédia, escândalo,
 * briga, vazamento sobem; serviço, agenda e nota institucional descem. Só vai
 * o que é forte de verdade (nota ≥ 7): se não tiver nada forte, não força.
 *
 * Entre as fortes, a preferência é da nossa região: pelo menos uma por dia de
 * Guarabira, João Pessoa e Campina Grande, se houver alguma forte de lá.
 * Depois, o engajamento real do Instagram no assunto (hashtag) desempata.
 *
 * A nota de cada matéria fica guardada: a IA só avalia matéria nova.
 */
import type { Chat } from './writer';
import type { SiteNews } from './websg';

export const NOTA_MINIMA = 7;
/** cidades da casa: preferência no Instagram */
export const CIDADES_DA_CASA = ['Guarabira', 'João Pessoa', 'Campina Grande'] as const;

export interface Nota {
  nota: number;
  /** cidade da casa de que a notícia trata (ou null) */
  cidade: string | null;
  /** hashtag do assunto, sem # (para medir o engajamento no Instagram) */
  hashtag: string;
  motivo: string;
}

const KEY = 'pn-ig-notas';
function load(): Record<string, Nota & { at: string }> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, Nota & { at: string }>;
  } catch {
    return {};
  }
}
function save(v: Record<string, Nota & { at: string }>) {
  try {
    // guarda só as últimas 400
    const entries = Object.entries(v)
      .sort((a, b) => (a[1].at < b[1].at ? 1 : -1))
      .slice(0, 400);
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    /* sem armazenamento */
  }
}

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** cidade da casa citada no título (reserva quando a IA não diz) */
export function cidadeDoTitulo(t: string): string | null {
  const f = fold(t);
  return CIDADES_DA_CASA.find((c) => f.includes(fold(c))) ?? (/\bjp\b|capital paraibana/.test(f) ? 'João Pessoa' : /\bcampina\b/.test(f) ? 'Campina Grande' : null);
}

/** Nota de cada matéria (usa as guardadas; só pede à IA as novas, numa chamada só). */
export async function notas(chat: Chat | null, items: SiteNews[]): Promise<Map<number, Nota>> {
  const cache = load();
  const out = new Map<number, Nota>();
  const novas: SiteNews[] = [];
  for (const n of items) {
    const c = cache[String(n.id)];
    if (c) out.set(n.id, c);
    else novas.push(n);
  }
  if (novas.length && chat) {
    const lista = novas.slice(0, 30).map((n) => ({ id: n.id, titulo: n.title, editoria: n.categoria ?? '' }));
    try {
      const r = await chat(
        [
          {
            role: 'system',
            content: `Você é editor de redes sociais de um portal de notícias da Paraíba. Para cada notícia, dê uma nota de 0 a 10 do potencial de ENGAJAMENTO no Instagram (comentários, compartilhamentos, gente marcando amigos).
Nota alta (8-10): crime grave, assassinato, tragédia, polêmica, escândalo, briga, vazamento, flagrante em vídeo, famoso envolvido, caso bizarro, revolta popular.
Nota média (5-7): acidente, prisão comum, denúncia, decisão que afeta o bolso do povo.
Nota baixa (0-4): agenda, serviço, nota institucional, evento, campanha, obra, previsão do tempo, esporte sem polêmica.
RELEASE = nota 0: "babação" de prefeitura, governo, câmara, político ou empresa elogiando a si mesmo sem informação útil (prefeito promove ação de bem-estar, gestão é referência, homenagem, prefeito visita obra). Release nunca vai, mesmo sendo da nossa cidade. Serviço com informação de verdade (horário, calendário, o que abre e fecha, inscrição, vacinação, trânsito) NÃO é release: é nota baixa normal.
Diga também se a notícia é de ${CIDADES_DA_CASA.join(', ')} (campo "cidade", com o nome exato, ou null) e a melhor hashtag do assunto (sem #, uma palavra só, ex.: guarabira, joaopessoa, feminicidio).
Responda SÓ JSON: {"notas":[{"id":123,"nota":8,"cidade":"Guarabira","hashtag":"guarabira","motivo":"curto"}]}`,
          },
          { role: 'user', content: JSON.stringify(lista) },
        ],
        { json: true, maxTokens: 1500, label: 'escolher post do Instagram' },
      );
      const j = JSON.parse(/\{[\s\S]*\}/.exec(r.content)?.[0] ?? '{}') as { notas?: { id: number; nota: number; cidade?: string | null; hashtag?: string; motivo?: string }[] };
      const at = new Date().toISOString();
      for (const x of j.notas ?? []) {
        const n = novas.find((y) => y.id === Number(x.id));
        if (!n) continue;
        const cidade = CIDADES_DA_CASA.find((c) => fold(c) === fold(String(x.cidade ?? ''))) ?? cidadeDoTitulo(n.title);
        const nota: Nota = { nota: Math.max(0, Math.min(10, Number(x.nota) || 0)), cidade, hashtag: String(x.hashtag ?? '').replace(/[^\p{L}\p{N}]/gu, '').slice(0, 30), motivo: String(x.motivo ?? '').slice(0, 120) };
        out.set(n.id, nota);
        cache[String(n.id)] = { ...nota, at };
      }
      save(cache);
    } catch {
      /* sem IA agora: tenta no próximo horário */
    }
  }
  return out;
}

export interface Escolha {
  item: SiteNews;
  nota: Nota;
  porque: string;
}

/**
 * Ordena as candidatas (as fortes primeiro). Se hoje ainda não saiu nada de uma
 * cidade da casa e tem matéria forte dela, ela vai na frente.
 */
export function ordenar(cands: SiteNews[], ns: Map<number, Nota>, cidadesHoje: Set<string>): Escolha[] {
  const fortes = cands
    .map((item) => ({ item, nota: ns.get(item.id) }))
    .filter((x): x is { item: SiteNews; nota: Nota } => !!x.nota && x.nota.nota >= NOTA_MINIMA);
  const peso = (x: { nota: Nota }) => x.nota.nota + (x.nota.cidade ? 1 : 0) + (x.nota.cidade && !cidadesHoje.has(x.nota.cidade) ? 3 : 0);
  return fortes
    .sort((a, b) => peso(b) - peso(a))
    .map((x) => ({
      ...x,
      porque: `nota ${x.nota.nota}/10${x.nota.cidade ? ` · ${x.nota.cidade}${!cidadesHoje.has(x.nota.cidade) ? ' (ainda não saiu hoje)' : ''}` : ''}${x.nota.motivo ? ` · ${x.nota.motivo}` : ''}`,
    }));
}
