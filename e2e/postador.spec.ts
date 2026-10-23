import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { ffmpegPaths } from '../server/config';

const DIR = path.resolve('e2e/.fixtures');

/** foto de notícia (paisagem) e uma trilha curta, gerados uma vez */
function fixtures() {
  mkdirSync(DIR, { recursive: true });
  const photo = path.join(DIR, 'foto-noticia.jpg');
  const audio = path.join(DIR, 'tensao-grave.m4a');
  if (!existsSync(photo)) execFileSync(ffmpegPaths().ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1200x800', '-frames:v', '1', photo]);
  if (!existsSync(audio)) execFileSync(ffmpegPaths().ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=10', '-c:a', 'aac', audio]);
  return { photo, audio };
}

type Clip = { type: string; preset?: string; frame?: string; fields?: { title: string; kicker: string }; name?: string; duration: number };
const clips = (page: Page) => page.evaluate(() => (window as unknown as { __editor: { getState(): { project: { clips: Clip[] } | null } } }).__editor.getState().project?.clips ?? []);

const PAUTA = {
  id: 'p1',
  title: 'Polícia prende suspeitos de assalto em Bayeux',
  url: 'https://portal.test/materia-1',
  source: 'Portal Teste',
  date: new Date(Date.now() - 2 * 3600_000).toISOString(),
  snippet: '',
  city: 'Bayeux',
  blocks: [
    { type: 'p', text: 'A Polícia Militar prendeu dois suspeitos de assalto na manhã desta terça-feira em Bayeux.' },
    { type: 'img', src: 'https://portal.test/foto1.jpg', ok: true, caption: 'Viatura no local' },
    { type: 'p', text: 'Segundo a corporação, os dois foram levados para a Central de Polícia.' },
  ],
  paragraphs: 2,
  images: 1,
  imagesOk: 1,
  videos: 0,
  coverage: 2,
  trendHits: 0,
  score: 96,
  reasons: ['publicada há 2 h', 'Bayeux', '1 foto baixável'],
  readable: true,
};

test('Postador: tons com áudio, pautas ranqueadas, matéria com destaque/tom e post em vídeo no padrão', async ({ page }) => {
  const { photo, audio } = fixtures();
  await page.route('**/api/fx', (r) => r.fulfill({ json: { rate: 5, at: '2026-10-21', approx: false } }));
  await page.route('**/api/news/config', (r) => r.fulfill({ json: { ai: true } }));
  await page.route('**/api/pautas?*', (r) => r.fulfill({ json: { pautas: [PAUTA, { ...PAUTA, id: 'p2', title: 'Outra pauta nacional', city: null, score: 60, url: 'https://portal.test/2' }], plan: null } }));
  let sentTones: unknown = null;
  await page.route('**/api/site/write', (r) => {
    sentTones = (r.request().postDataJSON() as { tones: unknown }).tones;
    return r.fulfill({
      json: {
        titulo: 'Polícia prende dois suspeitos de assalto em Bayeux',
        subtitulo: 'Dupla foi levada para a Central de Polícia',
        minititulo: 'POLÍCIA',
        categoria: 'Policial',
        palavrasChave: ['Bayeux', 'assalto'],
        paragrafos: ['A Polícia Militar prendeu dois suspeitos.', 'Eles foram levados para a Central.'],
        imagens: [{ src: 'https://portal.test/foto1.jpg', caption: 'Viatura no local' }],
        html: '<figure><img src="https://portal.test/foto1.jpg" /><figcaption>Viatura</figcaption></figure><p>A Polícia Militar prendeu dois suspeitos.</p>',
        unverified: [],
        style: [],
        model: 'google/gemini-2.5-flash-lite',
        steps: ['Escrita'],
        costUsd: 0.0004,
        tom: 'Crime',
        audio: 'tensao-grave',
        destaque: 'prende dois suspeitos',
      },
    });
  });
  await page.route('**/api/pautas/image?*', (r) => r.fulfill({ body: readFileSync(photo), contentType: 'image/jpeg' }));
  await page.route('https://portal.test/**', (r) => r.fulfill({ body: readFileSync(photo), contentType: 'image/jpeg' }));

  await page.goto('/');
  await page.getByTestId('hub-postador').click();
  await expect(page.getByTestId('postador-dialog')).toBeVisible();

  // TONS: cria "Policial" e coloca um áudio com nome
  await page.getByTestId('postador-tab-tons').click();
  // os 3 tons que vêm no app aparecem na hora
  await expect(page.getByTestId('tone-card')).toHaveCount(3);
  await page.getByTestId('tone-name').fill('Crime');
  await page.getByTestId('tone-add').click();
  await expect(page.getByTestId('tone-card')).toHaveCount(4);
  const card = page.getByTestId('tone-card').last();
  await card.locator('input[type=file]').setInputFiles(audio);
  await expect(card.locator('input[aria-label="Nome do áudio"]')).toHaveValue('tensao-grave', { timeout: 60_000 });

  // PAUTAS: captura, ranking, abre e escreve
  await page.getByTestId('postador-tab-pautas').click();
  await page.getByTestId('postador-capture').click();
  await expect(page.getByTestId('postador-pauta')).toHaveCount(2);
  await expect(page.getByTestId('postador-pauta').first()).toContainText('96 pts');
  await page.getByTestId('postador-pauta').first().locator('.post-card-body').click();
  await expect(page.getByTestId('postador-open')).toContainText('dá para baixar');
  await page.getByTestId('postador-write').click();
  const story = page.getByTestId('postador-story');
  await expect(story).toContainText('destaque: “prende dois suspeitos”');
  await expect(story).toContainText('tom: Crime');
  // a IA recebeu os tons cadastrados (para escolher na mesma chamada)
  expect(JSON.stringify(sentTones)).toContain('tensao-grave');

  // POST EM VÍDEO: abre no editor no padrão (moldura central + foto + placa Edição + trilha do tom)
  await page.getByTestId('postador-video').click();
  await expect(page).toHaveURL(/#\/p\//, { timeout: 60_000 });
  await expect.poll(async () => (await clips(page)).length, { timeout: 30_000 }).toBeGreaterThanOrEqual(4);
  const cs = await clips(page);
  const text = cs.find((c) => c.type === 'text' && c.preset === 'pn-edicao')!;
  expect(text.fields!.title).toBe('Polícia *prende dois suspeitos* de assalto em Bayeux');
  // chapéu = editoria da matéria (mais confiável que o minititulo da IA)
  expect(text.fields!.kicker).toBe('Policial');
  expect(cs.some((c) => c.type === 'frame' && c.frame === 'reels-post')).toBe(true);
  expect(cs.some((c) => c.type === 'image')).toBe(true);
  expect(cs.find((c) => c.type === 'audio')?.name).toContain('tensao-grave');
  // o post tem o tamanho do trecho da música (15 s por padrão)
  expect(text.duration).toBe(15);
});

test('Postador: aba do site guarda o acesso e explica quando falta senha', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('hub-postador').click();
  await page.getByTestId('postador-tab-site').click();
  await page.getByTestId('site-test').click();
  // com senha no PC: "Acesso OK"; sem senha: erro claro
  await expect(page.getByText(/Acesso OK|usuário e a senha|recusado|painel/).first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('postador-tab-auto')).toBeVisible();
  await page.getByTestId('postador-tab-auto').click();
  await expect(page.getByTestId('auto-box')).toContainText('De manhã, às 7h');
  await expect(page.getByText(/No PC é só para ver como fica/)).toBeVisible();
});

test('Automação simples: um botão liga/desliga; lote do blog de manhã e Instagram com a melhor', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('hub-postador').click();
  await page.getByTestId('postador-tab-auto').click();
  const sw = page.getByTestId('auto-switch');
  await expect(sw).toContainText('DESLIGADO');
  await sw.click();
  await expect(sw).toContainText('LIGADO');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('pn-autopost-cfg') ?? '{}').ativo)).toBe(true);
  await expect(page.getByTestId('auto-box')).toContainText('De manhã, às 7h');
  await expect(page.getByText(/mais visualizações/)).toBeVisible();
  await expect(page.locator('b').filter({ hasText: /\d\d:\d\d/ }).first()).toBeVisible();
  await sw.click();
  await expect(sw).toContainText('DESLIGADO');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('pn-autopost-cfg') ?? '{}').ativo)).toBe(false);
});

