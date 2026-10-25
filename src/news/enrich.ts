/**
 * Pauta sem texto (o capturador só pegou título e foto — "0 parágrafos"): antes
 * de escrever, lê a matéria de novo por outro método e, se ainda vier vazia,
 * busca a MESMA notícia em outros portais e usa os fatos de lá (com crédito).
 * Sem isso a IA não tinha o que escrever e a matéria falhava.
 */
import type { Pauta } from './pautas';
import { fetchArticle, searchRecent, type Http } from './search';

const MIN_TEXTO = 600;

const textoDe = (p: Pauta) =>
  p.blocks
    .filter((b) => b.type === 'p')
    .map((b) => b.text ?? '')
    .join('\n');

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
/** mesma notícia? (palavras do título em comum) */
function mesmaHistoria(a: string, b: string): boolean {
  const wa = new Set(fold(a).split(/[^a-z0-9]+/).filter((w) => w.length >= 4));
  const wb = fold(b).split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
  const comuns = wb.filter((w) => wa.has(w)).length;
  return comuns >= Math.min(3, Math.max(2, Math.floor(wa.size / 3)));
}

export async function enrichPauta(p: Pauta, http: Http, steps: string[]): Promise<Pauta> {
  if (textoDe(p).length >= MIN_TEXTO) return p;
  let out: Pauta = p;
  // 1) a própria matéria, lida por outro método (escopo <article>, parágrafos longos)
  try {
    const a = await fetchArticle({ url: p.url, title: p.title, source: p.source, date: p.date, snippet: p.snippet }, http);
    const ps = a.text.split('\n').map((s) => s.trim()).filter((s) => s.length >= 40);
    if (ps.join('\n').length > textoDe(out).length) {
      out = { ...out, blocks: [...ps.map((t) => ({ type: 'p' as const, text: t })), ...out.blocks.filter((b) => b.type !== 'p')], paragraphs: ps.length };
      steps.push(`Texto da matéria lido de novo (${ps.length} parágrafos).`);
    }
  } catch {
    /* segue para outros portais */
  }
  if (textoDe(out).length >= MIN_TEXTO) return out;
  // 2) a mesma notícia em outros portais
  try {
    // título sem o sufixo do portal (" - Paraíba - Notícia", " | G1")
    const limpo = p.title.replace(/(\s+[-|–]\s+[^-|–]{2,40})+$/, '').slice(0, 120);
    const r = await searchRecent([limpo], '3d', http, 10, {});
    const outros = r.articles.filter((a) => a.readable && a.url !== p.url && mesmaHistoria(p.title, a.title)).slice(0, 3);
    const extras: { source: string; url: string }[] = [];
    let blocos = [...out.blocks];
    for (const a of outros) {
      const t = await fetchArticle(a, http).catch(() => null);
      const ps = (t?.text ?? '').split('\n').map((s) => s.trim()).filter((s) => s.length >= 40);
      if (ps.join('\n').length < 300) continue;
      blocos = [...blocos, ...ps.map((x) => ({ type: 'p' as const, text: x }))];
      extras.push({ source: t!.source || a.source, url: t!.url || a.url });
      if (blocos.filter((b) => b.type === 'p').map((b) => b.text ?? '').join('\n').length >= 2500) break;
    }
    if (extras.length) {
      out = { ...out, blocks: blocos, paragraphs: blocos.filter((b) => b.type === 'p').length, fontesExtras: extras };
      steps.push(`Fatos completados com ${extras.map((e) => e.source).join(', ')} (a fonte original não deixou ler o texto).`);
    }
  } catch {
    /* sem outros portais */
  }
  return out;
}
