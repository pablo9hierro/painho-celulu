import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { ffmpegPaths } from '../server/config';

/**
 * Vídeo final nunca distorcido: um vídeo "anamórfico" (pixel não quadrado, comum
 * em vídeo de WhatsApp/celular) com um QUADRADO branco no meio precisa sair com
 * o quadrado quadrado — nem achatado, nem esticado — no app (local) e no PC.
 */
const DIR = path.resolve('e2e/.fixtures');

function anamorphicVideo(): { file: string; name: string } {
  mkdirSync(DIR, { recursive: true });
  const base = path.join(DIR, 'anamorfico.mp4');
  if (!existsSync(base)) {
    // 540x960 gravado com pixel 4:3 → exibido 720x960 (3:4). Quadrado de exibição 300 = 225x300 em pixels.
    execFileSync(ffmpegPaths().ffmpeg, [
      '-y', '-v', 'error',
      '-f', 'lavfi', '-i', 'color=c=black:s=540x960:r=30:d=3',
      '-f', 'lavfi', '-i', 'sine=frequency=330:duration=3',
      '-vf', 'drawbox=x=157:y=330:w=225:h=300:color=white:t=fill,setsar=4/3',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', base,
    ]);
  }
  const name = `anam-${Date.now().toString(36)}`;
  const file = path.join(DIR, `${name}.mp4`);
  copyFileSync(base, file);
  return { file, name };
}

/** Caixa dos pixels claros num quadro do vídeo exportado (largura/altura). */
function whiteBox(file: string, at: number) {
  const { ffmpeg, ffprobe } = ffmpegPaths();
  const info = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', file], { encoding: 'utf8' })) as { streams: { width: number; height: number }[] };
  const { width: W, height: H } = info.streams[0]!;
  const raw = execFileSync(ffmpeg, ['-v', 'error', '-ss', String(at), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 64 * 1024 * 1024 });
  let x0 = W, y0 = H, x1 = 0, y1 = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (raw[y * W + x]! > 200) {
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return { w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

for (const mode of ['local', 'servidor'] as const) {
  test(`vídeo exportado sem distorção (${mode})`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto(mode === 'local' ? '/?local=1' : '/');
    await page.getByTestId('new-reel').click();
    const { file, name } = anamorphicVideo();
    await page.getByTestId('file-input').setInputFiles(file);
    const item = page.getByTestId('media-item').filter({ hasText: name });
    await expect(item).toHaveClass(/ready/, { timeout: 60_000 });
    await item.click();
    await expect(page.getByTestId('clip-video')).toHaveCount(1);
    await page.getByTestId('open-export').click();
    await page.getByTestId('export-outro').uncheck(); // só o vídeo
    const dl = page.waitForEvent('download', { timeout: 150_000 });
    await page.getByTestId('start-export').click();
    const download = await dl;
    const saved = `test-results/aspect-${mode}-${download.suggestedFilename()}`;
    await download.saveAs(saved);
    const box = whiteBox(saved, 1.5);
    expect(box.w).toBeGreaterThan(100);
    // quadrado continua quadrado (tolerância de 3%)
    expect(Math.abs(box.w / box.h - 1)).toBeLessThan(0.03);
  });
}
