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
        tom: 'Policial',
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
  await page.getByTestId('tone-name').fill('Policial');
  await page.getByTestId('tone-add').click();
  const card = page.getByTestId('tone-card');
  await expect(card).toHaveCount(1);
  await card.locator('input[type=file]').setInputFiles(audio);
  await expect(card.locator('input[aria-label="Nome do áudio"]')).toHaveValue('tensao-grave', { timeout: 60_000 });

  // PAUTAS: captura, ranking, abre e escreve
  await page.getByTestId('postador-tab-pautas').click();
  await page.getByTestId('postador-capture').click();
  await expect(page.getByTestId('postador-pauta')).toHaveCount(2);
  await expect(page.getByTestId('postador-pauta').first()).toContainText('96 pts');
  await page.getByTestId('postador-pauta').first().click();
  await expect(page.getByTestId('postador-open')).toContainText('dá para baixar');
  await page.getByTestId('postador-write').click();
  const story = page.getByTestId('postador-story');
  await expect(story).toContainText('destaque: “prende dois suspeitos”');
  await expect(story).toContainText('tom: Policial');
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
  expect(cs.some((c) => c.type === 'frame' && c.frame === 'central')).toBe(true);
  expect(cs.some((c) => c.type === 'image')).toBe(true);
  expect(cs.find((c) => c.type === 'audio')?.name).toContain('tensao-grave');
  expect(text.duration).toBe(8);
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
  await expect(page.getByText('cron único')).toBeVisible();
});

test('Tons: áudios cadastrados no app vão para a automação com os nomes certos', async ({ page }) => {
  const { audio } = fixtures();
  const puts: { path: string; body: { content: string; branch: string } }[] = [];
  await page.route('https://api.github.com/**', async (r) => {
    const url = r.request().url();
    if (r.request().method() === 'PUT') {
      puts.push({ path: decodeURIComponent(url.split('/contents/')[1]!), body: r.request().postDataJSON() });
      return r.fulfill({ status: 201, json: { content: {} } });
    }
    if (url.includes('/git/ref/heads/autopost-dados')) return r.fulfill({ json: { object: { sha: 'x' } } });
    return r.fulfill({ status: 404, json: { message: 'Not Found' } });
  });
  await page.goto('/');
  await page.getByTestId('hub-postador').click();
  await page.getByTestId('postador-tab-tons').click();
  const sync = page.getByTestId('tone-sync');
  await sync.locator('input[type=password]').fill('github_pat_teste');
  await page.getByTestId('tone-name').fill('Matéria policial');
  await page.getByTestId('tone-add').click();
  const card = page.getByTestId('tone-card').last();
  await card.locator('input[type=file]').setInputFiles(audio);
  await expect(card.locator('input[aria-label="Nome do áudio"]').last()).toHaveValue('tensao-grave', { timeout: 60_000 });
  await card.locator('input[aria-label="Nome do áudio"]').last().fill('matéria policial 1');
  await page.getByTestId('tone-sync-go').click();
  await expect(page.getByTestId('tone-sync-status')).toContainText('Automação atualizada', { timeout: 30_000 });
  const idx = puts.find((p) => p.path === 'tons/tons.json')!;
  const j = JSON.parse(Buffer.from(idx.body.content, 'base64').toString('utf8')) as { audios: { tom: string; nome: string; arquivo: string }[] };
  const a = j.audios.find((x) => x.tom === 'Matéria policial')!;
  expect(a.nome).toBe('matéria policial 1');
  expect(puts.some((p) => p.path === a.arquivo && p.body.branch === 'autopost-dados')).toBe(true);
});