test('Postar no site direto da lista: escreve e publica no blog', async ({ page }) => {
  const { photo } = fixtures();
  await page.route('**/api/fx', (r) => r.fulfill({ json: { rate: 5, at: '2026-10-22', approx: false } }));
  await page.route('**/api/news/config', (r) => r.fulfill({ json: { ai: true } }));
  await page.route('**/api/pautas?*', (r) => r.fulfill({ json: { pautas: [PAUTA], plan: null } }));
  await page.route('**/api/site/write', (r) =>
    r.fulfill({ json: { titulo: 'Polícia prende dois suspeitos de assalto em Bayeux', subtitulo: 'Dupla foi levada à Central', minititulo: 'POLÍCIA', categoria: 'Policial', palavrasChave: ['Bayeux'], paragrafos: ['A PM prendeu dois suspeitos.'], imagens: [{ src: 'https://portal.test/foto1.jpg', caption: '' }], html: '<p>A PM prendeu dois suspeitos.</p>', unverified: [], style: [], model: 'google/gemini-2.5-flash-lite', steps: [], costUsd: 0.0004, tom: 'Policial', audio: 'policial - suspense sombrio, crime', destaque: 'prende dois suspeitos' } }),
  );
  let publicado: { post: { titulo: string; publicar: boolean }; foto: unknown } | null = null;
  await page.route('**/api/site/publish', (r) => {
    publicado = r.request().postDataJSON();
    return r.fulfill({ json: { id: 46100, steps: ['Conferido na lista: notícia nº 46100'] } });
  });
  await page.route('**/api/pautas/image?*', (r) => r.fulfill({ body: readFileSync(photo), contentType: 'image/jpeg' }));
  await page.goto('/');
  await page.evaluate(() => localStorage.removeItem('pn-fila-instagram'));
  await page.getByTestId('hub-postador').click();
  await page.getByTestId('postador-capture').click();
  await expect(page.getByTestId('postador-pauta')).toHaveCount(1);
  await page.getByTestId('postador-post').click();
  await expect(page.getByTestId('postador-post-status')).toContainText('No site (nº 46100)', { timeout: 30_000 });
  expect(publicado!.post.titulo).toBe('Polícia prende dois suspeitos de assalto em Bayeux');
  expect(publicado!.foto).toBeTruthy();
  // publicou de verdade (não fica em revisão)
  expect((publicado as unknown as { post: { publicar: boolean } }).post.publicar).toBe(true);
});

