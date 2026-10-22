/**
 * Renovação automática dos tokens do Instagram (igual no PC, no cron e no app):
 * - token do Login do Instagram (IGAA...): vale 60 dias e é renovado SOZINHO
 *   (sem senha de app) só quando faltar 10 dias para vencer (uma vez a cada ~50 dias);
 * - token do Facebook (EAA...): é o que posta os Reels; não expira, mas o
 *   "acesso aos dados" vence (~90 dias) e só renova gerando outro no Explorador
 *   da Graph API — aqui só avisamos com antecedência.
 */
import type { IgHttp } from './instagram';

export interface TokenMeta {
  /** último token do Instagram (IGAA) renovado */
  igToken?: string;
  igRefreshedAt?: string;
  igExpiresAt?: string;
  /** token do Facebook renovado (só no cron, criptografado) */
  fbToken?: string;
  /** vencimento do acesso aos dados do token do Facebook */
  fbDataExpiresAt?: string;
  checkedAt?: string;
}

const DAY = 86400_000;
/** renova quando faltar este tanto para vencer (o token vale 60 dias) */
export const REFRESH_BEFORE_DAYS = 10;

/** Só renova perto do vencimento; sem data conhecida, renova uma vez para saber o vencimento. */
export function igNeedsRefresh(m: TokenMeta, now = new Date()): boolean {
  if (!m.igExpiresAt) return true;
  return new Date(m.igExpiresAt).getTime() - now.getTime() < REFRESH_BEFORE_DAYS * DAY;
}

/** Renova o token do Login do Instagram (precisa ter mais de 24 h e ainda estar válido). */
export async function refreshIgToken(http: IgHttp, token: string, now = new Date()): Promise<{ token: string; expiresAt: string }> {
  const r = (await http.get(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token)}`)) as { access_token?: string; expires_in?: number; error?: { message?: string } };
  if (!r.access_token) throw new Error(`Instagram não renovou o token: ${r.error?.message ?? 'sem resposta'}`);
  return { token: r.access_token, expiresAt: new Date(now.getTime() + (r.expires_in ?? 60 * 86400) * 1000).toISOString() };
}

/** Quando vence o acesso aos dados do token do Facebook (precisa do token do app: id|segredo). */
export async function fbDataExpiry(http: IgHttp, token: string, appToken: string): Promise<string | null> {
  const r = (await http.get(`https://graph.facebook.com/v21.0/debug_token?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(appToken)}`)) as { data?: { data_access_expires_at?: number; is_valid?: boolean } };
  const t = r.data?.data_access_expires_at;
  return t ? new Date(t * 1000).toISOString() : null;
}

/** Renova o token do Facebook pela troca oficial (fb_exchange_token). Precisa do id e do segredo do app. */
export async function refreshFbToken(http: IgHttp, token: string, appId: string, appSecret: string): Promise<string> {
  const r = (await http.get(`https://graph.facebook.com/v21.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${encodeURIComponent(appId)}&client_secret=${encodeURIComponent(appSecret)}&fb_exchange_token=${encodeURIComponent(token)}`)) as { access_token?: string; error?: { message?: string } };
  if (!r.access_token) throw new Error(`Facebook não renovou o token: ${r.error?.message ?? 'sem resposta'}`);
  return r.access_token;
}

/**
 * Uma rodada de manutenção: renova o do Instagram se for a hora e confere o do
 * Facebook. Devolve o que mudou e avisos legíveis.
 */
export async function maintainTokens(
  http: IgHttp,
  cur: { igToken?: string; fbToken?: string; appToken?: string; appId?: string; appSecret?: string },
  meta: TokenMeta,
  now = new Date(),
): Promise<{ meta: TokenMeta; igToken?: string; fbToken?: string; warnings: string[]; log: string[] }> {
  const warnings: string[] = [];
  const log: string[] = [];
  const next: TokenMeta = { ...meta, checkedAt: now.toISOString() };
  let igToken = meta.igToken || cur.igToken;
  if (igToken && igNeedsRefresh(next, now)) {
    try {
      const r = await refreshIgToken(http, igToken, now);
      igToken = r.token;
      Object.assign(next, { igToken: r.token, igRefreshedAt: now.toISOString(), igExpiresAt: r.expiresAt });
      log.push(`Token do Instagram renovado (vale até ${r.expiresAt.slice(0, 10)}).`);
    } catch (e) {
      warnings.push((e as Error).message);
    }
  }
  if (next.igExpiresAt && new Date(next.igExpiresAt).getTime() - now.getTime() < 3 * DAY) warnings.push(`O token do Instagram vence em ${next.igExpiresAt.slice(0, 10)} e não renovou: gere outro.`);
  if (cur.fbToken && cur.appToken) {
    try {
      const exp = await fbDataExpiry(http, cur.fbToken, cur.appToken);
      if (exp) next.fbDataExpiresAt = exp;
    } catch {
      /* sem conferência hoje */
    }
  }
  let fbToken: string | undefined;
  if (next.fbDataExpiresAt) {
    let days = Math.floor((new Date(next.fbDataExpiresAt).getTime() - now.getTime()) / DAY);
    // faltando 15 dias: renova pela requisição oficial; se a Meta der data nova, fica o token novo
    if (days < 15 && cur.fbToken && cur.appId && cur.appSecret && cur.appToken) {
      try {
        const nt = await refreshFbToken(http, cur.fbToken, cur.appId, cur.appSecret);
        const exp = await fbDataExpiry(http, nt, cur.appToken);
        if (exp && exp > next.fbDataExpiresAt) {
          fbToken = nt;
          next.fbDataExpiresAt = exp;
          days = Math.floor((new Date(exp).getTime() - now.getTime()) / DAY);
          log.push(`Token do Facebook renovado (acesso até ${exp.slice(0, 10)}).`);
        }
      } catch (e) {
        warnings.push((e as Error).message);
      }
    }
    if (days < 15) warnings.push(`O acesso do token do Facebook (o que posta os Reels) vence em ${days} dia(s) (${next.fbDataExpiresAt.slice(0, 10)}) e a renovação automática não estendeu: gere outro no Explorador da Graph API.`);
  }
  return { meta: next, igToken, fbToken, warnings, log };
}
