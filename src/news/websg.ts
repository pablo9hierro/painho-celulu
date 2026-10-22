/**
 * Painel do site Primeiras Notícias (WEBSG) por HTTP puro — sem navegador:
 * entrar, listar/buscar, publicar (com foto), apagar e ler os acessos.
 *
 * Funciona igual no PC (servidor Node) e no app Android (CapacitorHttp): a
 * lógica é a mesma, só o "transporte" muda (cookies da sessão ficam nele).
 *
 * O WEBSG não redireciona quando a sessão expira: ele mostra o formulário de
 * login na própria página pedida. Por isso a sessão é conferida pelo campo de
 * senha no HTML, nunca pela URL (aprendido no Postador antigo).
 */
import { decodeEntities } from './search';

export interface SiteFile {
  name: string;
  filename: string;
  type: string;
  data: Uint8Array;
}
export interface SiteReq {
  method: 'GET' | 'POST';
  url: string;
  form?: [string, string][];
  files?: SiteFile[];
  referer?: string;
  /** pedido AJAX (como o jQuery do painel): multipart + X-Requested-With */
  ajax?: boolean;
}
export interface SiteRes {
  status: number;
  url: string;
  text: string;
}
/** transporte com cookies da sessão (o servidor ou o app guardam) */
export interface SiteHttp {
  send(r: SiteReq): Promise<SiteRes>;
}

export interface WebsgConfig {
  base: string;
  user: string;
  pass: string;
}

