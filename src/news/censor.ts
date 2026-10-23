/**
 * Palavras que a Meta usa para derrubar alcance ou banir (morte, homicídio,
 * esfaquear...) vão disfarçadas na legenda do Instagram: as vogais viram
 * números (a→4, e→3, i→1, o→0), continua dando para ler ("h0m1c1d10",
 * "m0rt3"). Só na legenda/descrição — a manchete do vídeo fica normal.
 */
const RAIZES = [
  'homic[ií]dio',
  'homicida',
  'assassin(?:ato|ad[ao]s?|ar|ou|ou-|os?|as?)',
  'mort[eoa]s?',
  'morreu',
  'morrer',
  'mat(?:ou|ar|a|am|aram|ando)',
  'esfaque(?:ad[ao]s?|ar|ou|amento)',
  'facadas?',
  'balead[ao]s?',
  'tiros?',
  'execu(?:tad[ao]s?|ção|tou)',
  'estupr(?:o|ad[ao]s?|ador)',
  'su[ií]c[ií]dio',
  'cad[áa]ver(?:es)?',
  'feminic[ií]dio',
  'latroc[ií]nio',
  'chacina',
];
const RE = new RegExp(`(?<![\\p{L}\\p{N}])(${RAIZES.join('|')})(?![\\p{L}\\p{N}])`, 'giu');

const MAP: Record<string, string> = { a: '4', á: '4', à: '4', â: '4', ã: '4', e: '3', é: '3', ê: '3', i: '1', í: '1', o: '0', ó: '0', ô: '0', õ: '0' };

/** troca as vogais da palavra por números (mantém a primeira letra, para seguir legível) */
export function disguiseWord(w: string): string {
  return [...w].map((ch, i) => (i === 0 ? ch : (MAP[ch.toLowerCase()] ?? ch))).join('');
}

/** disfarça as palavras sensíveis do texto (legenda/descrição do Instagram) */
export function censorCaption(text: string): string {
  return text.replace(RE, (m) => disguiseWord(m));
}
