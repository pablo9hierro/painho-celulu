import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { ffmpegPaths } from '../server/config';
import { probe } from './fixtures';

/** Vídeo de 20 s com GOP longo (como câmeras de celular) para medir a exportação local. */
function phoneLikeVideo(): { file: string; name: string } {
  const dir = path.resolve('e2e/.fixtures');
  mkdirSync(dir, { recursive: true });
  const name = `celular-${Date.now().toString(36)}`;
  const file = path.join(dir, `${name}.mp4`);
  if (!existsSync(file)) {
    execFileSync(ffmpegPaths().ffmpeg, [
      '-y', '-v', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=20',
      '-f', 'lavfi', '-i', 'sine=frequency=330:duration=20',
      '-c:v', 'libx264', '-g', '60', '-bf', '2', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file,
    ]);
  }
  return { file, name };
}

test('desempenho da exportação local (20 s de vídeo)', async ({ page }) => {
  test.setTimeout(600_000);
  page.on('console', (m) => m.text().startsWith('PN_PROFILE') && console.log(m.text()));
  await page.goto('/?local=1');
  await page.getByTestId('new-reel').click();
  const { file, name } = phoneLikeVideo();
  await page.getByTestId('file-input').setInputFiles(file);
  const item = page.getByTestId('media-item').filter({ hasText: name });
  await expect(item).toHaveClass(/ready/, { timeout: 120_000 });
  await item.click();
  await page.getByTestId('rail-text').click();
  await page.getByTestId('frame-topo').click();
  await page.getByTestId('preset-pn-faixa').click();
  await page.getByTestId('open-export').click();
  const dl = page.waitForEvent('download', { timeout: 550_000 });
  const t0 = Date.now();
  await page.getByTestId('start-export').click();
  const download = await dl;
  const seconds = (Date.now() - t0) / 1000;
  const saved = `test-results/perf-${download.suggestedFilename()}`;
  await download.saveAs(saved);
  const info = probe(saved);
  console.log(`EXPORT_SECONDS=${seconds.toFixed(1)} duration=${info.duration.toFixed(2)} streams=${info.streams.join(',')}`);
  expect(Math.abs(info.duration - 23.5)).toBeLessThan(0.3); // 20 s + encerramento automático
});
