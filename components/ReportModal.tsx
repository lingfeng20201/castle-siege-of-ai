'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import type { GameMode, GameReport } from '@/lib/protocol';
import { MODE_LABEL, cls, fmtCost, fmtNum } from '@/lib/client/ui';

/**
 * components/ReportModal.tsx —— 战报弹窗（㉑）
 *
 * - 胜者横幅 + 彩带
 * - 胜负原因、回合数
 * - 城堡战力排名（keepHp + outerWallHp + innerWallHp）
 * - AI 裁判总结 + 战报叙事（打字机效果）
 * - 本场消耗（tokens / 预估费用）；「结束每局弹本场消耗卡片」的需求在此实现
 */

export interface ReportModalProps {
  report: GameReport | null;
  meId?: string | null;
  onClose: () => void;
}

const CONFETTI_COLORS = ['#ffd700', '#00f0ff', '#ff3b5c', '#39ff14', '#8b5cf6'];

function useTypewriter(text: string, enabled: boolean, speedMs = 26): string {
  const [out, setOut] = useState('');
  useEffect(() => {
    if (!enabled || !text) {
      setOut(text);
      return;
    }
    setOut('');
    let i = 0;
    const timer = setInterval(() => {
      i += 2;
      setOut(text.slice(0, i));
      if (i >= text.length) clearInterval(timer);
    }, speedMs);
    return () => clearInterval(timer);
  }, [text, enabled, speedMs]);
  return out;
}

export default function ReportModal({ report, meId, onClose }: ReportModalProps) {
  const [showNarrative, setShowNarrative] = useState(false);
  const narrative = report?.narrative ?? '';
  const typed = useTypewriter(narrative, showNarrative);

  const confetti = useMemo(
    () =>
      Array.from({ length: 36 }, (_, i) => ({
        left: `${(i * 2.7 + (i % 5) * 3) % 100}%`,
        delay: `${(i % 9) * 0.18}s`,
        color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
      })),
    [],
  );

  if (!report) return null;

  const iWon = !!meId && report.winner === meId;
  const draw = !report.winner;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 overflow-hidden bg-black/70 backdrop-blur-sm">
        {!draw && (
          <div className="pointer-events-none absolute inset-0">
            {confetti.map((c, i) => (
              <span
                key={i}
                className="confetti-piece"
                style={{ left: c.left, animationDelay: c.delay, background: c.color }}
              />
            ))}
          </div>
        )}
      </div>

      <div className="animate-rise panel-neon relative z-10 flex max-h-[86vh] w-full max-w-2xl flex-col overflow-hidden">
        {/* 头部 */}
        <header className="border-b border-white/10 bg-black/40 px-5 py-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="font-display text-lg text-gold">
                {draw ? '⚖️ 平局' : iWon ? '🏆 你的城堡屹立不倒！' : '💀 战斗结束'}
              </h2>
              <p className="mt-1 text-[11px] text-fog">
                {MODE_LABEL[report.mode as GameMode] ?? report.mode} · 共 {report.turns} 回合 ·{' '}
                {draw ? '未分胜负' : `胜者：${report.winnerName ?? '未知'}`}
              </p>
              <p className="mt-1 text-[11px] text-warn">结算依据：{report.reason}</p>
            </div>
            <button className="btn-ghost text-xs" onClick={onClose}>
              ✕
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
          {/* 排名 */}
          <section>
            <h3 className="mb-2 font-display text-sm text-neon-blue">城堡战力排名</h3>
            <table className="w-full text-left text-[11px]">
              <thead className="text-fog">
                <tr className="border-b border-white/10">
                  <th className="py-1">#</th>
                  <th className="py-1">玩家</th>
                  <th className="py-1 text-right">战力（主堡+外墙+内墙）</th>
                </tr>
              </thead>
              <tbody>
                {report.ranking.map((r, i) => (
                  <tr
                    key={r.id}
                    className={cls(
                      'border-b border-white/5',
                      r.id === meId ? 'bg-gold/5 text-gold' : 'text-[#e6f1ff]',
                    )}
                  >
                    <td className="py-1 font-mono">{i + 1}</td>
                    <td className="py-1">
                      {r.name}
                      {r.id === meId ? '（你）' : ''}
                      {report.winner === r.id ? ' 🏆' : ''}
                    </td>
                    <td className="py-1 text-right font-mono">{fmtNum(r.power)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          {/* 裁判总结 */}
          {report.judgeSummary && (
            <section className="rounded-lg border border-neon-blue/25 bg-neon-blue/5 p-3">
              <h3 className="mb-1 font-display text-xs text-neon-blue">⚖️ 裁判终评</h3>
              <p className="text-[12px] leading-relaxed text-[#e6f1ff]">{report.judgeSummary}</p>
            </section>
          )}

          {/* 战报叙事 */}
          {narrative && (
            <section className="rounded-lg border border-white/10 bg-black/30 p-3">
              <div className="mb-1 flex items-center justify-between">
                <h3 className="font-display text-xs text-gold">📜 战报叙事</h3>
                {!showNarrative && (
                  <button className="btn-ghost px-2 py-0.5 text-[10px]" onClick={() => setShowNarrative(true)}>
                    ▶ 播放
                  </button>
                )}
              </div>
              <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-[#e6f1ff]">
                {showNarrative ? typed : `${narrative.slice(0, 120)}…`}
              </p>
            </section>
          )}

          {/* 本场消耗 */}
          <section className="rounded-lg border border-white/10 bg-black/30 p-3">
            <h3 className="mb-1 font-display text-xs text-warn">💰 本场消耗</h3>
            {report.usage ? (
              <div className="flex flex-wrap gap-4 text-[11px] text-[#e6f1ff]">
                <span>
                  总 tokens：<span className="font-mono text-neon-blue">{fmtNum(report.usage.totalTokens)}</span>
                </span>
                <span>
                  预估费用：<span className="font-mono text-gold">{fmtCost(report.usage.cost)}</span>
                </span>
              </div>
            ) : (
              <p className="text-[11px] text-fog">
                详细用量已写入「用量统计」页（含指挥官决策 / 裁判点评 / 战报叙事三类调用）。
              </p>
            )}
          </section>

          <p className="text-[10px] leading-relaxed text-fog/80">
            ⚠️ 本局所有攻防均为抽象化游戏数值结算，用于安全概念的教学演练，不包含任何真实攻击技术内容。
          </p>
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-white/10 bg-black/30 px-5 py-3">
          <Link className="btn-ghost text-xs" href="/">
            ← 返回大厅
          </Link>
          <button className="btn-blue text-xs" onClick={onClose}>
            查看战场
          </button>
        </footer>
      </div>
    </div>
  );
}