test('Tons que vêm no app: 17 trilhas com o melhor trecho marcado; desliza para escolher outro (como no Instagram)', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.removeItem('pn-tons-padrao-v1');
    localStorage.removeItem('pn-tons-padrao-v2');
    localStorage.removeItem('pn-tons-padrao-v3');
    localStorage.removeItem('pn-tones-v1');
  });
  await page.getByTestId('hub-postador').click();
  await page.getByTestId('postador-tab-tons').click();
  await expect(page.getByTestId('tone-card')).toHaveCount(3, { timeout: 120_000 });
  await expect(page.locator('input[aria-label="Nome do áudio"]')).toHaveCount(17, { timeout: 120_000 });
  const tones = await page.evaluate(() => JSON.parse(localStorage.getItem('pn-tones-v1') ?? '[]').map((t: { name: string; tracks: unknown[] }) => `${t.name}:${t.tracks.length}`));
  expect(tones.sort()).toEqual(['Geral:4', 'Policial:8', 'Urgente:5']);
  type T = { name: string; tracks: { name: string; mediaId: string; inicio?: number; dur?: number }[] };
  const read = () => page.evaluate(() => JSON.parse(localStorage.getItem('pn-tones-v1') ?? '[]') as T[]);
  let all = (await read()).flatMap((t) => t.tracks);
  // 10 músicas inteiras; cada trilha aponta para o melhor trecho de 15 s
  expect(new Set(all.map((k) => k.mediaId)).size).toBe(10);
  expect(all.every((k) => k.dur === 15 && typeof k.inicio === 'number')).toBe(true);
  const dark = all.find((k) => k.name === 'policial - thriller escuro, perseguição')!;
  expect(dark.inicio).toBe(86.5);
  // abre o trecho da 1ª trilha do card "Policial" e desliza com o dedo
  const card = page.getByTestId('tone-card').filter({ has: page.locator('input[value="Policial"]') });
  await card.getByTestId('tone-trim').first().click();
  const range = card.getByTestId('music-trim-range');
  await expect(range).toContainText(' de ', { timeout: 60_000 });
  const before = await range.textContent();
  const wave = card.getByTestId('music-trim-wave');
  await wave.scrollIntoViewIfNeeded();
  const box = (await wave.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.45, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(range).not.toHaveText(before!);
  await card.getByTestId('music-trim-20').click();
  const first = (await read()).find((t) => t.name === 'Policial')!.tracks[0]!;
  expect(first.dur).toBe(20);
  expect(first.inicio!).toBeGreaterThan(10);
  await expect(card.getByTestId('tone-trim').first()).toContainText('20s');
});

