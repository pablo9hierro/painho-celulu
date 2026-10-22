import { describe, expect, it } from 'vitest';
import { addNews, deleteNews, listNews, parseForms, searchNews, type SiteHttp, type SiteReq } from './websg';

/** Painel WEBSG simulado: login por formulário, lista com acessos, nova notícia e excluir por link. */
function fakePanel() {
  let logged = false;
  const news = [
    { id: 101, title: 'Prefeitura de Cabedelo anuncia obra na orla', views: 340 },
    { id: 100, title: 'Operação da polícia prende suspeitos em Bayeux', views: 1200 },
  ];
  const sent: SiteReq[] = [];
  const loginPage = `<form method="post" action="index.php?acao=login"><input type="hidden" name="token" value="abc"><input name="usuario" type="text"><input name="senha" type="password"><button type="submit">Entrar</button></form>`;
  const list = () =>
    `<table><thead><tr><th>ID</th><th>Título</th><th>Acessos</th><th>Ações</th></tr></thead><tbody>${news
      .map((n) => `<tr><td><span class="label label-primary2">${n.id}</span></td><td><a href="/noticia/${n.id}">${n.title}</a></td><td>${n.views.toLocaleString('pt-BR')}</td><td><a href="?p=noticias&frm=Formulario&id=${n.id}">Editar</a> <a href="?p=noticias&acao=excluir&id=${n.id}" onclick="return confirm('x')">Excluir</a></td></tr>`)
      .join('')}</tbody></table>`;
  const form = `<form method="post" enctype="multipart/form-data" action="?p=noticias&acao=salvar"><input type="hidden" name="id" value=""><input id="titulo" name="titulo"><input name="subtitulo"><input name="minititulo"><select name="categoria"><option value="">Selecione</option><option value="3">Policial</option><option value="7">Cidades</option></select><select name="status"><option value="0">Em revisão</option><option value="1">Publicado</option></select><textarea name="texto"></textarea><input type="file" name="foto"><input type="checkbox" name="destaque" value="1"><button type="submit" name="salvar">Salvar</button></form>`;
  const http: SiteHttp = {
    async send(r) {
      sent.push(r);
      const u = new URL(r.url);
      if (u.searchParams.get('acao') === 'login') {
        const f = new Map(r.form);
        logged = f.get('usuario') === 'joao' && f.get('senha') === 'segredo' && f.get('token') === 'abc';
        return { status: 200, url: r.url, text: logged ? '<h1>Painel</h1>' : loginPage };
      }
      if (!logged) return { status: 200, url: r.url, text: loginPage };
      if (u.searchParams.get('acao') === 'salvar') {
        const f = new Map(r.form);
        news.unshift({ id: 102, title: f.get('titulo')!, views: 0 });
        return { status: 302, url: r.url, text: 'ok' };
      }
      if (u.searchParams.get('acao') === 'excluir') {
        const id = Number(u.searchParams.get('id'));
        news.splice(news.findIndex((n) => n.id === id), 1);
        return { status: 200, url: r.url, text: list() };
      }
      if (u.searchParams.get('frm') === 'Formulario') return { status: 200, url: r.url, text: form };
      if (u.searchParams.get('frm') === 'Listar') return { status: 200, url: r.url, text: list() };
      return { status: 404, url: r.url, text: '' };
    },
  };
  return { http, news, sent, expire: () => (logged = false) };
}

const cfg = { base: 'https://site.test/websg/', user: 'joao', pass: 'segredo' };

describe('painel do site (WEBSG) por HTTP', () => {
  it('entra pelo formulário (com campo escondido) e lê a lista com acessos', async () => {
    const p = fakePanel();
    const l = await listNews(p.http, cfg);
    expect(l.map((n) => n.id)).toEqual([101, 100]);
    expect(l[1]!.views).toBe(1200);
    expect(l[0]!.deleteUrl).toContain('acao=excluir&id=101');
  });

  it('senha errada dá erro claro', async () => {
    const p = fakePanel();
    await expect(listNews(p.http, { ...cfg, pass: 'x' })).rejects.toThrow(/recusado/);
  });

  it('busca pelo título (sem acento/maiúscula)', async () => {
    const p = fakePanel();
    expect((await searchNews(p.http, cfg, 'operacao bayeux')).map((n) => n.id)).toEqual([100]);
  });

  it('publica preenchendo os campos certos, categoria, situação e foto; confere o número', async () => {
    const p = fakePanel();
    const r = await addNews(p.http, cfg, { titulo: 'Nova matéria de teste', subtitulo: 'Linha fina', minititulo: 'POLÍCIA', categoria: 'Policial', palavrasChave: ['a'], html: '<p>texto</p>', foto: { data: new Uint8Array([1, 2, 3]), type: 'image/jpeg', name: 'capa.jpg' }, publicar: true });
    expect(r.id).toBe(102);
    const post = p.sent.find((s) => s.method === 'POST' && s.url.includes('acao=salvar'))!;
    const f = new Map(post.form);
    expect(f.get('categoria')).toBe('3');
    expect(f.get('status')).toBe('1');
    expect(f.get('texto')).toBe('<p>texto</p>');
    expect(f.has('destaque')).toBe(false); // caixa desmarcada não vai
    expect(post.files?.[0]?.name).toBe('foto');
  });

  it('sessão que cai no meio: entra de novo sozinho; e apaga pelo link de excluir', async () => {
    const p = fakePanel();
    await listNews(p.http, cfg);
    p.expire();
    await deleteNews(p.http, cfg, 101);
    expect(p.news.map((n) => n.id)).toEqual([100]);
  });

  it('lê selects, textareas e caixas do formulário', () => {
    const f = parseForms('<form action="/x"><select name="c"><option value="1">Um<option value="2" selected>Dois</select><textarea name="t">a &amp; b</textarea></form>', 'https://s.test/p')[0]!;
    expect(f.action).toBe('https://s.test/x');
    expect(f.fields.find((x) => x.name === 'c')!.value).toBe('2');
    expect(f.fields.find((x) => x.name === 't')!.value).toBe('a & b');
  });
});

describe('painel v5 (formato real)', () => {
  it('data de publicação da lista e credencial da sessão', async () => {
    const { publishedAt, panelAuth } = await import('./websg');
    expect(publishedAt('primeirasnoticias.com.br — Publicado: 21/10/2026 às 07h21min - Atualizado')).toBe('2026-10-21T07:21:00-03:00');
    expect(panelAuth("var websgAuthPayload = { get_url: x, id_user: '41', tk_user: 'abc123' };")).toEqual({ id_user: '41', tk_user: 'abc123' });
    expect(panelAuth("frm.append('id_user','41'); frm.append('tk_user','zz9');")).toEqual({ id_user: '41', tk_user: 'zz9' });
  });
  it('lista com várias escolhas (WhatsApp, destaques) sem nada marcado não envia nada', () => {
    const f = parseForms('<form action="/x"><select name="zn_para[]" multiple><option value="g1">Grupo</option></select><select name="s"><option value="a">A</option></select></form>', 'https://s.test/')[0]!;
    expect(f.fields.find((x) => x.name === 'zn_para[]')!.value).toBe('');
    expect(f.fields.find((x) => x.name === 's')!.value).toBe('a');
  });
});
