'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { cls } from '@/lib/client/ui';

/**
 * app/login/page.tsx —— 登录页（模块一）
 *
 * 支持「用户名或邮箱」+ 密码登录：POST /api/auth/login
 * 服务端限流：同 IP 15 分钟 ≤30 次、同账号 15 分钟 ≤10 次；失败统一模糊提示。
 */

export default function LoginPage() {
  const router = useRouter();

  const [ident, setIdent] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = ident.trim().length >= 3 && password.length >= 1 && !submitting;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const r = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: ident.trim(), password }),
      });
      const d = (await r.json().catch(() => ({}))) as { ok?: boolean; message?: string };
      if (r.ok && d.ok) {
        router.replace('/');
        router.refresh();
        return;
      }
      setError(d.message || '登录失败，请稍后重试');
    } catch {
      setError('网络异常，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <Link href="/" className="font-display text-xl text-neon-blue">
            ⚔ AI攻防战：城堡围攻
          </Link>
          <p className="mt-1 text-xs text-fog">服务端权威 · BYOK 大模型指挥官 · 实时多人对抗</p>
        </div>

        <form onSubmit={submit} className="panel-neon animate-rise space-y-4 p-6">
          <h1 className="font-display text-lg text-gold">指挥官登录</h1>

          {error && (
            <div className="animate-rise rounded-lg border border-neon-red/40 bg-neon-red/10 px-3 py-2 text-xs text-neon-red">
              {error}
            </div>
          )}

          <div>
            <label className="label" htmlFor="ident">
              用户名或邮箱
            </label>
            <input
              id="ident"
              className="field font-mono"
              value={ident}
              onChange={(e) => setIdent(e.target.value)}
              placeholder="Commander01 / 123456789@qq.com"
              autoComplete="username"
              required
            />
          </div>

          <div>
            <label className="label" htmlFor="password">
              密码
            </label>
            <div className="relative">
              <input
                id="password"
                type={showPw ? 'text' : 'password'}
                className="field pr-14"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete="current-password"
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
          </div>

          <button type="submit" disabled={!canSubmit} className="btn-blue w-full py-2.5 font-display">
            {submitting ? '正在进入指挥中心…' : '进入指挥中心'}
          </button>

          <p className="border-t border-white/10 pt-3 text-center text-xs text-fog">
            还没有账号？
            <Link href="/register" className="ml-1 text-neon-blue underline">
              注册指挥官
            </Link>
          </p>
        </form>

        <p className="mt-4 text-center text-[11px] leading-relaxed text-fog/60">
          连续多次失败会触发限流保护；忘记密码请联系管理员重置（本项目暂未提供自助找回）。
        </p>
      </div>
    </main>
  );
}
