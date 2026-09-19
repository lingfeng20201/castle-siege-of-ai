import { createHmac } from 'node:crypto';
import argon2 from 'argon2';
import { SignJWT, jwtVerify } from 'jose';
import { cookies } from 'next/headers';
import type { NextRequest } from 'next/server';

/**
 * lib/auth.ts —— 校验规则 + argon2id + JWT(httpOnly Cookie) + CSRF 同源校验
 */

export const USERNAME_RE = /^[A-Za-z0-9]{3,20}$/;
export const EMAIL_RE = /^[1-9][0-9]{4,10}@(qq|foxmail)\.com$/i;
export const CODE_RE = /^[0-9]{6}$/;
export const SESSION_COOKIE = 'csai_session';

export interface Session {
  uid: string;
  username: string;
}

/* ── 字段校验 ── */

export function passwordIssue(pw: string): string | null {
  if (pw.length < 8 || pw.length > 32) return '密码需 8-32 位';
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return '密码需同时包含字母和数字';
  return null;
}

/* ── 密码哈希（argon2id） ── */

export async function hashPassword(pw: string): Promise<string> {
  return argon2.hash(pw, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string, pw: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, pw);
  } catch {
    return false;
  }
}

/* ── JWT ── */

function jwtKey(): Uint8Array {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 16) throw new Error('JWT_SECRET 未配置或过短（≥16 字符）');
  return new TextEncoder().encode(s);
}

export async function signSession(session: Session): Promise<string> {
  return new SignJWT({ uid: session.uid, username: session.username })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(jwtKey());
}

export async function verifySessionToken(token: string): Promise<Session | null> {
  try {
    const { payload } = await jwtVerify(token, jwtKey());
    if (typeof payload.uid !== 'string' || typeof payload.username !== 'string') return null;
    return { uid: payload.uid, username: payload.username };
  } catch {
    return null;
  }
}

export function sessionCookieOptions(maxAge = 7 * 24 * 3600) {
  return {
    name: SESSION_COOKIE,
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge,
  };
}

export async function getSessionFromRequest(req: NextRequest): Promise<Session | null> {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  return token ? verifySessionToken(token) : null;
}

/** 服务端组件 / Route Handler 中读取当前会话 */
export async function getSession(): Promise<Session | null> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  return token ? verifySessionToken(token) : null;
}

/**
 * 简单可用的 CSRF 防护：
 * 浏览器跨站请求（Sec-Fetch-Site: cross-site / Origin 与 Host 不一致）一律拒绝。
 */
export function assertSameOrigin(req: NextRequest): boolean {
  const site = req.headers.get('sec-fetch-site');
  if (site === 'cross-site') return false;
  const origin = req.headers.get('origin');
  if (origin) {
    try {
      const o = new URL(origin);
      const host = req.headers.get('host');
      if (host && o.host !== host) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/* ── 邮箱验证码哈希（HMAC-SHA256，等价“SHA-256 加盐”存储） ── */

export function hashEmailCode(email: string, code: string): string {
  const pepper = process.env.CODE_PEPPER || process.env.JWT_SECRET || 'dev-only-pepper';
  return createHmac('sha256', pepper).update(`${email.toLowerCase()}:${code}`).digest('hex');
}