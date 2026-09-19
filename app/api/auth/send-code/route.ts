import crypto from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import nodemailer, { type Transporter } from 'nodemailer';
import { z } from 'zod';
import { EMAIL_RE, assertSameOrigin, hashEmailCode } from '@/lib/auth';
import { query } from '@/lib/db';
import { redis } from '@/lib/redis';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

/**
 * POST /api/auth/send-code
 * 发送注册邮箱验证码。
 *
 * 限流：同邮箱 60 秒 1 次、每小时 ≤5；同 IP 每小时 ≤10；超限 429。
 * 验证码：6 位数字，HMAC-SHA256 哈希存 Redis（TTL 300s）+ 双写 DB 兜底。
 */

const Body = z.object({
  email: z.string().trim().toLowerCase().regex(EMAIL_RE, '请输入正确的 QQ/Foxmail 邮箱'),
});

let mailer: Transporter | null = null;

function getMailer(): Transporter {
  const user = process.env.QQ_SMTP_USER;
  const pass = process.env.QQ_SMTP_CODE;
  if (!user || !pass) throw new Error('QQ_SMTP_USER / QQ_SMTP_CODE 未配置');
  if (!mailer) {
    mailer = nodemailer.createTransport({
      host: 'smtp.qq.com',
      port: 465,
      secure: true,
      auth: { user, pass },
    });
  }
  return mailer;
}

function clientIp(req: NextRequest): string {
  return (
    req.headers.get('cf-connecting-ip') ||
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    '0.0.0.0'
  );
}

function mailHtml(code: string): string {
  return `<div style="background:#05070d;color:#e6f1ff;font-family:sans-serif;padding:32px;border-radius:12px;max-width:520px;margin:0 auto">
  <h2 style="color:#00f0ff;margin:0 0 8px">城堡围攻 · 指挥部</h2>
  <p style="color:#8aa0b8;margin:0 0 24px">你正在注册《AI攻防战：城堡围攻》，验证码 5 分钟内有效：</p>
  <div style="font-size:32px;letter-spacing:8px;font-family:monospace;color:#ffd700;background:rgba(255,215,0,.08);border:1px solid rgba(255,215,0,.3);padding:16px 24px;border-radius:8px;text-align:center">${code}</div>
  <p style="color:#8aa0b8;font-size:12px;margin-top:24px">如非本人操作，请忽略本邮件。</p>
</div>`;
}

export async function POST(req: NextRequest) {
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ code: 'CSRF', message: '请求被拒绝' }, { status: 403 });
  }

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch {
    return NextResponse.json({ code: 'INVALID_EMAIL', message: '请输入正确的 QQ/Foxmail 邮箱' }, { status: 400 });
  }
  const email = body.email;
  const ip = clientIp(req);
  const r = redis();

  // ── 限流：同邮箱每小时 ≤5 ──
  const hourKey = `rl:code:hour:${email}`;
  const hourCount = await r.incr(hourKey);
  if (hourCount === 1) await r.expire(hourKey, 3600);
  if (hourCount > 5) {
    return NextResponse.json({ code: 'RATE_LIMITED', message: '发送过于频繁，请稍后再试', retryAfter: 3600 }, { status: 429 });
  }

  // ── 限流：同 IP 每小时 ≤10 ──
  const ipKey = `rl:code:ip:${ip}`;
  const ipCount = await r.incr(ipKey);
  if (ipCount === 1) await r.expire(ipKey, 3600);
  if (ipCount > 10) {
    return NextResponse.json({ code: 'RATE_LIMITED', message: '发送过于频繁，请稍后再试', retryAfter: 3600 }, { status: 429 });
  }

  // ── 限流：同邮箱 60 秒 1 次（冷却） ──
  const cooldownKey = `rl:code:cooldown:${email}`;
  const okCooldown = await r.set(cooldownKey, '1', 'EX', 60, 'NX');
  if (!okCooldown) {
    const ttl = Math.max(await r.ttl(cooldownKey), 1);
    return NextResponse.json(
      { code: 'RATE_LIMITED', message: `操作过于频繁，请 ${ttl} 秒后重试`, retryAfter: ttl },
      { status: 429 },
    );
  }

  // ── 防枚举：邮箱已注册时同样返回成功（不发送、不提示） ──
  const existing = await query<{ id: string }>('SELECT id FROM users WHERE email = $1 LIMIT 1', [email]);
  if (existing.length > 0) {
    logger.info('send-code: email already registered, skip silently');
    return NextResponse.json({ ok: true, cooldown: 60 });
  }

  // ── 生成验证码：哈希存 Redis（TTL 300s）+ 双写 DB 兜底 ──
  const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
  const codeHash = hashEmailCode(email, code);

  await r.set(`ecode:${email}`, JSON.stringify({ hash: codeHash, attempts: 0 }), 'EX', 300);
  await query(
    `INSERT INTO email_codes (email, code_hash, expires_at, attempts, created_at)
     VALUES ($1, $2, now() + interval '300 seconds', 0, now())
     ON CONFLICT (email) DO UPDATE
       SET code_hash = EXCLUDED.code_hash,
           expires_at = EXCLUDED.expires_at,
           attempts = 0,
           created_at = now()`,
    [email, codeHash],
  );

  // ── 发送邮件 ──
  // 本地/演示模式：未配置 QQ SMTP 且 MAIL_DEV_LOG=true 时，不发信，直接把验证码
  // 输出到服务端日志并随响应返回，方便在没有邮箱服务的情况下跑通注册闭环。
  // 注意：必须同时满足 NODE_ENV !== 'production'，生产环境即使误设该变量也不会生效。
  const smtpReady = Boolean(process.env.QQ_SMTP_USER && process.env.QQ_SMTP_CODE);
  const devLog = process.env.MAIL_DEV_LOG === 'true' && process.env.NODE_ENV !== 'production';

  if (!smtpReady && devLog) {
    logger.warn('send-code: SMTP 未配置，本地开发模式直接返回验证码');
    console.log(`\n[DEV-MAIL] 注册验证码 ${email} → ${code}（5 分钟内有效）\n`);
    return NextResponse.json({
      ok: true,
      cooldown: 60,
      devCode: code,
      devNote: '本地开发模式：未配置 QQ_SMTP_*，验证码直接返回，请勿在公网开启',
    });
  }

  try {
    await getMailer().sendMail({
      from: `"城堡围攻指挥部" <${process.env.QQ_SMTP_USER}>`,
      to: email,
      subject: `【AI攻防战：城堡围攻】注册验证码 ${code}`,
      html: mailHtml(code),
    });
  } catch (e) {
    logger.error('send-code: SMTP failed', { message: (e as Error).message });
    return NextResponse.json({ code: 'SMTP_FAILED', message: '验证码发送失败，请稍后重试' }, { status: 502 });
  }

  return NextResponse.json({ ok: true, cooldown: 60 });
}