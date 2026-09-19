import crypto from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  CODE_RE,
  EMAIL_RE,
  USERNAME_RE,
  assertSameOrigin,
  hashEmailCode,
  hashPassword,
  passwordIssue,
  sessionCookieOptions,
  signSession,
} from '@/lib/auth';
import { query } from '@/lib/db';
import { redis } from '@/lib/redis';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

/**
 * POST /api/auth/register
 * 校验验证码 → 创建用户 → JWT httpOnly Cookie。
 *
 * 安全：
 * - 验证码错 5 次作废 + 同邮箱 15 分钟锁定
 * - 邮箱枚举防护：邮箱冲突统一模糊提示
 * - 校验成功立即删除验证码
 */

const Body = z.object({
  username: z.string().regex(USERNAME_RE, '用户名需 3-20 位字母或数字'),
  password: z.string(),
  confirm: z.string().optional(),
  email: z.string().trim().toLowerCase().regex(EMAIL_RE, '请输入正确的 QQ/Foxmail 邮箱'),
  code: z.string().regex(CODE_RE, '验证码为 6 位数字'),
});

const FUZZY_REGISTER_FAIL = { code: 'REGISTER_FAILED', message: '注册信息校验未通过，请修改后重试' };

type UserRow = { id: string; username: string; email: string };

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

  if (body.confirm !== undefined && body.confirm !== body.password) {
    return NextResponse.json({ code: 'INVALID_INPUT', message: '两次输入的密码不一致' }, { status: 400 });
  }
  const pwIssue = passwordIssue(body.password);
  if (pwIssue) return NextResponse.json({ code: 'INVALID_INPUT', message: pwIssue }, { status: 400 });

  const email = body.email;
  const r = redis();

  // ── 锁定检查 ──
  const lockKey = `elock:${email}`;
  if (await r.get(lockKey)) {
    return NextResponse.json({ code: 'CODE_LOCKED', message: '验证码错误次数过多，请 15 分钟后再试' }, { status: 400 });
  }

  // ── 验证码校验：Redis 优先，DB 兜底 ──
  let rec: { hash: string; attempts: number } | null = null;
  const stored = await r.get(`ecode:${email}`);
  if (stored) {
    try {
      rec = JSON.parse(stored) as { hash: string; attempts: number };
    } catch {
      rec = null;
    }
  }
  if (!rec) {
    const rows = await query<{ code_hash: string; attempts: number }>(
      'SELECT code_hash, attempts FROM email_codes WHERE email = $1 AND expires_at > now()',
      [email],
    );
    if (rows.length > 0) rec = { hash: rows[0].code_hash, attempts: rows[0].attempts };
  }
  if (!rec) {
    return NextResponse.json({ code: 'CODE_EXPIRED', message: '验证码已失效，请重新获取' }, { status: 400 });
  }

  if (hashEmailCode(email, body.code) !== rec.hash) {
    const attempts = rec.attempts + 1;
    if (attempts >= 5) {
      await r.del(`ecode:${email}`);
      await r.set(lockKey, '1', 'EX', 900);
      await query('DELETE FROM email_codes WHERE email = $1', [email]);
      return NextResponse.json({ code: 'CODE_LOCKED', message: '验证码错误次数过多，请 15 分钟后再试' }, { status: 400 });
    }
    const ttl = await r.ttl(`ecode:${email}`);
    await r.set(`ecode:${email}`, JSON.stringify({ hash: rec.hash, attempts }), 'EX', Math.max(ttl, 1));
    await query('UPDATE email_codes SET attempts = $2 WHERE email = $1', [email, attempts]);
    return NextResponse.json({ code: 'CODE_WRONG', message: '验证码错误' }, { status: 400 });
  }

  // ── 校验通过：立即作废验证码 ──
  await r.del(`ecode:${email}`);
  await query('DELETE FROM email_codes WHERE email = $1', [email]);

  // ── 邮箱占用（防枚举：统一模糊提示） ──
  const emailTaken = await query<{ id: string }>('SELECT id FROM users WHERE email = $1 LIMIT 1', [email]);
  if (emailTaken.length > 0) return NextResponse.json(FUZZY_REGISTER_FAIL, { status: 400 });

  // ── 用户名占用（用户名本身是公开标识） ──
  const nameTaken = await query<{ id: string }>('SELECT id FROM users WHERE username = $1 LIMIT 1', [body.username]);
  if (nameTaken.length > 0) {
    return NextResponse.json({ code: 'USERNAME_TAKEN', message: '用户名已被使用' }, { status: 409 });
  }

  // ── 创建用户 ──
  const passwordHash = await hashPassword(body.password);
  const avatarSeed = crypto.randomBytes(8).toString('hex');

  let user: UserRow | null = null;
  try {
    const rows = await query<UserRow>(
      `INSERT INTO users (username, email, password_hash, avatar_seed, last_login_at)
       VALUES ($1, $2, $3, $4, now())
       RETURNING id, username, email`,
      [body.username, email, passwordHash, avatarSeed],
    );
    user = rows[0] ?? null;
  } catch (e) {
    const msg = String(e);
    if (msg.includes('users_username_key')) {
      return NextResponse.json({ code: 'USERNAME_TAKEN', message: '用户名已被使用' }, { status: 409 });
    }
    if (msg.includes('users_email_key')) {
      return NextResponse.json(FUZZY_REGISTER_FAIL, { status: 400 });
    }
    logger.error('register: insert failed', { message: msg });
    return NextResponse.json({ code: 'SERVER_ERROR', message: '注册失败，请稍后重试' }, { status: 500 });
  }

  if (!user) {
    return NextResponse.json({ code: 'SERVER_ERROR', message: '注册失败，请稍后重试' }, { status: 500 });
  }

  // ── 签发会话 ──
  const token = await signSession({ uid: user.id, username: user.username });
  const res = NextResponse.json({
    ok: true,
    user: { id: user.id, username: user.username, email: user.email },
  });
  res.cookies.set({ ...sessionCookieOptions(), value: token });
  return res;
}