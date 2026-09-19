'use client';

import type { GameMode, PlayerState } from '@/lib/protocol';
import { cls, fmtNum, playerColor, TEAM_LABEL } from '@/lib/client/ui';

/**
 * components/CastleStatus.tsx —— 城堡状态面板（⑱）
 *
 * 展示：主堡 / 护盾 / 外墙（含护甲）/ 内墙 / 箭塔（反伤）、资源、状态效果徽章。
 * 状态效果来自 lib/castle.ts 的 PlayerStatus
 * （坚壁 / 加固 / 破盾惩罚 / 反击 / 假堡 / 幻象 / 断粮 / 迷雾 / 哨塔）。
 */

export interface CastleStatusProps {
  player: PlayerState;
  isMe: boolean;
  index: number;
  turn: number;
  mode: GameMode;
  selected?: boolean;
  onSelect?: (id: string) => void;
  /** 我方处于迷雾时，对手信息模糊化 */
  obscured?: boolean;
}

function Bar({
  label,
  value,
  max,
  color,
}: {
  label: string;
  value: number;
  max: number;
  color: string;
}) {
  const ratio = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  return (
    <div>
      <div className="flex items-center justify-between text-[10px] text-fog">
        <span>{label}</span>
        <span className="font-mono" style={{ color }}>
          {Math.round(value)} / {max}
        </span>
      </div>
      <div className="mt-0.5 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${ratio * 100}%`, background: color }}
        />
      </div>
    </div>
  );
}

function Chip({ text, color, title }: { text: string; color: string; title?: string }) {
  return (
    <span className="chip" style={{ borderColor: `${color}66`, color, background: `${color}14` }} title={title}>
      {text}
    </span>
  );
}

