import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { ffmpegPaths } from '../server/config';
import { probe, uniqueTestVideo } from './fixtures';

/**
 * Vídeo longo no modo do app (local): importar sem travar, acelerar sem mudar
 * a voz e exportar até o fim. Também confere a voz no PC (servidor).
 */
const DIR = path.resolve('e2e/.fixtures');

function longVideo(seconds: number): { file: string; name: string } {
  mkdirSync(DIR, { recursive: true });
  const base = path.join(DIR, `longo-${seconds}s.mp4`);
  if (!existsSync(base)) {
    execFileSync(ffmpegPaths().ffmpeg, [
      '-y', '-v', 'error',
      '-f', 'lavfi', '-i', `testsrc2=size=1080x1920:rate=30:duration=${seconds}`,
      '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '6M', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-shortest', base,
    ]);
  }
  const name = `longo-${Date.now().toString(36)}`;
  const file = path.join(DIR, `${name}.mp4`);
  copyFileSync(base, file);
  return { file, name };
}

/** frequência dominante do áudio entre a e b segundos (cruzamentos de zero) */
function audioFreq(file: string, a: number, b: number) {
  const raw = execFileSync(ffmpegPaths().ffmpeg, ['-v', 'error', '-ss', String(a), '-t', String(b - a), '-i', file, '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'], { maxBuffer: 1 << 28 });
  const x = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  let z = 0;
  for (let i = 1; i < x.length; i++) if (x[i - 1]! < 0 && x[i]! >= 0) z++;
  return z / (x.length / 48000);
}

async function setSpeed2(page: Page) {
  await page.getByTestId('clip-video').click();
  await page.getByTestId('speed-2').click();
  await expect(page.getByTestId('speed-2')).toHaveClass(/primary/);
}

async function exportNoOutro(page: Page, timeout: number) {
  await page.getByTestId('open-export').click();
  await page.getByTestId('export-outro').uncheck();
  const dl = page.waitForEvent('download', { timeout });
  await page.getByTestId('start-export').click();
  return dl;
}

test('vídeo de 5 min no modo app: importa, acelera 2x sem mudar a voz e exporta', async ({ page }) => {
  test.setTimeout(900_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const { file, name } = longVideo(300);
  console.log('tamanho do vídeo de teste:', (statSync(file).size / 1e6).toFixed(0), 'MB');
  await page.goto('/?local=1');
  await page.getByTestId('new-reel').click();
  await page.getByTestId('file-input').setInputFiles(file);
  const item = page.getByTestId('media-item').filter({ hasText: name });
  await expect(item).toHaveClass(/ready/, { timeout: 180_000 });
  await item.click();
  await expect(page.getByTestId('clip-video')).toHaveCount(1);
  // forma de onda gerada aos poucos (sem carregar o arquivo todo)
  const wave = await page.evaluate(async () => {
    const s = (window as unknown as { __editor: { getState(): { media: Record<string, { waveform: string | null; hasAudio: boolean; duration: number }> } } }).__editor.getState();
    const m = Object.values(s.media).find((x) => x.duration > 200)!;
    return { waveform: m.waveform, hasAudio: m.hasAudio, duration: m.duration };
  });
  expect(wave.hasAudio).toBe(true);
  expect(wave.waveform).toBeTruthy();
  expect(wave.duration).toBeGreaterThan(299);

  await setSpeed2(page);
  const download = await exportNoOutro(page, 840_000);
  const saved = `test-results/longo-${download.suggestedFilename()}`;
  await download.saveAs(saved);
  const info = probe(saved);
  expect(info.streams).toContain('video');
  expect(info.streams).toContain('audio');
  expect(Math.abs(info.duration - 150)).toBeLessThan(0.6);
  // voz igual: 440 Hz continua 440 Hz (antes ficava 880 Hz)
  for (const at of [5, 70, 140]) expect(Math.abs(audioFreq(saved, at, at + 2) - 440)).toBeLessThan(12);
  expect(errors).toEqual([]);
});

for (const mode of ['local', 'servidor'] as const) {
  test(`acelerar/desacelerar não muda a voz na exportação (${mode})`, async ({ page }) => {
    test.setTimeout(240_000);
    await page.goto(mode === 'local' ? '/?local=1' : '/');
    await page.getByTestId('new-reel').click();
    const { file, name } = uniqueTestVideo(); // 6 s com tom de 440 Hz
    await page.getByTestId('file-input').setInputFiles(file);
    const item = page.getByTestId('media-item').filter({ hasText: name });
    await expect(item).toHaveClass(/ready/, { timeout: 60_000 });
    await item.click();
    await page.getByTestId('clip-video').click();
    await page.getByTestId('speed-0.5').click();
    const download = await exportNoOutro(page, 200_000);
    const saved = `test-results/voz-${mode}-${download.suggestedFilename()}`;
    await download.saveAs(saved);
    expect(Math.abs(probe(saved).duration - 12)).toBeLessThan(0.4);
    expect(Math.abs(audioFreq(saved, 2, 10) - 440)).toBeLessThan(12);
  });
}