test('Configurações: um lugar só, salva e continua lá; ordem dos botões da tela inicial', async ({ page }) => {
  await page.goto('/');
  const hub = await page.locator('.home-hub .hub-card').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
  expect(hub).toEqual(['hub-download', 'hub-edit', 'hub-postador', 'hub-trends', 'hub-news']);
  await page.getByTestId('open-settings').click();
  await page.getByTestId('cfg-ai').fill('sk-or-teste');
  await page.getByTestId('cfg-site-user').fill('usuario-teste');
  await page.getByTestId('cfg-ig-id').fill('17841476565061887');
  await page.getByTestId('cfg-save').click();
  await page.reload();
  await page.getByTestId('open-settings').click();
  await expect(page.getByTestId('cfg-ai')).toHaveValue('sk-or-teste');
  await expect(page.getByTestId('cfg-site-user')).toHaveValue('usuario-teste');
  await expect(page.getByTestId('cfg-ig-id')).toHaveValue('17841476565061887');
  // collab automática com @portalnewsjampa já vem preenchida
  await expect(page.getByTestId('cfg-ig-collab')).toHaveValue('portalnewsjampa');
  await page.evaluate(() => ['pn-ai-key', 'pn-websg', 'pn-instagram'].forEach((k) => localStorage.removeItem(k)));
});

test('Instagram: lista das matérias publicadas com botão para postar na mão (as já postadas aparecem marcadas)', async ({ page }) => {
  const agora = Date.now();
  await page.route('**/api/site/list', (r) =>
    r.fulfill({
      json: {
        news: [
          { id: 46201, title: 'Prefeitura anuncia mutirão de saúde em João Pessoa', url: 'https://primeirasnoticias.com.br/n/46201', views: 820, status: 'Publicado', date: new Date(agora - 4 * 3600_000).toISOString() },
          { id: 46200, title: 'Polícia prende suspeito de assalto em Bayeux', url: 'https://primeirasnoticias.com.br/n/46200', views: 300, status: 'Publicado', date: new Date(agora - 6 * 3600_000).toISOString() },
          { id: 46199, title: 'Matéria em revisão', url: 'https://primeirasnoticias.com.br/n/46199', views: 0, status: 'Revisão', date: new Date(agora - 1 * 3600_000).toISOString() },
        ],
      },
    }),
  );
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.setItem('pn-websg', JSON.stringify({ base: 'https://primeirasnoticias.com.br', user: 'teste', pass: 'teste' }));
    localStorage.setItem('pn-autopost-state', JSON.stringify({ v: 1, stories: [{ url: 'x', title: 'Polícia prende suspeito de assalto em Bayeux', keywords: [], postedAt: new Date().toISOString(), siteId: 46200, igId: '999' }] }));
  });
  await page.getByTestId('hub-postador').click();
  await page.getByTestId('postador-tab-auto').click();
  await page.getByTestId('ig-list-load').click();
  const items = page.getByTestId('ig-item');
  await expect(items).toHaveCount(2); // a em revisão fica de fora
  await expect(items.nth(0)).toContainText('820 visualizações');
  await expect(items.nth(0).getByTestId('ig-post')).toBeVisible();
  await expect(items.nth(1)).toContainText('✓ no Instagram');
  await expect(items.nth(1).getByTestId('ig-post')).toHaveCount(0);
  await page.evaluate(() => ['pn-websg', 'pn-autopost-state'].forEach((k) => localStorage.removeItem(k)));
});

