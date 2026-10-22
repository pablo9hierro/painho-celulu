/**
 * Servidor do PC: mantém os tokens do Instagram vivos sozinho.
 * Na partida e a cada 6 h confere; só renova o token do Instagram 10 dias antes de vencer e grava
 * o novo no .env.local; confere quando vence o acesso do token do Facebook.
 */
import type { Express } from 'express';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { maintainTokens, type TokenMeta } from '../src/news/igToken';
import { account } from '../src/news/instagram';
import { nodeIgHttp } from './siteHttp';

const ROOT = process.cwd();
const META = path.join(ROOT, 'data', 'ig-token.json');
const ENV = path.join(ROOT, '.env.local');

let meta: TokenMeta = {};
let warnings: string[] = [];

function load() {
  try {
    meta = JSON.parse(readFileSync(META, 'utf8')) as TokenMeta;
  } catch {
    meta = {};
  }
}
function save() {
  mkdirSync(path.dirname(META), { recursive: true });
  // o token em si fica só no .env.local; aqui só datas
  const { igToken: _t, ...rest } = meta;
  writeFileSync(META, JSON.stringify(rest, null, 1));
}
function writeEnv(key: string, value: string) {
  if (!existsSync(ENV)) return;
  const t = readFileSync(ENV, 'utf8');
  const re = new RegExp(`^${key}=.*$`, 'm');
  writeFileSync(ENV, re.test(t) ? t.replace(re, `${key}=${value}`) : `${t.trimEnd()}\n${key}=${value}\n`);
}

export async function tokenRound(): Promise<string[]> {
  const ig = (process.env.INSTAGRAM_ACCESS_TOKEN ?? '').trim();
  const fb = (process.env.INSTAGRAM_FB_TOKEN ?? '').trim() || (ig.startsWith('EAA') ? ig : '');
  const appToken = process.env.INSTAGRAM_APP_ID && process.env.INSTAGRAM_APP_SECRET ? `${process.env.INSTAGRAM_APP_ID}|${process.env.INSTAGRAM_APP_SECRET}` : undefined;
  if (!ig && !fb) return [];
  const r = await maintainTokens(nodeIgHttp, { igToken: ig.startsWith('IG') ? ig : undefined, fbToken: fb || undefined, appToken, appId: process.env.INSTAGRAM_APP_ID, appSecret: process.env.INSTAGRAM_APP_SECRET }, { ...meta, igToken: undefined });
  if (r.fbToken) {
    process.env.INSTAGRAM_FB_TOKEN = r.fbToken;
    writeEnv('INSTAGRAM_FB_TOKEN', r.fbToken);
  }
  meta = r.meta;
  if (r.igToken && r.igToken !== ig && ig.startsWith('IG')) {
    process.env.INSTAGRAM_ACCESS_TOKEN = r.igToken;
    writeEnv('INSTAGRAM_ACCESS_TOKEN', r.igToken);
  }
  save();
  warnings = r.warnings;
  for (const l of [...r.log, ...r.warnings]) console.log(`[instagram] ${l}`);
  return r.warnings;
}

export function registerIgTokens(app: Express) {
  load();
  setTimeout(() => void tokenRound().catch(() => undefined), 20_000);
  setInterval(() => void tokenRound().catch(() => undefined), 6 * 3600_000).unref();
  app.get('/api/instagram/status', async (_req, res) => {
    const token = (process.env.INSTAGRAM_FB_TOKEN || process.env.INSTAGRAM_ACCESS_TOKEN || '').trim();
    let acc: { username: string; followers_count?: number } | null = null;
    if (token && process.env.INSTAGRAM_USER_ID) {
      try {
        acc = await account(nodeIgHttp, { userId: process.env.INSTAGRAM_USER_ID, token });
      } catch {
        acc = null;
      }
    }
    res.json({ configurado: !!token, conta: acc, igRenovadoEm: meta.igRefreshedAt ?? null, igVence: meta.igExpiresAt ?? null, fbAcessoVence: meta.fbDataExpiresAt ?? null, avisos: warnings });
  });
}
