import { spawn, type ChildProcess } from 'node:child_process';
import { ffmpegPaths } from './config';

export interface RunResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

/** Executa ffmpeg/ffprobe com argumentos (sem shell) e coleta a saída. */
export function run(bin: 'ffmpeg' | 'ffprobe', args: string[], onSpawn?: (p: ChildProcess) => void): Promise<RunResult> {
  const exe = ffmpegPaths()[bin];
  return new Promise((resolve, reject) => {
    const p = spawn(exe, args, { windowsHide: true });
    onSpawn?.(p);
    const out: Buffer[] = [];
    let err = '';
    p.stdout.on('data', (d: Buffer) => out.push(d));
    p.stderr.on('data', (d: Buffer) => {
      err += d.toString();
      if (err.length > 200_000) err = err.slice(-100_000);
    });
    p.on('error', reject);
    p.on('close', (code) => resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr: err }));
  });
}

export async function runOk(bin: 'ffmpeg' | 'ffprobe', args: string[]): Promise<Buffer> {
  const r = await run(bin, args);
  if (r.code !== 0) throw new Error(`${bin} falhou (${r.code}): ${r.stderr.split('\n').slice(-6).join('\n')}`);
  return r.stdout;
}

export interface ProbeStream {
  codec_type: 'video' | 'audio' | string;
  codec_name?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  sample_aspect_ratio?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  duration?: string;
  nb_frames?: string;
  disposition?: { attached_pic?: number };
  tags?: { rotate?: string };
  side_data_list?: { rotation?: number }[];
}

export interface ProbeResult {
  streams: ProbeStream[];
  format: { format_name?: string; duration?: string; size?: string };
}

export async function probe(file: string): Promise<ProbeResult> {
  const out = await runOk('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  return JSON.parse(out.toString('utf8')) as ProbeResult;
}

export function parseRate(r?: string): number {
  if (!r) return 0;
  const [a, b] = r.split('/').map(Number);
  if (!a || !b) return Number(r) || 0;
  return a / b;
}
