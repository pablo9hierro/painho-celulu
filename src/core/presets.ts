/**
 * Catálogo de manchetes. Cada preset tem estrutura própria (não só cor) e
 * uma animação de broadcast encenada, desenhada em src/render/headlines.ts.
 */
import type { Animation, TextFields, TextStyle } from './model';
import { PN } from './brand';

export type PresetCategory = 'manchete' | 'tarja' | 'selo' | 'texto' | 'encerramento';

export interface HeadlinePreset {
  id: string;
  name: string;
  category: PresetCategory;
  description: string;
  /** tamanho padrão em frações do quadro */
  size: { w: number; h: number };
  /** posição padrão do centro, em frações do quadro */
  pos: { x: number; y: number };
  fields: TextFields;
  /** campos que o preset realmente usa (para o editor rápido) */
  uses: (keyof TextFields)[];
  style: TextStyle;
  animIn: Animation;
  animOut: Animation;
  /** duração padrão em segundos; null = até o fim do vídeo */
  defaultDuration: number | null;
  /** opacidade inicial (marca d'água semitransparente); padrão 1 */
  opacity?: number;
  /** ocupa o quadro inteiro (post animado) */
  fullFrame?: boolean;
  /** fora da lista (só continua valendo em projetos que já usam) */
  hidden?: boolean;
}

const base: TextStyle = {
  primary: PN.navy,
  accent: PN.bright,
  text: PN.white,
  highlight: PN.yellow,
  fontScale: 1,
  align: 'center',
  uppercase: true,
};

const presetIn: Animation = { type: 'preset', duration: 0.9 };
const presetOut: Animation = { type: 'preset', duration: 0.5 };

