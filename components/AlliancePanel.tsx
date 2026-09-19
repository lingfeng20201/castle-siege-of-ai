'use client';

import type { AllianceLink, PlayerState } from '@/lib/protocol';
import { cls, playerColor, TEAM_LABEL } from '@/lib/client/ui';

/**
 * components/AlliancePanel.tsx —— 结盟面板（⑳）
 *
 * 规则（与服务端 party/battle.ts 对齐）：
 * - 混战模式中可向任意玩家发出结盟请求；对方点击「接受」后建立同盟
 * - 同盟持续 3 回合（untilTurn = 当前回合 + 3），期间双方不能互攻
 * - 任一方可「背叛」：背叛方立即 -5 金信誉惩罚，
 *   被背叛方获得一张「复仇」牌（对背叛者 12 伤）
 */

export interface AlliancePanelProps {
  players: PlayerState[];
  meId: string | null;
  alliances: AllianceLink[];
  turn: number;
  /** 是否处于对局中（等待大厅不可结盟） */
  running: boolean;
  onRequest: (targetId: string) => void;
  onAccept: (fromId: string) => void;
  onBetray: () => void;
}

export default function AlliancePanel({
  players,
  meId,
  alliances,
  turn,
  running,
  onRequest,
  onAccept,
  onBetray,
}: AlliancePanelProps) {
  const mine = meId ? alliances.filter((a) => a.a === meId || a.b === meId) : [];
  const others = players.filter((p) => p.id !== meId && p.team !== 'boss' && !p.castle.eliminated);
  const nameOf = (id: string) => players.find((p) => p.id === id)?.nickname ?? id;

  return (
    <div className="rounded-xl border border-white/10 bg-black/30 p-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="font-display text-xs text-neon-purple">🤝 结盟与背叛</h3>
        <span className="text-[10px] text-fog">{running ? `第 ${turn} 回合` : '未开局'}</span>
      </div>

      {/* 我的同盟 */}
      {mine.length > 0 ? (
        <ul className="mb-3 space-y-1">
          {mine.map((a) => {
            const other = a.a === meId ? a.b : a.a;
            const left = Math.max(0, a.untilTurn - turn);
            return (
              <li
                key={`${a.a}-${a.b}`}
                className="flex items-center justify-between rounded-lg border border-neon-purple/30 bg-neon-purple/5 px-2 py-1.5 text-[11px]"
              >
                <span className="truncate text-[#e6f1ff]">
                  与 <span className="text-neon-purple">{nameOf(other)}</span> 同盟中 · 剩余 {left} 回合
                </span>
                <button
                  className="btn-red ml-2 shrink-0 px-2 py-0.5 text-[10px]"
                  onClick={onBetray}
                  disabled={!running}
                  title="背叛：-5 金信誉惩罚，对方获得复仇牌"
                >
                  🗡 背叛
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mb-3 text-[10px] leading-relaxed text-fog">
          尚未结盟。结盟后 3 回合内双方不可互攻；背叛会付出信誉代价，并让对方获得一张【复仇】牌。
        </p>
      )}

      {/* 其他玩家 */}
      {others.length === 0 ? (
        <p className="text-[10px] text-fog/70">暂无可结盟对象</p>
      ) : (
        <ul className="space-y-1.5">
          {others.map((p) => {
            const allied = mine.some((a) => a.a === p.id || a.b === p.id);
            const color = playerColor(p.team, players.findIndex((q) => q.id === p.id), 'ffa');
            return (
              <li
                key={p.id}
                className="flex items-center justify-between gap-2 rounded-lg border border-white/10 px-2 py-1.5"
              >
                <span className="flex min-w-0 items-center gap-2 text-[11px]">
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
                  <span className="truncate text-[#e6f1ff]">{p.nickname}</span>
                  <span className="shrink-0 text-[10px] text-fog">{TEAM_LABEL[p.team]}</span>
                </span>

                {allied ? (
                  <span className="chip shrink-0 border-neon-purple/40 text-neon-purple">同盟中</span>
                ) : (
                  <span className="flex shrink-0 gap-1">
                    <button
                      className="btn-ghost px-2 py-0.5 text-[10px]"
                      onClick={() => onRequest(p.id)}
                      disabled={!running}
                      title="发送结盟请求"
                    >
                      🤝 请求
                    </button>
                    <button
                      className="btn-blue px-2 py-0.5 text-[10px]"
                      onClick={() => onAccept(p.id)}
                      disabled={!running}
                      title="接受对方发来的结盟请求（仅在对方已请求时生效）"
                    >
                      ✓ 接受
                    </button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* 全部同盟（含他人间结盟，便于判断局势） */}
      {alliances.length > 0 && (
        <div className="mt-3 border-t border-white/10 pt-2">
          <div className="mb-1 text-[10px] text-fog">战场同盟关系</div>
          <div className="flex flex-wrap gap-1">
            {alliances.map((a) => (
              <span
                key={`all-${a.a}-${a.b}`}
                className={cls(
                  'chip',
                  a.a === meId || a.b === meId
                    ? 'border-neon-purple/50 text-neon-purple'
                    : 'border-white/15 text-fog',
                )}
              >
                {nameOf(a.a)} ↔ {nameOf(a.b)} · {Math.max(0, a.untilTurn - turn)}轮
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}