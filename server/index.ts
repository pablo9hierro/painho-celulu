/**
 * API local do Primeiras Notícias Studio. Escuta apenas em 127.0.0.1 —
 * nenhum arquivo sai da máquina.
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ProjectSchema } from '../src/core/model';
import { API_PORT, ensureDirs, ffmpegPaths, ROOT } from './config';
import { getDb, now } from './db';
import {
  brandFile,
  trashBrandFile,
  deleteMedia,
  derivedPath,
  getMedia,
  getMediaRow,
  ingestUpload,
  listBrand,
  listMedia,
  playablePath,
  saveBrandUpload,
} from './media';
import {
  cancelExport,
  cleanupExportDir,
  deleteExportFile,
  finishExport,
  getExport,
  listExports,
  pushFrames,
  startExport,
  type ExportSettings,
} from './exports';

ensureDirs();
cleanupExportDir();
const db = getDb();
const app = express();
app.disable('x-powered-by');

const json = express.json({ limit: '25mb' });
const asyncH =
  (fn: (req: Request, res: Response) => Promise<unknown> | unknown) => (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res)).catch(next);

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
app.get('/api/health', (_req, res) => {
  let ffmpeg: string | null = null;
  let error: string | null = null;
  try {
    ffmpeg = ffmpegPaths().ffmpeg;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  res.json({ ok: true, ffmpeg, error });
});

// ---------------------------------------------------------------------------
// Projetos
// ---------------------------------------------------------------------------
interface ProjectRow {
  id: string;
  name: string;
  format: string;
  data: string;
  thumb: string | null;
  created_at: string;
  updated_at: string;
}

app.get('/api/projects', (_req, res) => {
  const rows = db
    .prepare('SELECT id, name, format, thumb, created_at, updated_at FROM projects ORDER BY updated_at DESC')
    .all() as unknown as Omit<ProjectRow, 'data'>[];
  res.json(rows.map((r) => ({ id: r.id, name: r.name, format: r.format, thumb: r.thumb, createdAt: r.created_at, updatedAt: r.updated_at })));
});

app.post('/api/projects', json, (req, res) => {
  const parsed = ProjectSchema.safeParse(req.body);
  if (!parsed.success) throw new HttpError(400, `Projeto inválido: ${parsed.error.issues[0]?.message ?? ''}`);
  const p = parsed.data;
  const t = now();
  db.prepare('INSERT INTO projects (id, name, format, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    p.id,
    p.name,
    p.format,
    JSON.stringify(p),
    t,
    t,
  );
  res.status(201).json({ id: p.id });
});

app.get('/api/projects/:id', (req, res) => {
  const r = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id) as unknown as ProjectRow | undefined;
  if (!r) throw new HttpError(404, 'Projeto não encontrado.');
  res.json(JSON.parse(r.data));
});

app.put('/api/projects/:id', json, (req, res) => {
  const body = req.body as { project: unknown; thumb?: string };
  const parsed = ProjectSchema.safeParse(body.project);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new HttpError(400, `Projeto inválido em ${issue?.path.join('.')}: ${issue?.message}`);
  }
  const p = parsed.data;
  if (p.id !== req.params.id) throw new HttpError(400, 'ID divergente.');
  const thumb = typeof body.thumb === 'string' && body.thumb.startsWith('data:image/') && body.thumb.length < 400_000 ? body.thumb : null;
  const r = db
    .prepare('UPDATE projects SET name = ?, format = ?, data = ?, thumb = COALESCE(?, thumb), updated_at = ? WHERE id = ?')
    .run(p.name, p.format, JSON.stringify(p), thumb, now(), p.id);
  if (r.changes === 0) throw new HttpError(404, 'Projeto não encontrado.');
  res.json({ ok: true });
});

app.delete('/api/projects/:id', (req, res) => {
  db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Mídia
// ---------------------------------------------------------------------------
app.get('/api/media', (_req, res) => res.json(listMedia()));

app.post(
  '/api/media',
  asyncH(async (req, res) => {
    const name = String(req.query.name ?? 'arquivo');
    const asset = await ingestUpload(req, name);
    res.status(201).json(asset);
  }),
);

app.get('/api/media/:id', (req, res) => {
  const m = getMedia(req.params.id);
  if (!m) throw new HttpError(404, 'Mídia não encontrada.');
  res.json(m);
});

app.get('/api/media/:id/file', (req, res) => {
  const r = getMediaRow(req.params.id);
  if (!r) throw new HttpError(404, 'Mídia não encontrada.');
  res.sendFile(playablePath(r), { headers: { 'Cache-Control': 'private, max-age=31536000, immutable' } });
});

app.get('/api/media/:id/thumbs', (req, res) => {
  const f = derivedPath(req.params.id, 'thumbs.jpg');
  if (!existsSync(f)) throw new HttpError(404, 'Sem miniaturas.');
  res.sendFile(f);
});

app.get('/api/media/:id/waveform', (req, res) => {
  const f = derivedPath(req.params.id, 'waveform.json');
  if (!existsSync(f)) throw new HttpError(404, 'Sem forma de onda.');
  res.type('json').send(readFileSync(f));
});

app.delete('/api/media/:id', (req, res) => {
  deleteMedia(req.params.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Marca (pasta brand/)
// ---------------------------------------------------------------------------
app.get('/api/brand', asyncH(async (_req, res) => res.json(await listBrand())));

app.get('/api/brand/:file', (req, res) => {
  const f = brandFile(req.params.file);
  if (!f) throw new HttpError(404, 'Arquivo de marca não encontrado.');
  res.sendFile(f, { headers: { 'Cache-Control': 'no-cache' } });
});

app.delete('/api/brand/:file', (req, res) => {
  if (!trashBrandFile(req.params.file)) throw new HttpError(404, 'Arquivo de marca não encontrado.');
  res.json({ ok: true });
});

app.post(
  '/api/brand',
  asyncH(async (req, res) => {
    const name = await saveBrandUpload(req, String(req.query.name ?? 'logo.png'));
    res.status(201).json({ name });
  }),
);

// ---------------------------------------------------------------------------
// Exportação
// ---------------------------------------------------------------------------
app.post('/api/exports', json, (req, res) => {
  const body = req.body as { project: unknown; settings: ExportSettings };
  const parsed = ProjectSchema.safeParse(body.project);
  if (!parsed.success) throw new HttpError(400, 'Projeto inválido.');
  const s = body.settings;
  if (!(s && s.width > 0 && s.height > 0 && s.fps > 0 && s.duration > 0)) throw new HttpError(400, 'Configuração inválida.');
  const settings: ExportSettings = {
    width: Math.min(4096, s.width),
    height: Math.min(4096, s.height),
    fps: Math.min(60, s.fps),
    duration: Math.min(60 * 60, s.duration),
    crf: Math.min(35, Math.max(12, s.crf ?? 18)),
  };
  res.status(201).json(startExport(parsed.data, settings));
});

app.post(
  '/api/exports/:id/frames',
  express.raw({ type: '*/*', limit: '300mb' }),
  asyncH(async (req, res) => {
    const count = Number(req.header('x-frame-count') ?? 1);
    await pushFrames(String(req.params.id), req.body as Buffer, count);
    res.json({ ok: true });
  }),
);

