/**
 * Tons das matérias (opcional): o jornalista cria "emblemas" (ex.: Policial,
 * Economia) e coloca neles áudios com nome (ex.: "tensão grave", "suspense
 * leve"). Ao montar o post, a IA identifica o tom da matéria e escolhe o áudio
 * cujo nome combina melhor. Sem tons cadastrados, o post sai sem trilha.
 *
 * Os arquivos ficam na biblioteca de mídia do app (no aparelho ou no PC); aqui
 * guardamos só a lista (nomes e ids), no próprio aparelho.
 */
export interface ToneTrack {
  /** id na biblioteca de mídia */
  mediaId: string;
  /** nome dado pelo jornalista (a IA usa para escolher) */
  name: string;
}

export interface Tone {
  id: string;
  name: string;
  /** dica opcional (quando usar este tom) */
  hint: string;
  tracks: ToneTrack[];
}

const KEY = 'pn-tones-v1';

export function loadTones(): Tone[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]') as Tone[];
    return Array.isArray(v) ? v.filter((t) => t && typeof t.name === 'string').map((t) => ({ id: String(t.id), name: t.name, hint: t.hint ?? '', tracks: Array.isArray(t.tracks) ? t.tracks : [] })) : [];
  } catch {
    return [];
  }
}

export function saveTones(t: Tone[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(t));
  } catch {
    /* sem armazenamento: a lista vale só nesta sessão */
  }
}

/** resumo que vai para a IA (só nomes; nada de arquivo) */
export function tonesForAi(t: Tone[]): { tom: string; dica: string; audios: string[] }[] {
  return t.filter((x) => x.name.trim()).map((x) => ({ tom: x.name.trim(), dica: x.hint.trim(), audios: x.tracks.map((k) => k.name.trim()).filter(Boolean) }));
}

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const words = (s: string) => new Set(fold(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 4));

/** Palavras típicas de cada tom comum (reserva sem IA). */
const HINTS: Record<string, string> = {
  policial: 'policia preso presa prisao crime homicidio assassinado morto morta tiro tiros assalto roubo furto trafico droga drogas delegacia operacao suspeito vitima facada baleado viatura',
  politica: 'prefeito prefeita governador deputado vereador senador eleicao eleicoes camara assembleia partido candidato governo ministro presidente',
  economia: 'economia preco precos inflacao salario emprego desemprego mercado dolar juros imposto comercio vendas empresa investimento',
  esporte: 'esporte futebol jogo partida time campeonato gol treinador atleta botafogo campinense treze',
  saude: 'saude hospital medico vacina doenca dengue paciente atendimento',
  entretenimento: 'show festa cantor cantora artista famoso famosa novela filme musica celebridade',
  tragedia: 'acidente morte morreu tragedia incendio desabamento afogado',
};

/**
 * Reserva sem IA: escolhe o tom pelo nome/dica e pelas palavras da matéria,
 * e o áudio pelo nome que mais se parece com o texto. Sem nada parecido, o
 * primeiro tom que tem áudio.
 */
export function guessTone(tones: Tone[], text: string, categoria = ''): { tone: Tone; track: ToneTrack } | null {
  const usable = tones.filter((t) => t.tracks.length);
  if (!usable.length) return null;
  const w = words(`${text} ${categoria}`);
  const score = (t: Tone) => {
    const own = words(`${t.name} ${t.hint}`);
    const typical = Object.entries(HINTS).find(([k]) => fold(t.name).includes(k.slice(0, 5)))?.[1] ?? '';
    let s = 0;
    for (const x of own) if (w.has(x)) s += 3;
    for (const x of typical.split(' ')) if (w.has(x)) s += 1;
    if (categoria && fold(t.name).slice(0, 5) === fold(categoria).slice(0, 5)) s += 4;
    return s;
  };
  const tone = [...usable].sort((a, b) => score(b) - score(a))[0]!;
  const track = [...tone.tracks].sort((a, b) => [...words(b.name)].filter((x) => w.has(x)).length - [...words(a.name)].filter((x) => w.has(x)).length)[0]!;
  return { tone, track };
}

/** Acha o tom/áudio que a IA respondeu (pelo nome, sem ligar para acento); se não achar, reserva. */
export function resolveTone(tones: Tone[], tom: string | undefined, audio: string | undefined, text: string, categoria = ''): { tone: Tone; track: ToneTrack; how: 'ia' | 'reserva' } | null {
  const tone = tom ? tones.find((t) => t.tracks.length && fold(t.name.trim()) === fold(tom.trim())) : undefined;
  if (tone) {
    const track = (audio && tone.tracks.find((k) => fold(k.name.trim()) === fold(audio.trim()))) || guessTone([tone], text, categoria)!.track;
    return { tone, track, how: 'ia' };
  }
  const g = guessTone(tones, text, categoria);
  return g ? { ...g, how: 'reserva' } : null;
}
