import type { Metadata, Viewport } from 'next';
import './globals.css';

/**
 * app/layout.tsx —— 根布局
 *
 * UI 视觉：暗色 + 中世纪 + 赛博朋克（背景 #05070d + 网格 + 星点 + 霓虹）
 */

export const metadata: Metadata = {
  title: 'AI攻防战：城堡围攻 · Castle Siege of AI',
  description:
    '在线多人策略对抗游戏：BYOK 大模型担任你的指挥官。攻防内容全部为抽象化、游戏化标签，胜负只在游戏数值层面结算。',
  applicationName: 'Castle Siege of AI',
  keywords: ['多人在线策略', 'PartyKit', 'Next.js', 'BYOK', '安全演练', '游戏化'],
};

export const viewport: Viewport = {
  themeColor: '#05070d',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="min-h-screen bg-ink text-[#e6f1ff]">
        <div className="starfield" aria-hidden="true" />
        <div className="relative z-10 min-h-screen">{children}</div>
      </body>
    </html>
  );
}