app.post(
  '/api/exports/:id/finish',
  asyncH(async (req, res) => {
    const file = await finishExport(String(req.params.id));
    res.json({ ok: true, file: path.basename(file) });
  }),
);

app.delete('/api/exports/:id', (req, res) => {
  cancelExport(req.params.id);
  res.json({ ok: true });
});

app.get('/api/exports', (req, res) => {
  res.json(listExports(req.query.projectId ? String(req.query.projectId) : undefined).map(publicExport));
});

app.get('/api/exports/:id', (req, res) => {
  const r = getExport(req.params.id);
  if (!r) throw new HttpError(404, 'Exportação não encontrada.');
  res.json(publicExport(r));
});

app.get('/api/exports/:id/file', (req, res) => {
  const r = getExport(req.params.id);
  if (!r?.file || !existsSync(r.file)) throw new HttpError(404, 'Arquivo não disponível.');
  if (req.query.inline) res.sendFile(r.file);
  else res.download(r.file, path.basename(r.file));
});

app.delete('/api/exports/:id/file', (req, res) => {
  deleteExportFile(req.params.id);
  res.json({ ok: true });
});

function publicExport(r: ReturnType<typeof getExport> & object) {
  return {
    id: r.id,
    projectId: r.project_id,
    status: r.status,
    progress: r.progress,
    fileName: r.file ? path.basename(r.file) : null,
    filePath: r.file,
    error: r.error,
    settings: JSON.parse(r.settings) as ExportSettings,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
  };
}

// ---------------------------------------------------------------------------
// Build de produção: serve o front-end compilado se existir
// ---------------------------------------------------------------------------
const dist = path.join(ROOT, 'dist');
if (existsSync(dist)) {
  app.use(express.static(dist));
}

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status = err instanceof HttpError ? err.status : 500;
  const message = err instanceof Error ? err.message : String(err);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: message });
});

app.listen(API_PORT, '127.0.0.1', () => {
  console.log(`API local em http://127.0.0.1:${API_PORT}`);
});