const RAW_PRESETS: HeadlinePreset[] = [
  {
    id: 'pn-faixa',
    name: 'Faixa PN',
    category: 'manchete',
    description: 'Faixa inferior em degradê navy com fio azul, manchete centralizada e logo PN.',
    size: { w: 1, h: 0.27 },
    // termina em ~92% da altura, deixando o @perfil das molduras visível embaixo
    pos: { x: 0.5, y: 0.79 },
    fields: { kicker: '', title: 'Homem deixa celular cair no mar e câmera registra cenas inesperadas', subtitle: '' },
    uses: ['title'],
    style: { ...base },
    animIn: presetIn,
    animOut: presetOut,
    defaultDuration: null,
  },
  {
    id: 'pn-urgente',
    name: 'Urgente',
    category: 'manchete',
    description: 'Selo azul-claro, caixa azul e destaque em azul-claro para trechos entre *asteriscos*.',
    size: { w: 0.88, h: 0.15 },
    pos: { x: 0.5, y: 0.62 },
    fields: {
      kicker: 'Urgente',
      title: 'Advogado diz que motorista se apresentou à polícia e *negou cavalo de pau*',
      subtitle: '',
    },
    uses: ['kicker', 'title'],
    style: { ...base, primary: PN.deep, highlight: PN.sky, align: 'left' },
    animIn: presetIn,
    animOut: presetOut,
    defaultDuration: null,
  },
  {
    id: 'pn-tarja',
    name: 'Tarja lateral',
    category: 'manchete',
    description: 'Caixa navy alinhada à esquerda com fio vertical, estilo telejornal regional.',
    size: { w: 0.84, h: 0.12 },
    pos: { x: 0.52, y: 0.58 },
    fields: { kicker: '', title: 'Ataque a tiros deixa moradores em pânico na cidade de Santa Rita', subtitle: '' },
    uses: ['title'],
    style: { ...base, primary: PN.deep, align: 'left' },
    animIn: presetIn,
    animOut: presetOut,
    defaultDuration: null,
  },
  {
    id: 'pn-largo',
    name: 'Faixa larga',
    category: 'manchete',
    description: 'Faixa de ponta a ponta translúcida, manchete grande alinhada à esquerda.',
    size: { w: 1, h: 0.17 },
    pos: { x: 0.5, y: 0.5 },
    fields: { kicker: '', title: 'Vídeo viralizou: prefeitura anuncia mudanças no trânsito do centro', subtitle: '' },
    uses: ['title'],
    style: { ...base, primary: PN.deep, align: 'left' },
    animIn: presetIn,
    animOut: presetOut,
    defaultDuration: null,
  },
  {
    id: 'pn-serif',
    name: 'Editorial serifado',
    category: 'manchete',
    description: 'Serifa pesada centralizada sobre placa profunda, com barra segmentada.',
    size: { w: 1, h: 0.2 },
    pos: { x: 0.5, y: 0.7 },
    fields: { kicker: '', title: 'Operação prende suspeitos de fraude em licitações no interior do estado', subtitle: '' },
    uses: ['title'],
    style: { ...base, primary: PN.deep, accent: PN.sky },
    animIn: presetIn,
    animOut: presetOut,
    defaultDuration: null,
  },
  {
    id: 'pn-marcador',
    name: 'Marcador por linha',
    category: 'manchete',
    description: 'Cada linha ganha seu próprio bloco, entrando em cascata.',
    size: { w: 0.86, h: 0.16 },
    pos: { x: 0.5, y: 0.3 },
    fields: { kicker: '', title: 'Chuva forte alaga ruas e deixa bairros sem energia', subtitle: '' },
    uses: ['title'],
    style: { ...base, primary: PN.blue },
    animIn: presetIn,
    animOut: presetOut,
    defaultDuration: null,
  },
  {
    id: 'pn-chapeu',
    name: 'Lower third com chapéu',
    category: 'tarja',
    description: 'Chapéu em aba, título na placa e linha de apoio — clássico de TV.',
    size: { w: 0.8, h: 0.11 },
    pos: { x: 0.46, y: 0.8 },
    fields: { kicker: 'Segurança', title: 'Polícia investiga ataque em Santa Rita', subtitle: 'Imagens de câmera ajudam na identificação' },
    uses: ['kicker', 'title', 'subtitle'],
    style: { ...base, primary: PN.white, text: PN.navy, accent: PN.blue, align: 'left', uppercase: false },
    animIn: presetIn,
    animOut: presetOut,
    defaultDuration: 6,
  },
  {
    id: 'pn-nome',
    name: 'Identificação (GC)',
    category: 'tarja',
    description: 'Nome e função do entrevistado.',
    size: { w: 0.62, h: 0.075 },
    pos: { x: 0.36, y: 0.76 },
    fields: { kicker: '', title: 'Maria da Silva', subtitle: 'Moradora do bairro' },
    uses: ['title', 'subtitle'],
    style: { ...base, primary: PN.deep, accent: PN.sky, align: 'left', uppercase: false },
    animIn: presetIn,
    animOut: presetOut,
    defaultDuration: 5,
  },
  {
    id: 'pn-aovivo',
    name: 'Selo destaque',
    category: 'selo',
    description: 'Selo editável (Exclusivo, Urgente...) com ponto pulsante e texto ao lado.',
    size: { w: 0.62, h: 0.04 },
    pos: { x: 0.36, y: 0.1 },
    fields: { kicker: 'Exclusivo', title: 'João Pessoa', subtitle: '' },
    uses: ['kicker', 'title'],
    style: { ...base, primary: PN.red, accent: PN.navy, align: 'left' },
    animIn: { type: 'preset', duration: 0.6 },
    animOut: presetOut,
    defaultDuration: null,
  },
  {
    id: 'pn-letreiro',
    name: 'Letreiro',
    category: 'tarja',
    description: 'Faixa de rodapé com texto correndo.',
    size: { w: 1, h: 0.045 },
    pos: { x: 0.5, y: 0.955 },
    fields: { kicker: 'Últimas', title: 'Acompanhe as principais notícias da Paraíba e do Brasil em primeirasnoticias.com.br', subtitle: '' },
    uses: ['kicker', 'title'],
    style: { ...base, primary: PN.navy, accent: PN.bright, align: 'left' },
    animIn: { type: 'preset', duration: 0.6 },
    animOut: presetOut,
    defaultDuration: null,
  },
  {
    id: 'pn-citacao',
    name: 'Citação',
    category: 'texto',
    description: 'Aspas grandes, fala em serifa e atribuição.',
    size: { w: 0.84, h: 0.2 },
    pos: { x: 0.5, y: 0.45 },
    fields: { kicker: '', title: 'Nós vamos apurar tudo e os responsáveis serão punidos', subtitle: 'Secretário de Segurança' },
    uses: ['title', 'subtitle'],
    style: { ...base, primary: PN.navy, accent: PN.sky, align: 'left', uppercase: false },
    animIn: presetIn,
    animOut: presetOut,
    defaultDuration: 6,
  },
  {
    id: 'pn-numero',
    name: 'Número em destaque',
    category: 'texto',
    description: 'Dado numérico grande com legenda.',
    size: { w: 0.7, h: 0.16 },
    pos: { x: 0.5, y: 0.4 },
    fields: { kicker: '', title: '1.240', subtitle: 'famílias desalojadas pela chuva' },
    uses: ['title', 'subtitle'],
    style: { ...base, primary: PN.navy, accent: PN.yellow, align: 'center', uppercase: false },
    animIn: presetIn,
    animOut: presetOut,
    defaultDuration: 5,
  },
  {
    id: 'pn-perfil',
    name: '@perfil',
    category: 'selo',
    description: 'Logo PN, símbolo do Instagram e @primeirasnoticias_.',
    size: { w: 0.72, h: 0.042 },
    pos: { x: 0.5, y: 0.93 },
    fields: { kicker: '', title: PN.handle, subtitle: '' },
    // o perfil oficial é fixo
    uses: [],
    style: { ...base, uppercase: false },
    animIn: { type: 'fade', duration: 0.4 },
    animOut: { type: 'fade', duration: 0.4 },
    defaultDuration: null,
  },
  {
    id: 'pn-marca-dagua',
    name: "Marca d'água @",
    category: 'selo',
    description: "Só o @primeirasnoticias_ em branco semitransparente, para ficar sobre o vídeo sem atrapalhar. Ajuste a opacidade aqui.",
    size: { w: 0.62, h: 0.045 },
    pos: { x: 0.5, y: 0.5 },
    fields: { kicker: '', title: PN.handle, subtitle: '' },
    uses: [],
    style: { ...base, uppercase: false },
    animIn: { type: 'none', duration: 0.4 },
    animOut: { type: 'none', duration: 0.4 },
    defaultDuration: null,
    opacity: 0.35,
  },
  {
    id: 'pn-marca-centro',
    name: "Marca d'água central",
    category: 'selo',
    description: 'Símbolo da marca suave e o @primeirasnoticias_ no meio do vídeo: dá para ver o vídeo e a marca. Ajuste a opacidade aqui.',
    size: { w: 0.6, h: 0.3 },
    pos: { x: 0.5, y: 0.5 },
    fields: { kicker: '', title: PN.handle, subtitle: '' },
    uses: [],
    style: { ...base, uppercase: true },
    animIn: { type: 'none', duration: 0.4 },
    animOut: { type: 'none', duration: 0.4 },
    defaultDuration: null,
    opacity: 0.3,
  },
  {
    id: 'pn-edicao',
    name: 'Edição (post em vídeo)',
    category: 'manchete',
    description: 'Placa do post em vídeo, abaixo da foto: abre do centro, logo impregnada andando atrás das letras, chapéu em aba azul, manchete palavra por palavra com UMA palavra-chave em destaque, linha fina e site. O fio do topo corre como barra de tempo.',
    size: { w: 1, h: 0.3 },
    pos: { x: 0.5, y: 0.775 },
    fields: { kicker: 'Polícia', title: 'Mulher é detida ao tentar entrar com droga em *presídio* de João Pessoa', subtitle: 'Material estava escondido na roupa e foi achado na revista' },
    uses: ['kicker', 'title', 'subtitle'],
    style: { ...base, primary: PN.navy, accent: PN.sky, align: 'left', uppercase: false },
    animIn: { type: 'preset', duration: 0.9 },
    animOut: { type: 'preset', duration: 0.6 },
    defaultDuration: 8,
  },
  {
    id: 'pn-encerramento',
    name: 'Encerramento @perfil',
    category: 'encerramento',
    description: 'Tela final estilo TikTok: logo com efeito, @primeirasnoticias_ e som de encerramento.',
    size: { w: 1, h: 1 },
    pos: { x: 0.5, y: 0.5 },
    fields: { kicker: 'Siga para mais notícias', title: PN.handle, subtitle: '' },
    uses: ['kicker'],
    style: { ...base, uppercase: false },
    animIn: { type: 'preset', duration: 1 },
    animOut: { type: 'fade', duration: 1 },
    defaultDuration: 3.5,
  },
  {
    id: 'plain',
    name: 'Texto livre',
    category: 'texto',
    description: 'Texto com contorno e sombra, sem placa.',
    size: { w: 0.8, h: 0.08 },
    pos: { x: 0.5, y: 0.5 },
    fields: { kicker: '', title: 'Digite seu texto', subtitle: '' },
    uses: ['title'],
    style: { ...base, primary: PN.black, uppercase: false },
    animIn: { type: 'fade', duration: 0.3 },
    animOut: { type: 'fade', duration: 0.3 },
    defaultDuration: 4,
  },
];

/** Animação padrão da marca: entrada e saída de 1 segundo, sem opção de troca. */
export const ANIM_SECONDS = 1;

export const HEADLINE_PRESETS: HeadlinePreset[] = RAW_PRESETS.map((p) => ({
  ...p,
  animIn: { ...p.animIn, duration: ANIM_SECONDS },
  animOut: { ...p.animOut, duration: ANIM_SECONDS },
}));

export function getPreset(id: string): HeadlinePreset {
  return HEADLINE_PRESETS.find((p) => p.id === id) ?? HEADLINE_PRESETS[HEADLINE_PRESETS.length - 1]!;
}