export const WEBSG_DEFAULT = 'https://primeirasnoticias.com.br/websg/';
const listUrl = (c: WebsgConfig, pg = 1, extra = '') => `${root(c)}?p=noticias&frm=Listar${pg > 1 ? `&page=${pg}` : ''}${extra}`;
const formUrls = (c: WebsgConfig) => [`${root(c)}?p=noticias&frm=Formulario`, `${root(c)}?p=noticias&frm=Adicionar`];
const root = (c: WebsgConfig) => (c.base || WEBSG_DEFAULT).replace(/[?#].*$/, '').replace(/\/?$/, '/');

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const strip = (h: string) => decodeEntities(h.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const attr = (tag: string, name: string) => {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? decodeEntities(m[2] ?? m[3] ?? m[4] ?? '') : '';
};
const abs = (href: string, base: string) => {
  try {
    return new URL(href, base).href;
  } catch {
    return href;
  }
};

/** a página é o formulário de login? (sessão caiu ou ainda não entrou) */
export const isLoginPage = (html: string) => /<input[^>]+type\s*=\s*["']?password/i.test(html);

// ---------------------------------------------------------------- formulários

export interface FormField {
  name: string;
  kind: 'input' | 'textarea' | 'select';
  type: string;
  value: string;
  checked?: boolean;
  options?: { value: string; text: string; selected: boolean }[];
  /** select com várias escolhas (ex.: grupos de WhatsApp, posições na home) */
  multiple?: boolean;
}
export interface ParsedForm {
  action: string;
  method: string;
  enctype: string;
  fields: FormField[];
  html: string;
}

export function parseForms(html: string, pageUrl: string): ParsedForm[] {
  const forms: ParsedForm[] = [];
  const re = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const tag = m[1]!;
    const body = m[2]!;
    const fields: FormField[] = [];
    // ordem do documento: inputs, textareas e selects
    const fre = /<(input)\b([^>]*)>|<(textarea)\b([^>]*)>([\s\S]*?)<\/textarea>|<(select)\b([^>]*)>([\s\S]*?)<\/select>/gi;
    let f: RegExpExecArray | null;
    while ((f = fre.exec(body))) {
      if (f[1]) {
        const name = attr(f[2]!, 'name');
        if (!name) continue;
        fields.push({ name, kind: 'input', type: (attr(f[2]!, 'type') || 'text').toLowerCase(), value: attr(f[2]!, 'value'), checked: /\bchecked\b/i.test(f[2]!) });
      } else if (f[3]) {
        const name = attr(f[4]!, 'name');
        if (name) fields.push({ name, kind: 'textarea', type: 'textarea', value: decodeEntities(f[5]!) });
      } else if (f[6]) {
        const name = attr(f[7]!, 'name');
        if (!name) continue;
        const options = [...f[8]!.matchAll(/<option\b([^>]*)>([\s\S]*?)(?=<option\b|<\/select>|$)/gi)].map((o) => {
          const text = strip(o[2]!);
          const hasValue = /\bvalue\s*=/i.test(o[1]!);
          return { value: hasValue ? attr(o[1]!, 'value') : text, text, selected: /\bselected\b/i.test(o[1]!) };
        });
        const multiple = /\bmultiple\b/i.test(f[7]!);
        // único: o marcado ou o primeiro (como o navegador); múltiplo: só os marcados
        const sel = options.find((o) => o.selected) ?? (multiple ? undefined : options[0]);
        fields.push({ name, kind: 'select', type: 'select', value: sel?.value ?? '', options, multiple });
      }
    }
    forms.push({ action: abs(attr(tag, 'action') || pageUrl, pageUrl), method: (attr(tag, 'method') || 'get').toLowerCase(), enctype: attr(tag, 'enctype').toLowerCase(), fields, html: body });
  }
  return forms;
}

/** valores que o navegador enviaria (sem botões e sem caixas desmarcadas) */
function defaults(form: ParsedForm): [string, string][] {
  const out: [string, string][] = [];
  for (const f of form.fields) {
    if (f.kind === 'input' && ['submit', 'button', 'image', 'reset', 'file'].includes(f.type)) continue;
    if (f.kind === 'input' && ['checkbox', 'radio'].includes(f.type) && !f.checked) continue;
    if (f.kind === 'select' && f.multiple) {
      for (const o of f.options ?? []) if (o.selected) out.push([f.name, o.value]);
      continue;
    }
    out.push([f.name, f.value]);
  }
  return out;
}

const setField = (vals: [string, string][], name: string, value: string) => {
  const i = vals.findIndex(([n]) => n === name);
  if (i >= 0) vals[i] = [name, value];
  else vals.push([name, value]);
};

/** campo cujo nome bate com alguma das pistas (na ordem das pistas) */
function findField(form: ParsedForm, hints: RegExp[], kinds?: FormField['kind'][]): FormField | undefined {
  for (const h of hints) {
    const f = form.fields.find((x) => h.test(x.name) && (!kinds || kinds.includes(x.kind)) && !['hidden', 'submit', 'button', 'file'].includes(x.type));
    if (f) return f;
  }
  return undefined;
}

/** opção do select pelo texto (sem acento/maiúscula); aceita começo igual */
function pickOption(f: FormField, wanted: string[]): string | undefined {
  for (const w of wanted) {
    const ww = fold(w).trim();
    if (!ww) continue;
    const o = f.options?.find((x) => fold(x.text).trim() === ww) ?? f.options?.find((x) => fold(x.text).includes(ww) || ww.includes(fold(x.text).trim() || '\u0000'));
    if (o) return o.value;
  }
  return undefined;
}

// ---------------------------------------------------------------- sessão

export async function login(http: SiteHttp, c: WebsgConfig): Promise<void> {
  if (!c.user || !c.pass) throw new Error('Configure o usuário e a senha do painel do site (WEBSG).');
  const first = await http.send({ method: 'GET', url: listUrl(c) });
  if (!isLoginPage(first.text) && /js_ok=1/.test(first.text) && first.text.length < 4000) throw new Error('O painel pediu a verificação de JavaScript (cookie js_ok) e não aceitou o acesso.');
  if (!isLoginPage(first.text)) return; // sessão ativa
  const form = parseForms(first.text, first.url).find((f) => f.fields.some((x) => x.type === 'password'));
  if (!form) throw new Error('Não achei o formulário de login do painel.');
  const vals = defaults(form);
  const pass = form.fields.find((x) => x.type === 'password')!;
  const user = findField(form, [/^usuario$/i, /user|login|email/i], ['input']) ?? form.fields.find((x) => x.kind === 'input' && ['text', 'email'].includes(x.type));
  if (!user) throw new Error('Não achei o campo de usuário no login do painel.');
  setField(vals, user.name, c.user);
  setField(vals, pass.name, c.pass);
  const r = await http.send({ method: form.method === 'get' ? 'GET' : 'POST', url: form.action, form: vals, referer: first.url });
  // o painel às vezes demora a processar: confere abrindo a lista
  const check = isLoginPage(r.text) ? r : await http.send({ method: 'GET', url: listUrl(c) });
  if (isLoginPage(check.text)) throw new Error('Login no painel recusado: confira usuário e senha do WEBSG.');
}

/** GET autenticado: se a sessão caiu no meio, entra de novo e repete */
async function getAuthed(http: SiteHttp, c: WebsgConfig, url: string): Promise<SiteRes> {
  let r = await http.send({ method: 'GET', url });
  if (isLoginPage(r.text)) {
    await login(http, c);
    r = await http.send({ method: 'GET', url });
    if (isLoginPage(r.text)) throw new Error('A sessão do painel caiu e não voltou.');
  }
  return r;
}

// ---------------------------------------------------------------- lista

export interface SiteNews {
  id: number;
  title: string;
  url: string;
  /** acessos/visualizações, se o painel mostrar */
  views?: number;
  date?: string;
  status?: string;
  /** editoria (coluna CATEGORIA do painel) */
  categoria?: string;
  editUrl?: string;
  deleteUrl?: string;
}

/** "Publicado: 21/10/2026 às 07h21min" → ISO (horário de Brasília) */
export function publishedAt(text: string): string | undefined {
  const m = /Publicado:\s*(\d{2})\/(\d{2})\/(\d{4})(?:\s*às\s*(\d{1,2})h(\d{2}))?/i.exec(text);
  if (!m) return undefined;
  return `${m[3]}-${m[2]}-${m[1]}T${(m[4] ?? '00').padStart(2, '0')}:${m[5] ?? '00'}:00-03:00`;
}

export function parseList(html: string, pageUrl: string): SiteNews[] {
  // cabeçalho: descobre as colunas de acessos, data e situação pelo nome
  const head = /<thead[\s\S]*?<\/thead>/i.exec(html)?.[0] ?? '';
  const ths = [...head.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map((t) => fold(strip(t[1]!)));
  const col = (re: RegExp) => ths.findIndex((t) => re.test(t));
  const cViews = col(/acess|visualiz|views|leitur|clique/);
  const cDate = col(/data|publica/);
  const cStatus = col(/status|situa|ativ/);
  const cCat = col(/categoria|editoria/);
  const out: SiteNews[] = [];
  for (const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const r = row[1]!;
    const idTxt = /class\s*=\s*["'][^"']*label-primary2[^"']*["'][^>]*>([\s\S]*?)</i.exec(r)?.[1];
    const tds = [...r.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((t) => t[1]!);
    if (tds.length < 2) continue;
    let id = idTxt ? parseInt(strip(idTxt), 10) : NaN;
    if (Number.isNaN(id)) id = parseInt(/[?&]id=(\d+)/.exec(r)?.[1] ?? '', 10);
    if (Number.isNaN(id)) continue;
    const a = /<a\b([^>]*)>([\s\S]*?)<\/a>/i.exec(tds[1]!);
    const title = strip(a?.[2] ?? tds[1]!);
    if (!title) continue;
    // nunca o link da própria matéria (o título pode ter "apagar", "remover"...)
    const titleHref = a ? attr(a[1]!, 'href') : '';
    const links = [...r.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].map((l) => ({ href: attr(l[1]!, 'href'), all: fold(`${l[1]} ${strip(l[2]!)}`) })).filter((l) => l.href !== titleHref);
    const del = links.find((l) => /excluir|deletar|apagar|remover|trash|delete|acao=del|lixeira/.test(l.all) && l.href && !/^javascript/i.test(l.href));
    const edit = links.find((l) => /editar|alterar|frm=formulario|frm=editar|pencil|edit/.test(l.all) && l.href && !/^javascript/i.test(l.href));
    const num = (i: number) => {
      if (i < 0 || !tds[i]) return undefined;
      const v = strip(tds[i]!).replace(/\./g, '').match(/\d+/);
      return v ? Number(v[0]) : undefined;
    };
    out.push({
      id,
      title,
      url: a ? abs(attr(a[1]!, 'href'), pageUrl) : '',
      views: num(cViews),
      date: cDate >= 0 && tds[cDate] ? strip(tds[cDate]!) : publishedAt(strip(tds[1]!)),
      status: cStatus >= 0 && tds[cStatus] ? strip(tds[cStatus]!) : undefined,
      categoria: cCat >= 0 && tds[cCat] ? strip(tds[cCat]!) : undefined,
      editUrl: edit ? abs(edit.href, pageUrl) : undefined,
      deleteUrl: del ? abs(del.href, pageUrl) : undefined,
    });
  }
  return out;
}

export async function listNews(http: SiteHttp, c: WebsgConfig, pages = 1): Promise<SiteNews[]> {
  await login(http, c);
  const all: SiteNews[] = [];
  for (let pg = 1; pg <= pages; pg++) {
    const r = await getAuthed(http, c, listUrl(c, pg));
    const items = parseList(r.text, r.url).filter((x) => !all.some((y) => y.id === x.id));
    if (!items.length) break;
    all.push(...items);
  }
  return all;
}

/** Busca pela própria busca do painel (título ou número: cobre TODAS as matérias, não só as primeiras páginas). */
export async function searchNews(http: SiteHttp, c: WebsgConfig, q: string, pages = 3): Promise<SiteNews[]> {
  const term = q.trim();
  if (!term) return listNews(http, c, pages);
  await login(http, c);
  const param = /^\d+$/.test(term) ? '&buscaID=' + term : '&buscaNome=' + encodeURIComponent(term);
  const all: SiteNews[] = [];
  for (let pg = 1; pg <= pages; pg++) {
    const r = await getAuthed(http, c, listUrl(c, pg, param));
    const items = parseList(r.text, r.url).filter((x) => !all.some((y) => y.id === x.id));
    if (!items.length) break;
    all.push(...items);
  }
  // reserva: painel sem busca (ou que ignore o termo) — filtra aqui também
  const words = fold(term).split(/\s+/).filter(Boolean);
  const hits = all.filter((n) => words.every((w) => fold(n.title).includes(w) || String(n.id) === w));
  return hits.length || !all.length ? hits : all.filter((n) => words.some((w) => fold(n.title).includes(w)));
}

// ---------------------------------------------------------------- publicar

export interface SitePost {
  titulo: string;
  subtitulo: string;
  minititulo: string;
  categoria: string;
  palavrasChave: string[];
  /** texto em HTML (com as imagens nos lugares) */
  html: string;
  /** foto principal (capa) */
  foto?: { data: Uint8Array; type: string; name: string } | null;
  /** true = publicado; false = fica em revisão/rascunho, se o painel tiver essa opção */
  publicar: boolean;
}

/** credenciais da sessão que o painel v5 exige em cada ação (id_user/tk_user) */
export function panelAuth(html: string): { id_user: string; tk_user: string } | null {
  const a = /id_user:\s*'(\d+)'\s*,\s*tk_user:\s*'([^']+)'/.exec(html) ?? /append\('id_user',\s*'(\d+)'\);\s*\w+\.append\('tk_user',\s*'([^']+)'\)/.exec(html);
  return a ? { id_user: a[1]!, tk_user: a[2]! } : null;
}

const toB64 = (d: Uint8Array) => {
  let s = '';
  for (let i = 0; i < d.length; i += 0x8000) s += String.fromCharCode(...d.subarray(i, i + 0x8000));
  return btoa(s);
};

/** campos que NUNCA podem sair ligados numa publicação automática */
const SAFE_OFF: Record<string, string> = { zn_enviar: '0', renovarCache: 'n' };
/** nunca enviar: grupos de WhatsApp e posições de destaque na home */
const NEVER_SEND = /^(zn_para|posicao|posicao_ws)\b/;

export interface AddOptions {
  /** prepara a capa no tamanho do painel (1200x675, 16:9) */
  prepareCover?: (foto: NonNullable<SitePost['foto']>) => Promise<NonNullable<SitePost['foto']>>;
}

async function addNewsV5(http: SiteHttp, c: WebsgConfig, post: SitePost, page: SiteRes, form: ParsedForm, opts: AddOptions, steps: string[]): Promise<{ id: number | null; steps: string[] }> {
  const auth = panelAuth(page.text);
  if (!auth) throw new Error('O painel não mostrou a credencial da sessão (id_user/tk_user).');
  const u = new URL(page.url);
  const getUrl = u.pathname + u.search;
  // capa: o painel usa o recorte "Slim", enviado à parte e ligado à sessão do formulário
  const slimSvc = /class="slim"[^>]*data-service="([^"]+)"/.exec(page.text)?.[1] ?? /data-service="([^"]*slim[^"]*)"/.exec(page.text)?.[1];
  if (post.foto && slimSvc) {
    const foto = opts.prepareCover ? await opts.prepareCover(post.foto).catch(() => post.foto!) : post.foto;
    const dataUrl = `data:${foto.type};base64,${toB64(foto.data)}`;
    const slim = JSON.stringify({
      server: null,
      meta: {},
      input: { name: foto.name, type: foto.type, size: foto.data.length, width: 1200, height: 675 },
      output: { name: foto.name, type: foto.type, width: 1200, height: 675, image: dataUrl },
      actions: { rotation: 0, crop: { x: 0, y: 0, width: 1200, height: 675, type: 'auto' }, size: { width: 1200, height: 675 }, filters: { sharpen: 0 }, minSize: { width: 0, height: 0 } },
    });
    const r = await http.send({ method: 'POST', url: abs(decodeEntities(slimSvc), page.url), form: [['slim[]', slim]], referer: page.url, ajax: true });
    steps.push(r.status < 400 && /success/i.test(r.text) ? 'Capa enviada ao painel (1200x675).' : `Capa: o painel respondeu ${r.status} (${strip(r.text).slice(0, 120)}).`);
  } else if (post.foto) steps.push('O painel não mostrou o campo da capa: notícia sem foto de capa.');

  const vals: [string, string][] = [['id', ''], ['get_url', getUrl], ['id_user', auth.id_user], ['tk_user', auth.tk_user], ['ckTexto', post.html], ['ckResumo', post.subtitulo], ['act', 'insertbd']];
  const radio = (n: string) => form.fields.find((x) => x.name === n && x.checked)?.value ?? '';
  vals.push(['confleituraR', radio('confleitura')], ['boxhtmlR', radio('boxhtml')], ['alinhamento_fotoR', radio('alinhamento_foto')]);
  const set: Record<string, string> = { ...SAFE_OFF, titulo: post.titulo, subtitulo: post.subtitulo, minititulo: post.minititulo.slice(0, 30), tags: post.palavrasChave.join(', ') };
  const src = /Com informações de <a[^>]*>([^<]+)</.exec(post.html)?.[1];
  if (src) {
    set.creditos_fonte = decodeEntities(src);
    set.creditos_fotos = `Reprodução/${decodeEntities(src)}`;
  }
  const cat = form.fields.find((x) => x.name === 'id_cat');
  const catVal = cat ? pickOption(cat, [post.categoria]) : undefined;
  if (catVal) set.id_cat = catVal;
  steps.push(catVal ? `Categoria "${post.categoria}"` : `Categoria "${post.categoria}" não existe no painel: ficou sem.`);
  const st = form.fields.find((x) => x.name === 'status');
  const stVal = st ? pickOption(st, post.publicar ? ['Publicado'] : ['Revisão']) : undefined;
  if (stVal) set.status = stVal;
  steps.push(post.publicar ? 'Situação: publicada' : 'Situação: em revisão');
  // cada campo do formulário vai com o valor que o navegador mandaria (o painel lê todos)
  // espelho do que o jQuery do painel manda: todo elemento com nome, com o valor dele
  // (rádio = o próprio valor; arquivo e listas múltiplas = vazio). Grupos de WhatsApp
  // e posições de destaque vão SEMPRE vazios.
  for (const fl of form.fields) {
    if (fl.type === 'submit' || fl.type === 'button') continue;
    const empty = NEVER_SEND.test(fl.name) || fl.type === 'file' || (fl.kind === 'select' && fl.multiple);
    vals.push([fl.name, empty ? '' : set[fl.name] ?? fl.value]);
  }
  vals.push(['zn_para', '']);
  const r = await http.send({ method: 'POST', url: abs('lib/actions/noticias.post.php', page.url), form: vals, referer: page.url, ajax: true });
  if (isLoginPage(r.text)) throw new Error('A sessão do painel caiu ao enviar a notícia. Tente de novo.');
  if (r.status >= 400) throw new Error(`O painel recusou a notícia (erro ${r.status}).`);
  const idFromResp = Number(/wjPosSalvar\(\s*['"]?(\d+)/.exec(r.text)?.[1] ?? /[?&]id=(\d+)/.exec(r.text)?.[1] ?? NaN);
  const msg = strip(r.text).slice(0, 200);
  steps.push(`Resposta do painel: ${msg || '(vazia)'}`);
  const list = await listNews(http, c, 1);
  const tt = fold(post.titulo).slice(0, 60);
  const found = (Number.isNaN(idFromResp) ? undefined : list.find((n) => n.id === idFromResp)) ?? list.find((n) => fold(n.title).slice(0, 60) === tt);
  steps.push(found ? `Conferido na lista: notícia nº ${found.id}` : 'Enviada, mas não apareceu na 1ª página da lista.');
  return { id: found?.id ?? (Number.isNaN(idFromResp) ? null : idFromResp), steps };
}

export async function addNews(http: SiteHttp, c: WebsgConfig, post: SitePost, opts: AddOptions = {}): Promise<{ id: number | null; steps: string[] }> {
  const steps: string[] = [];
  await login(http, c);
  let form: ParsedForm | undefined;
  let page: SiteRes | undefined;
  for (const u of formUrls(c)) {
    page = await getAuthed(http, c, u);
    form = parseForms(page.text, page.url).find((f) => f.fields.some((x) => /^titulo$/i.test(x.name)));
    if (form) break;
  }
  if (!form || !page) throw new Error('Não achei o formulário de nova notícia no painel.');
  // painel v5 (o atual): salva por AJAX e a capa vai pelo Slim
  if (/formulario_ajax/.test(page.text) && /noticias\.post\.php/.test(page.text)) return addNewsV5(http, c, post, page, form, opts, steps);
  const vals = defaults(form);
  const put = (hints: RegExp[], value: string, label: string, kinds?: FormField['kind'][]) => {
    const f = findField(form!, hints, kinds);
    if (f) {
      setField(vals, f.name, value);
      steps.push(`${label} → campo "${f.name}"`);
    }
    return f;
  };
  put([/^titulo$/i], post.titulo, 'Título');
  put([/^subtitulo$/i, /sub_?titulo|linha_?fina|resumo|chamada|descricao|lide/i], post.subtitulo, 'Subtítulo');
  put([/^minititulo$/i, /mini_?titulo|chapeu|antetitulo|sobretitulo|cartola/i], post.minititulo, 'Chapéu');
  put([/^texto$/i, /conteudo|materia|corpo|noticia/i], post.html, 'Texto', ['textarea']);
  put([/palavras?_?chaves?|tags?$|keywords?/i], post.palavrasChave.join(', '), 'Palavras-chave');
  const cat = findField(form, [/^categoria$/i, /categoria|editoria|secao/i], ['select']);
  if (cat) {
    const v = pickOption(cat, [post.categoria]);
    if (v !== undefined) {
      setField(vals, cat.name, v);
      steps.push(`Categoria "${post.categoria}"`);
    } else steps.push(`Categoria "${post.categoria}" não existe no painel: ficou a padrão.`);
  }
  const st = findField(form, [/^status$/i, /status|situacao|ativo|publicad/i], ['select']);
  if (st) {
    const v = pickOption(st, post.publicar ? ['publicado', 'publicada', 'ativo', 'ativa', 'sim', 'publicar'] : ['revisao', 'em revisao', 'rascunho', 'pendente', 'inativo', 'nao']);
    if (v !== undefined) {
      setField(vals, st.name, v);
      steps.push(post.publicar ? 'Situação: publicada' : 'Situação: em revisão');
    }
  }
  const files: SiteFile[] = [];
  const fileField = form.fields.find((x) => x.type === 'file' && /foto|imagem|image|capa|arquivo/i.test(x.name)) ?? form.fields.find((x) => x.type === 'file');
  if (post.foto && fileField) {
    files.push({ name: fileField.name, filename: post.foto.name, type: post.foto.type, data: post.foto.data });
    steps.push(`Foto de capa → campo "${fileField.name}"`);
  }
  const r = await http.send({ method: 'POST', url: form.action, form: vals, files, referer: page.url });
  if (isLoginPage(r.text)) throw new Error('A sessão do painel caiu ao enviar a notícia. Tente de novo.');
  if (r.status >= 400) throw new Error(`O painel recusou a notícia (erro ${r.status}).`);
  // confere na lista e descobre o número da notícia
  const list = await listNews(http, c, 1);
  const t = fold(post.titulo).slice(0, 60);
  const found = list.find((n) => fold(n.title).slice(0, 60) === t) ?? list.find((n) => fold(n.title).includes(t.slice(0, 40)));
  steps.push(found ? `Conferido na lista: notícia nº ${found.id}` : 'Enviada, mas não apareceu na 1ª página da lista (confira no painel).');
  return { id: found?.id ?? null, steps };
}

// ---------------------------------------------------------------- apagar

export async function deleteNews(http: SiteHttp, c: WebsgConfig, id: number): Promise<void> {
  const list = await searchNews(http, c, String(id), 1);
  const item = list.find((n) => n.id === id);
  if (!item) throw new Error(`A notícia nº ${id} não está nas 3 primeiras páginas da lista.`);
  const lp = await getAuthed(http, c, listUrl(c));
  const auth = panelAuth(lp.text);
  if (auth && /ConfirmarApagarNoticia/.test(lp.text)) {
    const u = new URL(lp.url);
    const r = await http.send({ method: 'POST', url: abs('lib/actions/noticias.post.php', lp.url), form: [['act', 'apagar_noticia_confirmar'], ['id', String(id)], ['get_url', u.pathname + u.search], ['id_user', auth.id_user], ['tk_user', auth.tk_user]], referer: lp.url, ajax: true });
    if (!/success/i.test(r.text)) throw new Error(`O painel não apagou a notícia nº ${id}: ${strip(r.text).slice(0, 120)}`);
  } else if (item.deleteUrl) {
    await getAuthed(http, c, item.deleteUrl);
  } else {
    // sem link: usa o formulário da lista (caixinhas + ação "excluir")
    const r = await getAuthed(http, c, listUrl(c));
    const form = parseForms(r.text, r.url).find((f) => f.fields.some((x) => x.type === 'checkbox' && x.value === String(id)));
    if (!form) throw new Error('Não achei como apagar no painel (sem botão de excluir).');
    const vals = defaults(form).filter(([, v]) => v !== String(id));
    const box = form.fields.find((x) => x.type === 'checkbox' && x.value === String(id))!;
    vals.push([box.name, String(id)]);
    const act = form.fields.find((x) => x.kind === 'select' && x.options?.some((o) => /excluir|apagar|deletar/.test(fold(o.text))));
    if (act) setField(vals, act.name, act.options!.find((o) => /excluir|apagar|deletar/.test(fold(o.text)))!.value);
    await http.send({ method: 'POST', url: form.action, form: vals, referer: r.url });
  }
  const after = await listNews(http, c, 3);
  if (after.some((n) => n.id === id)) throw new Error(`O painel não apagou a notícia nº ${id}.`);
}

// ---------------------------------------------------------------- estatística (GA4 pelo painel)

/** Usuários ativos AGORA no site (últimos 30 min, Google Analytics 4 do painel). null se indisponível. */
export async function siteActiveUsers(http: SiteHttp, c: WebsgConfig): Promise<{ users: number; views: number } | null> {
  await login(http, c);
  const page = await getAuthed(http, c, `${root(c)}?p=googleanalyticsv4`);
  const auth = panelAuth(page.text);
  if (!auth) return null;
  const u = new URL(page.url);
  const r = await http.send({ method: 'POST', url: abs('lib/actions/googleanalyticsv4.post.php', page.url), form: [['modulo', 'googleanalyticsv4'], ['act', 'active_users'], ['get_url', u.pathname + u.search], ['id_user', auth.id_user], ['tk_user', auth.tk_user]], referer: page.url, ajax: true });
  try {
    const j = JSON.parse(r.text) as { code?: string; active_users?: number; page_views?: number };
    return j.code === 'success' && typeof j.active_users === 'number' ? { users: j.active_users, views: j.page_views ?? 0 } : null;
  } catch {
    return null;
  }
}