export default function CastleStatus({
  player,
  isMe,
  index,
  turn,
  mode,
  selected,
  onSelect,
  obscured,
}: CastleStatusProps) {
  const color = playerColor(player.team, index, mode);
  const c = player.castle;
  const s = player.status;
  const dead = c.eliminated || c.keep.hp <= 0;
  const aliveTowers = c.towers.filter((t) => t.hp > 0);
  const reflectTotal = aliveTowers.reduce((sum, t) => sum + t.reflect, 0);

  /* 状态效果徽章 */
  const chips: { text: string; color: string; title: string }[] = [];
  if (s.armorBuff && turn <= s.armorBuff.expiresAtTurn) {
    chips.push({ text: `坚壁 +${s.armorBuff.amount}`, color: '#00f0ff', title: '外墙护甲提升（WAF 概念）' });
  }
  if (s.armorPenalty && turn <= s.armorPenalty.untilTurn) {
    chips.push({ text: `破防 -${s.armorPenalty.amount}`, color: '#ff3b5c', title: '护甲被削弱' });
  }
  if (s.reflectBuff && turn <= s.reflectBuff.expiresAtTurn) {
    chips.push({ text: `加固 反伤+${s.reflectBuff.amount}`, color: '#39ff14', title: '箭塔反伤提升' });
  }
  if (s.counterStance) {
    chips.push({
      text: `反击 ${Math.round(s.counterStance.ratio * 100)}%`,
      color: '#ffb020',
      title: '下次受击反弹部分伤害',
    });
  }
  if (s.decoys > 0) {
    chips.push({ text: `假堡 ×${s.decoys}`, color: '#8aa0b8', title: '假目标可吸收一次攻击' });
  }
  if (s.playLimit && s.playLimit.forTurn === turn) {
    chips.push({ text: `幻象 仅${s.playLimit.count}牌`, color: '#8b5cf6', title: '本回合出牌数受限' });
  }
  if (s.repairBlockedTurns.includes(turn)) {
    chips.push({ text: '断粮 禁修', color: '#ff3b5c', title: '本回合无法修复' });
  }
  if (s.fogUntilTurn >= turn) {
    chips.push({ text: '迷雾', color: '#8aa0b8', title: '看不到战场信息' });
  }
  if (s.revealUntilTurn >= turn) {
    chips.push({ text: '哨塔 侦察', color: '#00f0ff', title: '可看到对手手牌' });
  }

  const handText = obscured ? '手牌受迷雾遮蔽' : `${player.handCount} 张`;

  return (
    <div
      className={cls(
        'rounded-xl border bg-black/30 p-3 transition-colors',
        selected ? 'border-gold/70 shadow-glow-gold' : 'border-white/10',
        onSelect && !dead && !isMe ? 'cursor-pointer hover:border-white/30' : '',
      )}
      onClick={() => {
        if (onSelect && !dead && !isMe) onSelect(player.id);
      }}
    >
      {/* 头部 */}
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: color }} />
            <span className="truncate font-mono text-xs text-[#e6f1ff]">
              {player.nickname}
              {isMe && <span className="ml-1 text-ok">（你）</span>}
            </span>
          </div>
          <div className="mt-0.5 truncate text-[10px] text-fog">
            {TEAM_LABEL[player.team]} ·{' '}
            {player.aiMode === 'manual' ? '手动' : player.aiMode === 'auto' ? 'AI 托管' : '混合建议'}
            {player.modelName && player.modelName !== 'scripted' ? ` · ${player.modelName}` : ''}
          </div>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1">
          {!player.online && <span className="chip border-warn/50 text-warn">掉线托管</span>}
          {dead ? (
            <span className="chip border-neon-red/60 text-neon-red">已陷落</span>
          ) : (
            <span className="chip border-ok/40 text-ok">存活</span>
          )}
          {player.submission && (
            <span className="chip border-gold/50 text-gold">{isMe ? '已提交' : '已决策'}</span>
          )}
        </div>
      </div>

      {/* 血条 */}
      <div className="space-y-1.5">
        <Bar label="主堡 Keep" value={c.keep.hp} max={c.keep.maxHp} color="#ff3b5c" />
        <Bar label="护盾 Shield" value={c.keep.shield} max={50} color="#00f0ff" />
        <Bar label="外墙 Outer" value={c.outerWall.hp} max={c.outerWall.maxHp} color="#ffb020" />
        <Bar label="内墙 Inner" value={c.innerWall.hp} max={c.innerWall.maxHp} color="#8b5cf6" />
      </div>

      {/* 箭塔 */}
      <div className="mt-2 flex items-center justify-between text-[10px]">
        <span className="text-fog">
          箭塔 {aliveTowers.length}/{c.towers.length}
        </span>
        <span className="flex gap-1">
          {c.towers.map((t) => (
            <span
              key={t.id}
              title={t.hp > 0 ? `反伤 ${t.reflect} · HP ${t.hp}/${t.maxHp}` : '已摧毁'}
              className={cls(
                'inline-block h-3 w-3 rounded-sm border',
                t.hp > 0 ? 'border-ok/60 bg-ok/25' : 'border-white/15 bg-white/5',
              )}
            />
          ))}
        </span>
        <span className="font-mono text-warn">总反伤 {reflectTotal}</span>
      </div>

      {/* 资源 */}
      <div className="mt-2 grid grid-cols-3 gap-1 text-center text-[10px]">
        <div className="rounded bg-gold/10 py-1 text-gold">
          <div className="font-mono text-xs">{fmtNum(player.resources.gold)}</div>
          <div className="text-[9px] opacity-80">金币</div>
        </div>
        <div className="rounded bg-ok/10 py-1 text-ok">
          <div className="font-mono text-xs">{fmtNum(player.resources.wood)}</div>
          <div className="text-[9px] opacity-80">木材</div>
        </div>
        <div className="rounded bg-neon-blue/10 py-1 text-neon-blue">
          <div className="font-mono text-xs">{fmtNum(player.resources.intel)}</div>
          <div className="text-[9px] opacity-80">情报</div>
        </div>
      </div>

      {/* 状态效果 */}
      {chips.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {chips.map((ch) => (
            <Chip key={ch.text} text={ch.text} color={ch.color} title={ch.title} />
          ))}
        </div>
      )}

      {/* 手牌 / 提交状态 */}
      <div className="mt-2 flex items-center justify-between text-[10px] text-fog">
        <span>手牌 {handText}</span>
        {player.submission && !isMe && (
          <span className="text-fog/80">
            {player.submission.source === 'ai'
              ? '指挥官已决策'
              : player.submission.source === 'fallback'
                ? '保底出牌'
                : '已提交'}
          </span>
        )}
      </div>
    </div>
  );
}