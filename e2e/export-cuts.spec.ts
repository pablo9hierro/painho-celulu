import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { ffmpegPaths } from '../server/config';

/**
 * Cortar e trocar os pedaços de lugar TEM que sair no vídeo exportado:
 * vídeo de 3 faixas de cor (escuro 0–2 s, médio 2–4 s, claro 4–6 s), apaga a do meio
 * e põe a clara antes da escura. O vídeo final precisa ser claro → escuro (4 s).
 */
const DIR = path.resolve('e2e/.fixtures');

function tresCores(): { file: string; name: string } {
  mkdirSync(DIR, { recursive: true });
  const base = path.join(DIR, 'tres-cores.mp4');
  if (!existsSync(base)) {
    execFileSync(ffmpegPaths().ffmpeg, [
      '-y', '-v', 'error',
      '-f', 'lavfi', '-i', 'color=c=0x282828:s=640x360:r=30:d=2',
      '-f', 'lavfi', '-i', 'color=c=0x828282:s=640x360:r=30:d=2',
      '-f', 'lavfi', '-i', 'color=c=0xdcdcdc:s=640x360:r=30:d=2',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
      '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]',
      '-map', '[v]', '-map', '3:a', '-c:v', 'libx264', '-g', '90', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', base,
    ]);
  }
  const name = `cores-${Date.now().toString(36)}`;
  const file = path.join(DIR, `${name}.mp4`);
  copyFileSync(base, file);
  return { file, name };
}

/** brilho médio do centro do quadro em `at` segundos */
function brilho(file: string, at: number): number {
  const raw = execFileSync(ffmpegPaths().ffmpeg, ['-v', 'error', '-ss', String(at), '-i', file, '-frames:v', '1', '-vf', 'crop=iw/4:ih/8', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 64 * 1024 * 1024 });
  let s = 0;
  for (const v of raw) s += v;
  return s / raw.length;
}

for (const mode of ['local', 'servidor'] as const) {
  test(`cortes e pedaços trocados saem na exportação (${mode})`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto(mode === 'local' ? '/?local=1' : '/');
    await page.getByTestId('new-reel').click();
    const { file, name } = tresCores();
    await page.getByTestId('file-input').setInputFiles(file);
    const item = page.getByTestId('media-item').filter({ hasText: name });
    await expect(item).toHaveClass(/ready/, { timeout: 60_000 });
    await item.click();
    await expect(page.getByTestId('clip-video')).toHaveCount(1);
    await page.evaluate(async () => {
      const load = (p: string) => import(/* @vite-ignore */ p);
    const tl = await load('/src/core/timeline.ts');
      const ed = (window as any).__editor.getState();
      ed.apply((p: any) => {
        const v = p.clips.find((c: any) => c.type === 'video');
        let r = tl.splitClip(p, v.id, v.start + 2);
        const meio = r.newId!;
        r = tl.splitClip(r.project, meio, v.start + 4);
        const claro = r.newId!;
        let q = tl.deleteClips(r.project, [meio]);
        // clara no começo, escura logo depois
        q = tl.moveClip(q, v.id, 10);
        q = tl.moveClip(q, claro, 0);
        q = tl.moveClip(q, v.id, 2);
        return q;
      });
    });
    const clips = await page.evaluate(() => (window as any).__editor.getState().project.clips.filter((c: any) => c.type === 'video').map((c: any) => [c.start, c.duration, c.sourceIn]));
    console.log('trechos', JSON.stringify(clips));
    await page.getByTestId('open-export').click();
    await page.getByTestId('export-outro').uncheck();
    const dl = page.waitForEvent('download', { timeout: 150_000 });
    await page.getByTestId('start-export').click();
    const download = await dl;
    const saved = `test-results/cortes-${mode}-${download.suggestedFilename()}`;
    await download.saveAs(saved);
    const b = [0.5, 1.5, 2.5, 3.5].map((t) => Math.round(brilho(saved, t)));
    console.log(mode, 'brilho', b);
    expect(b[0]).toBeGreaterThan(180);
    expect(b[1]).toBeGreaterThan(180);
    expect(b[2]).toBeLessThan(70);
    expect(b[3]).toBeLessThan(70);
  });
}

for (const trocar of [true, false])
test(`prévia: depois de cortar${trocar ? ' e trocar' : ''}, toca só o pedaço certo (sem o original por baixo)`, async ({ page }) => {
  test.setTimeout(120_000);
  // guarda todos os players de mídia que o app cria
  await page.addInitScript(() => {
    const orig = document.createElement.bind(document);
    (window as any).__players = [];
    document.createElement = ((tag: string, o?: ElementCreationOptions) => {
      const el = orig(tag, o);
      if (tag === 'video' || tag === 'audio') (window as any).__players.push(el);
      return el;
    }) as typeof document.createElement;
  });
  await page.goto('/?local=1');
  await page.getByTestId('new-reel').click();
  const { file, name } = tresCores();
  await page.getByTestId('file-input').setInputFiles(file);
  const item = page.getByTestId('media-item').filter({ hasText: name });
  await expect(item).toHaveClass(/ready/, { timeout: 60_000 });
  await item.click();
  await page.evaluate(async (trocar) => {
    const load = (p: string) => import(/* @vite-ignore */ p);
    const tl = await load('/src/core/timeline.ts');
    const ed = (window as any).__editor.getState();
    ed.apply((p: any) => {
      const v = p.clips.find((c: any) => c.type === 'video');
      let r = tl.splitClip(p, v.id, v.start + 2);
      const meio = r.newId!;
      r = tl.splitClip(r.project, meio, v.start + 4);
      const claro = r.newId!;
      let q = tl.deleteClips(r.project, [meio]);
      if (trocar) {
        q = tl.moveClip(q, v.id, 10);
        q = tl.moveClip(q, claro, 0);
        q = tl.moveClip(q, v.id, 2);
      } else q = tl.moveClip(q, claro, 2);
      return q;
    });
    ed.select([]);
    ed.setTime(0);
  }, trocar);
  await page.waitForTimeout(800);
  await page.getByTestId('play').click();
  const amostras: { t: number; tocando: number; brilho: number }[] = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 3600) {
    amostras.push(
      await page.evaluate(() => {
        const c = document.querySelector('[data-testid="stage"] canvas') as HTMLCanvasElement;
        const d = c.getContext('2d')!.getImageData(Math.round(c.width * 0.4), Math.round(c.height * 0.48), Math.round(c.width * 0.2), 4).data;
        let s = 0;
        for (let i = 0; i < d.length; i += 4) s += d[i]!;
        const players = (window as any).__players as HTMLMediaElement[];
        return { t: (window as any).__editor.getState().time, tocando: players.filter((p) => !p.paused && p.src).length, brilho: Math.round(s / (d.length / 4)) };
      }),
    );
    await page.waitForTimeout(100);
  }
  console.log(amostras.map((a) => `${a.t.toFixed(1)}:${a.tocando}/${a.brilho}`).join(' '));
  // nunca dois players tocando juntos (o pedaço tirado não pode tocar escondido)
  expect(Math.max(...amostras.map((a) => a.tocando))).toBeLessThanOrEqual(1);
  // claro antes do corte, escuro depois
  for (const a of amostras) {
    const antes = trocar ? a.brilho > 170 : a.brilho < 90;
    const depois = trocar ? a.brilho < 90 : a.brilho > 170;
    if (a.t > 0.3 && a.t < 1.8) expect(antes).toBe(true);
    if (a.t > 2.3 && a.t < 3.7) expect(depois).toBe(true);
  }
});
