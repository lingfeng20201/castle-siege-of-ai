import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';

/**
 * app/settings/layout.tsx —— 设置中心布局（服务端会话守卫）
 *
 * 未登录直接 redirect 到 /login，避免设置页出现「先渲染后跳转」的闪现。
 * 子页面（models / usage）均为客户端组件，通过 /api/* 读取自己的数据
 * （服务端 API 本身也有 JWT 校验，双保险）。
 */

export const dynamic = 'force-dynamic';

export const metadata = {
  title: '指挥中心设置 · AI攻防战：城堡围攻',
};

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');

  return (
    <div className="mx-auto min-h-screen w-full max-w-6xl px-4 pb-20 pt-6">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-4">
        <div className="flex items-center gap-3">
          <Link href="/" className="btn-ghost">
            ← 返回大厅
          </Link>
          <h1 className="font-display text-lg text-gold">指挥中心设置</h1>
        </div>

        <nav className="flex flex-wrap items-center gap-2">
          <span className="chip border-ok/40 text-ok">⛨ {session.username}</span>
          <Link href="/settings/models" className="btn-blue">
            ⚙ 模型配置
          </Link>
          <Link href="/settings/usage" className="btn-ghost">
            📊 用量统计
          </Link>
        </nav>
      </header>

      {children}

      <footer className="mt-10 border-t border-white/10 pt-4 text-[11px] leading-relaxed text-fog/70">
        API Key 使用 AES-256-GCM 加密存储，前端永远拿不到明文，仅回显尾号。
        请在受信任的设备上配置；如怀疑泄露，请立即到对应平台吊销并重新填写。
      </footer>
    </div>
  );
}
