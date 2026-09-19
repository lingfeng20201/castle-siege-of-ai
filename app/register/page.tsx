'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { cls } from '@/lib/client/ui';

/**
 * app/register/page.tsx —— 注册页（模块一 · 账号注册）
 *
 * 流程：
 *   1. 填写 用户名 / QQ 邮箱 / 密码 / 确认密码
 *   2. 点「发送验证码」→ POST /api/auth/send-code（服务端 60s 冷却、邮箱 1h ≤5、IP 1h ≤10）
 *   3. 填入 6 位验证码 → POST /api/auth/register
 *   4. 成功 → 「骑士加冕」动画 → 跳转大厅
 *
 * 安全：本地校验规则与 lib/auth.ts 完全一致（最终仍以服务端为准）；
 *      服务端错误一律模糊提示（防邮箱枚举），前端只做展示。
 */

const USERNAME_RE = /^[A-Za-z0-9]{3,20}$/;
const EMAIL_RE = /^[1-9][0-9]{4,10}@(qq|foxmail)\.com$/i;
const CODE_RE = /^[0-9]{6}$/;

function passwordIssue(pw: string): string | null {
  if (pw.length === 0) return '请设置密码';
  if (pw.length < 8 || pw.length > 32) return '密码需 8-32 位';
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return '密码需同时包含字母和数字';
  return null;
}