test('Post em vídeo com música que vem no app: entra na biblioteca e o vídeo sai COM a música no trecho certo', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/');
  const r = await page.evaluate(async () => {
    // módulos do app servidos pelo Vite (caminho só existe no navegador)
    const load = (p: string) => import(/* @vite-ignore */ p);
    type Api = { projects: { get(id: string): Promise<{ clips: { type: string }[] }> }; media: { get(id: string): Promise<{ status: string; duration: number }> } };
    const sv = (await load('/src/ui/storyVideo.ts')) as { createStoryVideo(i: Record<string, unknown>): Promise<string> };
    const api = (await load('/src/platform/api.ts')) as Api;
    const id = await sv.createStoryVideo({ kicker: 'Policial', title: 'Teste de música', subtitle: 'Subtítulo curto.', audioId: 'pn-musica:dark-knight', audioStart: 86.5, audioDur: 15 });
    const p = await api.projects.get(id);
    const a = p.clips.find((c: { type: string }) => c.type === 'audio') as { mediaId: string; sourceIn: number; duration: number } | undefined;
    const m = a ? await api.media.get(a.mediaId) : null;
    return { tem: !!a, sourceIn: a?.sourceIn, dur: a?.duration, status: m?.status, total: m?.duration };
  });
  expect(r.tem).toBe(true);
  expect(r.status).toBe('ready');
  expect(r.sourceIn).toBe(86.5);
  expect(r.dur).toBe(15);
  expect(r.total!).toBeGreaterThan(140);
});

test('Pautas: marcar várias e enviar de uma vez (uma atrás da outra)', async ({ page }) => {
  const { photo } = fixtures();
  const P2 = { ...PAUTA, id: 'p2', title: 'Outra pauta nacional em alta', city: null, score: 60, url: 'https://portal.test/2' };
  await page.route('**/api/fx', (r) => r.fulfill({ json: { rate: 5, at: '2026-10-23', approx: false } }));
  await page.route('**/api/news/config', (r) => r.fulfill({ json: { ai: true } }));
  await page.route('**/api/pautas?*', (r) => r.fulfill({ json: { pautas: [PAUTA, P2], plan: null } }));
  await page.route('**/api/site/write', (r) =>
    r.fulfill({ json: { titulo: 'Título gerado', subtitulo: 'Sub', minititulo: 'GERAL', categoria: 'Geral', palavrasChave: [], paragrafos: ['Parágrafo.'], imagens: [{ src: 'https://portal.test/foto1.jpg', caption: '' }], html: '<p>Parágrafo.</p>', unverified: [], style: [], model: 'google/gemini-2.5-flash-lite', steps: [], costUsd: 0.0003 } }),
  );
  let publicadas: string[] = [];
  let idSeq = 46300;
  await page.route('**/api/site/publish', (r) => {
    publicadas.push((r.request().postDataJSON() as { post: { titulo: string } }).post.titulo);
    return r.fulfill({ json: { id: idSeq++, steps: [] } });
  });
  await page.route('**/api/pautas/image?*', (r) => r.fulfill({ body: readFileSync(photo), contentType: 'image/jpeg' }));
  await page.goto('/');
  await page.evaluate(() => localStorage.removeItem('pn-fila-instagram'));
  await page.getByTestId('hub-postador').click();
  await page.getByTestId('postador-capture').click();
  await expect(page.getByTestId('postador-pauta')).toHaveCount(2);
  // marcar todas
  await page.getByTestId('postador-marcar-todas').click();
  await expect(page.getByTestId('postador-check').nth(0)).toBeChecked();
  await expect(page.getByTestId('postador-check').nth(1)).toBeChecked();
  await page.getByTestId('postador-enviar-selecionadas').click();
  await expect(page.getByTestId('postador-post-status')).toHaveCount(2, { timeout: 30_000 });
  await expect(page.getByTestId('postador-post-status').first()).toContainText('No site');
  expect(publicadas).toHaveLength(2); // uma atrás da outra
  // não fica preso marcado depois de postar (some o checkbox das já postadas)
  await expect(page.getByTestId('postador-check')).toHaveCount(0);
  // nova leva de pautas (ainda não postadas): marcar só uma funciona normalmente
  const P3 = { ...PAUTA, id: 'p3', url: 'https://portal.test/3' };
  await page.route('**/api/pautas?*', (r) => r.fulfill({ json: { pautas: [P3, { ...P2, id: 'p4', url: 'https://portal.test/4' }], plan: null } }));
  await page.getByTestId('postador-capture').click();
  await expect(page.getByTestId('postador-check')).toHaveCount(2);
  await page.getByTestId('postador-check').first().check();
  await expect(page.getByTestId('postador-enviar-selecionadas')).toContainText('(1)');
});
