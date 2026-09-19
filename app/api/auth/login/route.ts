import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { assertSameOrigin, sessionCookieOptions, signSession, verifyPassword } from '@/lib/auth';
import { query } from '@/lib/db';
import { redis } from '@/lib/redis';

export const runtime = 'nodejs';

/**
 * POST /api/auth/login
 * 支持「用户名或邮箱」+ 密码登录；限流：IP 15 分钟 ≤30、账号 15 分钟 ≤10。
 * 失败统一模糊提示（防枚举）。
 */

const Body = z.object({
  username: z.string().trim().min(3, '请输入用户名或邮箱').max(64),
  password: z.string().min(1, '请输入密码').max(128),
});

const FAIL = { code: 'LOGIN_FAILED', message: '用户名或密码错误' };

function clientIp(req: NextRequest): string {
  return (
    req.headers.get('cf-connecting-ip') ||
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    '0.0.0.0'
  );
}

export async function POST(req: NextRequest) {
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ code: 'CSRF', message: '请求被拒绝' }, { status: 403 });
  }

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (e) {
    const msg = e instanceof z.ZodError ? e.issues[0]?.message : '参数不合法';
    return NextResponse.json({ code: 'INVALID_INPUT', message: msg }, { status: 400 });
  }

  const ident = body.username;
  const ip = clientIp(req);
  const r = redis();

  const ipKey = `rl:login:ip:${ip}`;
  const ipCount = await r.incr(ipKey);
  if (ipCount === 1) await r.expire(ipKey, 900);
  if (ipCount > 30) {
    return NextResponse.json({ code: 'RATE_LIMITED', message: '尝试过于频繁，请 15 分钟后再试' }, { status: 429 });
  }

  const accKey = `rl:login:acc:${ident.toLowerCase()}`;
  const accCount = await r.incr(accKey);
  if (accCount === 1) await r.expire(accKey, 900);
  if (accCount > 10) {
    return NextResponse.json({ code: 'RATE_LIMITED', message: '尝试过于频繁，请 15 分钟后再试' }, { status: 429 });
  }

  type Row = { id: string; username: string; email: string; password_hash: string };
  const rows = await query<Row>(
    'SELECT id, username, email, password_hash FROM users WHERE username = $1 OR email = $2 LIMIT 1',
    [ident, ident.toLowerCase()],
  );
  if (rows.length === 0) return NextResponse.json(FAIL, { status: 401 });

  const user = rows[0];
  const ok = await verifyPassword(user.password_hash, body.password);
  if (!ok) return NextResponse.json(FAIL, { status: 401 });

  await query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);

  const token = await signSession({ uid: user.id, username: user.username });
  const res = NextResponse.json({
    ok: true,
    user: { id: user.id, username: user.username, email: user.email },
  });
  res.cookies.set({ ...sessionCookieOptions(), value: token });
  return res;
}