export default function RegisterPage() {
  const router = useRouter();

  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [code, setCode] = useState('');

  const [showPw, setShowPw] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [sending, setSending] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [crown, setCrown] = useState(false);

  /* ── 「发送验证码」60 秒倒计时 ── */
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = window.setInterval(() => {
      setCooldown((c) => (c <= 1 ? 0 : c - 1));
    }, 1000);
    return () => window.clearInterval(t);
  }, [cooldown]);

  const checks = useMemo(
    () => ({
      username: USERNAME_RE.test(username),
      email: EMAIL_RE.test(email.trim()),
      password: passwordIssue(password) === null,
      confirm: confirm.length > 0 && confirm === password,
      code: CODE_RE.test(code),
    }),
    [username, email, password, confirm, code],
  );

  const pwIssue = password.length > 0 ? passwordIssue(password) : null;
  const valid = Object.values(checks).every(Boolean);

  /* ── 发送邮箱验证码 ── */
  async function sendCode() {
    if (cooldown > 0 || sending) return;
    if (!checks.email) {
      setToast({ kind: 'err', text: '请输入正确的 QQ / Foxmail 邮箱' });
      return;
    }
    setSending(true);
    try {
      const r = await fetch('/api/auth/send-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
      });
      const d = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        cooldown?: number;
        retryAfter?: number;
        message?: string;
        devCode?: string;
      };
      if (r.ok && d.ok) {
        setCooldown(typeof d.cooldown === 'number' ? d.cooldown : 60);
        if (d.devCode) {
          // 本地开发模式：未配置邮箱服务，验证码直接由接口返回，自动填入并提示
          setCode(d.devCode);
          setToast({
            kind: 'ok',
            text: `本地开发模式：验证码 ${d.devCode} 已自动填入（未真实发送邮件）`,
          });
        } else {
          setToast({ kind: 'ok', text: '验证码已发送，请查收 QQ 邮箱（若未见请检查垃圾箱）' });
        }
      } else {
        setToast({ kind: 'err', text: d.message || '验证码发送失败，请稍后重试' });
        if (typeof d.retryAfter === 'number' && d.retryAfter > 0 && d.retryAfter <= 60) {
          setCooldown(d.retryAfter);
        }
      }
    } catch {
      setToast({ kind: 'err', text: '网络异常，请稍后重试' });
    } finally {
      setSending(false);
    }
  }

  /* ── 提交注册 ── */
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || submitting) return;
    setSubmitting(true);
    setToast(null);
    try {
      const r = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username,
          email: email.trim().toLowerCase(),
          password,
          confirm,
          code,
        }),
      });
      const d = (await r.json().catch(() => ({}))) as { ok?: boolean; message?: string; code?: string };
      if (r.ok && d.ok) {
        setCrown(true);
        window.setTimeout(() => {
          router.replace('/');
          router.refresh();
        }, 1800);
        return;
      }
      setToast({ kind: 'err', text: d.message || '注册失败，请稍后重试' });
      if (d.code === 'CODE_WRONG') setCode('');
      if (d.code === 'CODE_EXPIRED' || d.code === 'CODE_LOCKED') {
        setCode('');
        setCooldown(0);
      }
    } catch {
      setToast({ kind: 'err', text: '网络异常，请稍后重试' });
    } finally {
      setSubmitting(false);
    }
  }

  /* ── 加冕动画 ── */
  if (crown) {
    return (
      <main className="grid min-h-screen place-items-center px-4">
        <div className="animate-crown flex flex-col items-center gap-4 text-center">
          <div className="text-6xl drop-shadow-[0_0_24px_rgba(255,215,0,0.5)]">👑</div>
          <h1 className="font-display text-2xl text-gold">骑士加冕</h1>
          <p className="text-sm text-fog">
            指挥官 <span className="text-ok">{username}</span>，你的城堡已就位，正在前往大厅…
          </p>
          <div className="chip border-gold/40 text-gold animate-csai-pulse">加载战场中…</div>
        </div>
      </main>
    );
  }

  return (
    <main className="grid min-h-screen place-items-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <Link href="/login" className="font-display text-xl text-neon-blue">
            ⚔ AI攻防战：城堡围攻
          </Link>
          <p className="mt-1 text-xs text-fog">注册指挥官 · 让你的大模型替你打下第一座城</p>
        </div>

        <form onSubmit={submit} className="panel-neon animate-rise space-y-4 p-6">
          <h1 className="font-display text-lg text-gold">创建指挥官</h1>

          {toast && (
            <div
              className={cls(
                'animate-rise rounded-lg border px-3 py-2 text-xs',
                toast.kind === 'ok'
                  ? 'border-ok/40 bg-ok/10 text-ok'
                  : 'border-neon-red/40 bg-neon-red/10 text-neon-red',
              )}
            >
              {toast.text}
            </div>
          )}

          {/* 用户名 */}
          <div>
            <label className="label" htmlFor="username">
              用户名（3-20 位字母或数字，注册后不可更改）
            </label>
            <div className="relative">
              <input
                id="username"
                className="field pr-9 font-mono"
                value={username}
                onChange={(e) => setUsername(e.target.value.replace(/[^A-Za-z0-9]/g, '').slice(0, 20))}
                placeholder="Commander01"
                autoComplete="username"
                required
              />
              {username.length > 0 && (
                <span
                  className={cls(
                    'pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs',
                    checks.username ? 'text-ok' : 'text-neon-red',
                  )}
                >
                  {checks.username ? '✓' : '✗'}
                </span>
              )}
            </div>
          </div>

          {/* 邮箱 + 发送验证码 */}
          <div>
            <label className="label" htmlFor="email">
              QQ / Foxmail 邮箱（用于接收验证码）
            </label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <input
                  id="email"
                  className="field pr-9 font-mono"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="123456789@qq.com"
                  autoComplete="email"
                  inputMode="email"
                  required
                />
                {email.length > 0 && (
                  <span
                    className={cls(
                      'pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs',
                      checks.email ? 'text-ok' : 'text-neon-red',
                    )}
                  >
                    {checks.email ? '✓' : '✗'}
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={sendCode}
                disabled={cooldown > 0 || sending || !checks.email}
                className="btn-gold shrink-0 whitespace-nowrap"
              >
                {cooldown > 0 ? `${cooldown}s 后重发` : sending ? '发送中…' : '发送验证码'}
              </button>
            </div>
          </div>

          {/* 密码 */}
          <div>
            <label className="label" htmlFor="password">
              密码（8-32 位，需含字母和数字）
            </label>
            <div className="relative">
              <input
                id="password"
                type={showPw ? 'text' : 'password'}
                className="field pr-14"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete="new-password"
                required
              />
              <button
                type="button"
                onClick={() => setShowPw((s) => !s)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-[11px] text-fog hover:text-neon-blue"
              >
                {showPw ? '隐藏' : '显示'}
              </button>
            </div>
            {pwIssue && <p className="mt-1 text-[11px] text-neon-red">{pwIssue}</p>}
          </div>

          {/* 确认密码 */}
          <div>
            <label className="label" htmlFor="confirm">
              确认密码
            </label>
            <input
              id="confirm"
              type={showPw ? 'text' : 'password'}
              className="field"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="再次输入密码"
              autoComplete="new-password"
              required
            />
            {confirm.length > 0 && !checks.confirm && (
              <p className="mt-1 text-[11px] text-neon-red">两次输入的密码不一致</p>
            )}
          </div>

          {/* 6 位分格验证码 */}
          <div>
            <label className="label">邮箱验证码（5 分钟内有效，错误 5 次将锁定 15 分钟）</label>
            <div className="relative">
              <div className="flex justify-between gap-2">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div
                    key={i}
                    className={cls(
                      'grid h-12 flex-1 place-items-center rounded-lg border font-mono text-lg transition-colors',
                      code[i]
                        ? 'border-neon-blue/60 bg-neon-blue/5 text-neon-blue'
                        : 'border-white/10 bg-black/40 text-fog/40',
                    )}
                  >
                    {code[i] ?? ''}
                  </div>
                ))}
              </div>
              <input
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                inputMode="numeric"
                autoComplete="one-time-code"
                aria-label="邮箱验证码"
                className="absolute inset-0 h-full w-full cursor-text rounded-lg bg-transparent text-transparent outline-none"
                style={{ caretColor: 'transparent' }}
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={!valid || submitting}
            className="btn-blue w-full py-2.5 font-display"
          >
            {submitting ? '正在铸造城塞…' : '完成注册 · 入驻城堡'}
          </button>

          <ul className="space-y-1 pt-1">
            <Rule ok={checks.username} text="用户名 3-20 位字母或数字" />
            <Rule ok={checks.email} text="QQ / Foxmail 邮箱格式正确" />
            <Rule ok={checks.password} text="密码 8-32 位且同时包含字母与数字" />
            <Rule ok={checks.confirm} text="两次密码一致" />
            <Rule ok={checks.code} text="已填写 6 位验证码" />
          </ul>

          <p className="border-t border-white/10 pt-3 text-center text-xs text-fog">
            已有指挥官账号？
            <Link href="/login" className="ml-1 text-neon-blue underline">
              直接登录
            </Link>
          </p>
        </form>

        <p className="mt-4 text-center text-[11px] leading-relaxed text-fog/60">
          本作所有「攻击牌」均为安全概念的抽象化、游戏化标签，胜负只在游戏数值层面结算，
          不包含任何可执行攻击代码或真实漏洞利用步骤。
        </p>
      </div>
    </main>
  );
}

/** 单条校验规则展示（绿✓ / 灰·） */
function Rule({ ok, text }: { ok: boolean; text: string }) {
  return (
    <li className={cls('flex items-center gap-2 text-[11px]', ok ? 'text-ok' : 'text-fog/70')}>
      <span className="w-3 text-center">{ok ? '✓' : '·'}</span>
      {text}
    </li>
  );
}
