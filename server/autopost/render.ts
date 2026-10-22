/**
 * Renderiza o post em vídeo SEM ninguém no app: abre a interface do Studio
 * num Chromium invisível, monta o MESMO projeto do app (buildStoryProject),
 * desenha cada quadro com o MESMO renderizador da exportação e manda para o
 * ffmpeg. A trilha do tom entra na mixagem final.
 */
import { spawn } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { ffmpegPaths } from '../config';

export interface RenderInput {
  /** endereço da interface (vite) — ex.: http://localhost:5173/ */
  appUrl: string;
  kicker: string;
  title: string;
  subtitle: string;
  keywords: string[];
  photo: { data: Uint8Array; type: string } | null;
  audioPath?: string | null;
  seconds: number;
  out: string;
  log?: (m: string) => void;
}

function run(args: string[], input?: (w: NodeJS.WritableStream) => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPaths().ffmpeg, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-4000)));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg falhou (${code}): ${err.slice(-600)}`))));
    if (input) input(p.stdin).then(() => p.stdin.end(), (e) => { p.kill(); reject(e); });
    else p.stdin.end();
  });
}

/**
 * Código que roda DENTRO da página (como texto puro: o tsx não pode mexer nele).
 * Os módulos vêm do Vite; o projeto e o desenho são os mesmos do app.
 */
const PAGE_SETUP = `async ({ photo, kicker, title, subtitle, keywords, seconds }) => {
  const { ensureFonts } = await import('/src/render/fonts.ts');
  const { ensureBrandAssets } = await import('/src/render/brandAssets.ts');
  const { renderFrame } = await import('/src/render/renderer.ts');
  const { buildStoryProject } = await import('/src/ui/storyVideo.ts');
  await ensureFonts();
  await ensureBrandAssets();
  let img = null;
  if (photo) {
    img = new Image();
    img.src = photo;
    await img.decode();
  }
  const p = buildStoryProject({ kicker, title, subtitle, keywords, duration: seconds }, img ? { id: 'foto', name: 'foto', width: img.naturalWidth, height: img.naturalHeight } : null, null);
  const cv = document.createElement('canvas');
  cv.width = p.width;
  cv.height = p.height;
  const ctx = cv.getContext('2d');
  const src = { video: () => null, image: () => img, size: () => (img ? { w: img.naturalWidth, h: img.naturalHeight } : null) };
  // primeira passada carrega os caches (moldura, logos); depois desenha de verdade
  renderFrame(ctx, p, seconds / 2, src, { editorHints: false });
  await new Promise((r) => setTimeout(r, 800));
  window.__pn = (t) => {
    renderFrame(ctx, p, t, src, { editorHints: false });
    return cv.toDataURL('image/jpeg', 0.92);
  };
  return Math.round(seconds * 30);
}`;

export async function renderStoryVideo(o: RenderInput): Promise<void> {
  const fps = 30;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(o.appUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    const photo = o.photo ? `data:${o.photo.type};base64,${Buffer.from(o.photo.data).toString('base64')}` : null;
    const frames = Number(await page.evaluate(`(${PAGE_SETUP})(${JSON.stringify({ photo, kicker: o.kicker, title: o.title, subtitle: o.subtitle, keywords: o.keywords, seconds: o.seconds })})`));
    o.log?.(`Renderizando ${frames} quadros...`);
    const silent = `${o.out}.video.mp4`;
    await run(['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', silent], async (w) => {
      for (let i = 0; i < frames; i++) {
        const url = String(await page.evaluate(`window.__pn(${i / fps})`));
        const buf = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
        if (!w.write(buf)) await new Promise((r) => w.once('drain', r));
      }
    });
    // áudio: trilha do tom (com entrada/saída suaves) ou silêncio (o Instagram pede faixa de áudio)
    const fadeOut = Math.max(0, o.seconds - 1.2);
    const args = o.audioPath
      ? ['-y', '-loglevel', 'error', '-i', silent, '-i', o.audioPath, '-filter_complex', `[1:a]atrim=0:${o.seconds},asetpts=N/SR/TB,afade=t=in:d=0.3,afade=t=out:st=${fadeOut}:d=1.2,volume=0.85[a]`, '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-t', String(o.seconds), '-movflags', '+faststart', o.out]
      : ['-y', '-loglevel', 'error', '-i', silent, '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-t', String(o.seconds), '-movflags', '+faststart', o.out];
    await run(args);
    readFileSync(o.out); // garante que o arquivo existe
    rmSync(silent, { force: true });
  } finally {
    await browser.close();
  }
}
