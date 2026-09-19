'use client';

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { BattleEvent, GameMode, PlayerState, RoomPhase } from '@/lib/protocol';
import { TROOP_KINDS, TROOP_META, cloneTroops, totalTroops } from '@/lib/troops';
import type { TroopBag, TroopKind } from '@/lib/troops';
import { PHASE_LABEL, playerColor } from '@/lib/client/ui';

/**
 * components/Battlefield.tsx —— 横版 2D 战场（火柴人战争风）
 *
 * 左=我方要塞，右=对方要塞，中间通道上**按真实编制**站着双方小兵：
 * 前排剑士 / 矛兵 / 后排弓手 / 慢速巨人，各自有挥砍、突刺、拉弓、跺步的动作；
 * 结算阶段由事件驱动：兵营征兵会冒出「+N 兵」，交锋会飘出「-N 兵」并震屏。
 *
 * 性能约定（避免卡顿）：
 * - 全部动画只动 transform / opacity（GPU 合成），React 不做逐帧 setState；
 * - 小兵数量 = 编制数量（每方上限 12 个），DOM 规模有界；
 * - 事件只处理增量（seen 指针），一次遍历；
 * - 尊重 prefers-reduced-motion（在 globals.css 里统一关动画）。
 */

export interface BattlefieldProps {
  players: PlayerState[];
  mode: GameMode;
  meId: string | null;
  turn: number;
  maxTurns: number;
  phase: RoomPhase;
  fog: boolean;
  events: BattleEvent[];
  selectedTargetId: string | null;
  onSelectTarget: (id: string) => void;
}

type Shape = 'diamond' | 'circle' | 'bar' | 'square';

/** 三条通道的纵向位置 */
const LANE_TOP = ['22%', '46%', '70%'];

/** 兵种 → 视觉参数（advance = 距己方要塞的推进百分比，越大越靠前） */
const UNIT_VIEW: Record<TroopKind, { shape: Shape; size: number; advance: number; anim: string; dur: string }> = {
  sword: { shape: 'diamond', size: 9, advance: 50, anim: 'csai-slash', dur: '1.1s' },
  spear: { shape: 'bar', size: 12, advance: 44, anim: 'csai-thrust', dur: '1.3s' },
  archer: { shape: 'circle', size: 7, advance: 36, anim: 'csai-draw', dur: '1.5s' },
  giant: { shape: 'square', size: 17, advance: 26, anim: 'csai-stomp', dur: '1.9s' },
};

interface Unit {
  key: string;
  kind: TroopKind;
  lane: number;
  slot: number;
}

interface HitMark {
  dmg: number;
  key: number;
}

interface CastMark {
  key: string;
  dir: 'r' | 'l';
  color: string;
}

interface ClashMark {
  key: string;
  mineLoss: number;
  foeLoss: number;
  damage: number;
  loser: 'mine' | 'foe';
}

interface RecruitMark {
  key: string;
  side: 'mine' | 'foe';
  count: number;
}

/** 把编制展开成一个个小兵：同类按通道错开，后排向己方退让避免重叠 */
function expandUnits(troops: TroopBag | undefined, side: 'mine' | 'foe'): Unit[] {
  const t = cloneTroops(troops);
  const out: Unit[] = [];
  for (const kind of TROOP_KINDS) {
    for (let i = 0; i < t[kind]; i += 1) {
      out.push({ key: `${side}-${kind}-${i}`, kind, lane: i % 3, slot: Math.floor(i / 3) });
    }
  }
  return out;
}

function ratio(v: number, max: number): number {
  if (!Number.isFinite(v) || !Number.isFinite(max) || max <= 0) return 0;
  return Math.max(0, Math.min(1, v / max));
}

function UnitBody({ shape, size, color }: { shape: Shape; size: number; color: string }) {
  const glow = `0 0 8px ${color}`;
  if (shape === 'circle') {
    return <span className="block rounded-full" style={{ width: size, height: size, background: color, boxShadow: glow }} />;
  }
  if (shape === 'bar') {
    return <span className="block rounded-[1px]" style={{ width: size * 1.6, height: 3, background: color, boxShadow: glow }} />;
  }
  if (shape === 'square') {
    return (
      <span className="relative block rounded-[2px]" style={{ width: size, height: size, background: color, boxShadow: glow }}>
        <span className="absolute inset-[3px] rounded-[1px] bg-ink/70" />
      </span>
    );
  }
  return <span className="block rotate-45 rounded-[1px]" style={{ width: size, height: size, background: color, boxShadow: glow }} />;
}

/** 单个小兵：定位层不动，动作层跑 CSS 动画（敌方整体镜像） */
function UnitSprite({ unit, side, color }: { unit: Unit; side: 'mine' | 'foe'; color: string }) {
  const v = UNIT_VIEW[unit.kind];
  const offset = unit.slot * 13;
  const style: CSSProperties = {
    top: LANE_TOP[unit.lane],
    animationDelay: `${(unit.lane * 0.18 + unit.slot * 0.21).toFixed(2)}s`,
    ...(side === 'mine'
      ? { left: `calc(${10 + v.advance}% - ${offset}px)` }
      : { right: `calc(${10 + v.advance}% - ${offset}px)` }),
  };
  return (
    <span className="csai-anim absolute flex flex-col items-center gap-0.5" style={style}>
      <span className={side === 'foe' ? 'block scale-x-[-1]' : 'block'}>
        <span className={`block ${v.anim}`} style={{ '--dur': v.dur } as CSSProperties}>
          <UnitBody shape={v.shape} size={v.size} color={color} />
        </span>
      </span>
      <span className="block h-0.5 w-5 rounded bg-black/70">
        <span className="block h-0.5 w-full rounded" style={{ background: color }} />
      </span>
    </span>
  );
}

/** 要塞剪影 */
function BaseGlyph({ color, alive }: { color: string; alive: boolean }) {
  return (
    <svg viewBox="0 0 60 80" width={52} height={68} className={alive ? '' : 'opacity-40 grayscale'}>
      <polygon points="8,74 52,74 46,34 14,34" fill="#0a0e17" stroke={color} strokeWidth={1.6} />
      <polygon points="4,74 20,74 17,56 7,56" fill="#0a0e17" stroke={color} strokeWidth={1.2} opacity={0.85} />
      <polygon points="40,74 56,74 53,56 43,56" fill="#0a0e17" stroke={color} strokeWidth={1.2} opacity={0.85} />
      <line x1={30} y1={34} x2={30} y2={16} stroke={color} strokeWidth={1.4} />
      <circle cx={30} cy={13} r={3.2} fill={alive ? '#00f0ff' : '#3a465c'}>
        {alive && <animate attributeName="opacity" values="1;0.3;1" dur="2.2s" repeatCount="indefinite" />}
      </circle>
      {[19, 27, 35].map((x) => (
        <rect key={x} x={x} y={44} width={4} height={8} fill="#00f0ff" opacity={alive ? 0.5 : 0.15} />
      ))}
    </svg>
  );
}

/** 战线概览 chip（点选攻击目标） */
function TargetChip({
  p,
  index,
  mode,
  isSelf,
  selected,
  onSelect,
}: {
  p: PlayerState;
  index: number;
  mode: GameMode;
  isSelf: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const color = playerColor(p.team, index, mode);
  const dead = p.castle.eliminated;
  const hp = ratio(p.castle.keep.hp, p.castle.keep.maxHp);
  const troops = totalTroops(cloneTroops(p.troops));
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`shrink-0 rounded border bg-black/50 px-2 py-1 text-left font-mono text-[10px] transition-colors ${
        selected
          ? 'border-gold/70 text-gold'
          : isSelf
            ? 'border-neon-blue/50 text-neon-blue'
            : 'border-white/10 text-fog hover:border-white/25'
      }`}
      style={{ width: 106 }}
    >
      <span className="flex items-center gap-1">
        <i className="inline-block h-2 w-2 rotate-45" style={{ background: dead ? '#3a465c' : color }} />
        <span className="truncate">{p.nickname.slice(0, 8)}</span>
      </span>
      <span className="mt-1 block h-1 w-full rounded bg-white/10">
        <span className="block h-1 rounded" style={{ width: `${hp * 100}%`, background: hp > 0.4 ? '#39ff14' : '#ff3b5c' }} />
      </span>
      <span className="mt-0.5 block text-[9px] text-fog/70">
        {dead ? '已陷落' : `HP ${Math.round(p.castle.keep.hp)}`}
        {isSelf ? ' · 我方' : ''}
      </span>
      {troops > 0 && <span className="block text-[9px] text-white/50">⚔ 兵 {troops}</span>}
    </button>
  );
}

/** 编制摘要：🗡️2 🏹1 … */
function TroopSummary({ troops, className }: { troops: TroopBag | undefined; className?: string }) {
  const t = cloneTroops(troops);
  const items = TROOP_KINDS.filter((k) => t[k] > 0);
  if (items.length === 0) return <span className={className}>无兵</span>;
  return (
    <span className={className}>
      {items.map((k) => (
        <span key={k} className="mr-1.5">
          {TROOP_META[k].icon}
          {t[k]}
        </span>
      ))}
    </span>
  );
}

/** 一批事件 → 演出标记（纯函数，便于离线单测；组件只在增量事件上调用一次） */
export function deriveMarks(
  fresh: BattleEvent[],
  meId: string | null,
  foeId: string | null,
): { hits: Record<string, HitMark>; casts: CastMark[]; clash: ClashMark | null; recruits: RecruitMark[] } {
  const hits: Record<string, HitMark> = {};
  const casts: CastMark[] = [];
  const recruits: RecruitMark[] = [];
  let clash: ClashMark | null = null;
  let seq = 0;

  for (const ev of fresh) {
    seq += 1;
    if (ev.type === 'castle:hit' || ev.type === 'lurk:exploded') {
      hits[ev.playerId] = { dmg: ev.damage, key: Math.random() };
    } else if (ev.type === 'castle:destroyed' || ev.type === 'player:eliminated') {
      hits[ev.playerId] = { dmg: 0, key: Math.random() };
    } else if (ev.type === 'card:played' && meId && foeId) {
      if (ev.playerId === meId && ev.targets.includes(foeId)) {
        casts.push({ key: `c${seq}`, dir: 'r', color: '#00f0ff' });
      } else if (ev.playerId === foeId && ev.targets.includes(meId)) {
        casts.push({ key: `c${seq}`, dir: 'l', color: '#ff3b5c' });
      }
    } else if (ev.type === 'troop:recruited') {
      if (ev.playerId === meId) recruits.push({ key: `rm${seq}`, side: 'mine', count: ev.count });
      else if (ev.playerId === foeId) recruits.push({ key: `rf${seq}`, side: 'foe', count: ev.count });
    } else if (ev.type === 'troop:clash') {
      const mineLoss = ev.attackerId === meId ? ev.attackerLoss : ev.defenderId === meId ? ev.defenderLoss : 0;
      const foeLoss = ev.attackerId === foeId ? ev.attackerLoss : ev.defenderId === foeId ? ev.defenderLoss : 0;
      if (mineLoss > 0 || foeLoss > 0 || ev.damage > 0) {
        clash = {
          key: `x${seq}`,
          mineLoss,
          foeLoss,
          damage: ev.damage,
          loser: ev.damage <= 0 ? 'mine' : ev.attackerId === meId ? 'foe' : 'mine',
        };
      }
    }
  }
  return { hits, casts, clash, recruits };
}

export default function Battlefield({
  players,
  mode,
  meId,
  turn,
  maxTurns,
  phase,
  fog,
  events,
  selectedTargetId,
  onSelectTarget,
}: BattlefieldProps) {
  const [hits, setHits] = useState<Record<string, HitMark>>({});
  const [casts, setCasts] = useState<CastMark[]>([]);
  const [clash, setClash] = useState<ClashMark | null>(null);
  const [recruits, setRecruits] = useState<RecruitMark[]>([]);
  const seen = useRef(0);

  const me = useMemo(() => (meId ? (players.find((p) => p.id === meId) ?? null) : null), [players, meId]);
  const foe = useMemo(() => {
    const picked = selectedTargetId ? players.find((p) => p.id === selectedTargetId) : undefined;
    if (picked && picked.id !== meId) return picked;
    return players.find((p) => p.id !== meId && !p.castle.eliminated) ?? players.find((p) => p.id !== meId) ?? null;
  }, [players, meId, selectedTargetId]);

  const myUnits = useMemo(() => (me ? expandUnits(me.troops, 'mine') : []), [me]);
  const foeUnits = useMemo(() => (foe ? expandUnits(foe.troops, 'foe') : []), [foe]);

  /* 事件 → 受击 / 弹道 / 交锋 / 征兵（只处理增量，一次遍历） */
  useEffect(() => {
    if (events.length < seen.current) seen.current = 0;
    const fresh = events.slice(seen.current);
    seen.current = events.length;
    if (fresh.length === 0) return;

    const marks = deriveMarks(fresh, me?.id ?? null, foe?.id ?? null);
    if (Object.keys(marks.hits).length > 0) setHits((prev) => ({ ...prev, ...marks.hits }));
    if (marks.casts.length > 0) setCasts(marks.casts);
    if (marks.recruits.length > 0) setRecruits(marks.recruits);
    if (marks.clash) setClash(marks.clash);

    const t = setTimeout(() => {
      setHits({});
      setCasts([]);
      setClash(null);
      setRecruits([]);
    }, 1500);
    return () => clearTimeout(t);
  }, [events, me, foe]);

  const aliveCount = players.filter((p) => p.team !== 'spectator' && !p.castle.eliminated).length;
  const myHit = me ? hits[me.id] : undefined;
  const foeHit = foe ? hits[foe.id] : undefined;
  const fighting = phase === 'decide' || phase === 'resolve';
  const myTotal = me ? totalTroops(cloneTroops(me.troops)) : 0;
  const foeTotal = foe ? totalTroops(cloneTroops(foe.troops)) : 0;

  return (
    <div className="relative overflow-hidden rounded-xl border border-neon-blue/25 bg-ink/85">
      <div className="pointer-events-none absolute inset-0 bg-grid-faint opacity-25" />

      {/* 状态条 */}
      <div className="relative flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 font-mono text-[11px] text-fog">
        <span className="text-neon-blue">
          回合 {turn}/{maxTurns}
        </span>
        <span className="text-white/70">{PHASE_LABEL[phase] ?? phase}</span>
        <span>存活 {aliveCount}</span>
        <span className="hidden sm:inline">
          我军 <TroopSummary troops={me?.troops} className="text-neon-blue" />
        </span>
        <span className="hidden sm:inline">
          敌军 <TroopSummary troops={foe?.troops} className="text-neon-red" />
        </span>
        {fog && <span className="text-warn">⚠ 迷雾</span>}
        <span className="ml-auto text-[10px] text-fog/60">点选目标 → 底部技能卡出手</span>
      </div>

      {/* 战线概览 */}
      <div className="relative flex gap-2 overflow-x-auto px-3 pb-2">
        {players.length === 0 && <span className="py-2 font-mono text-[11px] text-fog/70">等待玩家入场…</span>}
        {players.map((p, i) => (
          <TargetChip
            key={p.id}
            p={p}
            index={i}
            mode={mode}
            isSelf={p.id === meId}
            selected={foe?.id === p.id && p.id !== meId}
            onSelect={() => onSelectTarget(p.id)}
          />
        ))}
      </div>

      {/* 主战场 */}
      <div className="relative mx-3 mb-3 h-[300px] overflow-hidden rounded-lg border border-white/10 bg-ink">
        <div className="pointer-events-none absolute inset-0 bg-grid-faint opacity-35" />
        <div className="pointer-events-none absolute inset-x-0 top-1/2 h-px bg-gradient-to-r from-neon-blue/40 via-neon-purple/30 to-neon-red/40" />

        {LANE_TOP.map((top) => (
          <div key={top} className="pointer-events-none absolute inset-x-16 border-t border-dashed border-white/10" style={{ top }} />
        ))}

        {!me && !foe ? (
          <div className="absolute inset-0 flex items-center justify-center font-mono text-xs text-fog/70">等待双方入场…</div>
        ) : (
          <>
            {/* 我方要塞 */}
            {me && (
              <div
                key={myHit?.key ?? 'me-base'}
                className={`absolute bottom-3 left-3 flex flex-col items-center gap-1 ${myHit ? 'csai-shake' : ''}`}
              >
                <BaseGlyph color="#00f0ff" alive={!me.castle.eliminated} />
                <span className="font-mono text-[10px] text-neon-blue">{me.nickname.slice(0, 8)}</span>
                <span className="h-1 w-16 rounded bg-white/10">
                  <span
                    className="block h-1 rounded bg-neon-blue"
                    style={{ width: `${ratio(me.castle.keep.hp, me.castle.keep.maxHp) * 100}%` }}
                  />
                </span>
                <span className="font-mono text-[9px] text-neon-blue/80">⚔ {myTotal}</span>
                {myHit && myHit.dmg > 0 && (
                  <span className="animate-rise pointer-events-none absolute -top-2 font-mono text-sm font-bold text-neon-red">
                    -{Math.round(myHit.dmg)}
                  </span>
                )}
              </div>
            )}

            {/* 敌方要塞 */}
            {foe && (
              <div
                key={foeHit?.key ?? 'foe-base'}
                className={`absolute bottom-3 right-3 flex flex-col items-center gap-1 ${foeHit ? 'csai-shake' : ''}`}
              >
                <BaseGlyph color="#ff3b5c" alive={!foe.castle.eliminated} />
                <span className="font-mono text-[10px] text-neon-red">{foe.nickname.slice(0, 8)}</span>
                <span className="h-1 w-16 rounded bg-white/10">
                  <span
                    className="block h-1 rounded bg-neon-red"
                    style={{ width: `${ratio(foe.castle.keep.hp, foe.castle.keep.maxHp) * 100}%` }}
                  />
                </span>
                <span className="font-mono text-[9px] text-neon-red/80">⚔ {foeTotal}</span>
                {foeHit && foeHit.dmg > 0 && (
                  <span className="animate-rise pointer-events-none absolute -top-2 font-mono text-sm font-bold text-gold">
                    -{Math.round(foeHit.dmg)}
                  </span>
                )}
              </div>
            )}

            {/* 小兵（真实编制） */}
            {myUnits.map((u) => (
              <UnitSprite key={u.key} unit={u} side="mine" color="#00f0ff" />
            ))}
            {foeUnits.map((u) => (
              <UnitSprite key={u.key} unit={u} side="foe" color="#ff3b5c" />
            ))}

            {/* 技能卡弹道 */}
            {casts.map((c) => (
              <span
                key={c.key}
                className={`pointer-events-none absolute top-1/2 ${c.dir === 'r' ? 'animate-bolt-r left-20' : 'animate-bolt-l right-20'}`}
              >
                <span
                  className="block h-1 rounded-full"
                  style={{ width: 34, background: `linear-gradient(90deg, transparent, ${c.color})`, boxShadow: `0 0 12px ${c.color}` }}
                />
              </span>
            ))}

            {/* 交锋：受伤方飘 -N */}
            {clash && (
              <>
                {(clash.mineLoss > 0 || clash.loser === 'mine') && (
                  <span
                    key={`cl-m-${clash.key}`}
                    className="animate-rise pointer-events-none absolute left-1/3 top-1/2 font-mono text-xs font-bold text-neon-red"
                  >
                    {clash.mineLoss > 0 ? `我军 -${clash.mineLoss}` : '被压制'}
                  </span>
                )}
                {(clash.foeLoss > 0 || clash.loser === 'foe') && (
                  <span
                    key={`cl-f-${clash.key}`}
                    className="animate-rise pointer-events-none absolute right-1/3 top-1/2 font-mono text-xs font-bold text-gold"
                  >
                    {clash.foeLoss > 0 ? `敌军 -${clash.foeLoss}` : '被压制'}
                  </span>
                )}
              </>
            )}

            {/* 征兵：兵营旁冒出 +N 兵 */}
            {recruits.map((r) => (
              <span
                key={r.key}
                className="animate-rise pointer-events-none absolute bottom-24 font-mono text-[11px] font-bold text-neon-blue"
                style={r.side === 'mine' ? { left: '3.5rem' } : { right: '3.5rem' }}
              >
                +{r.count} 兵
              </span>
            ))}

            {/* 中央交战火花 */}
            {fighting &&
              LANE_TOP.map((top, i) => (
                <span
                  key={`spark-${i}`}
                  className="csai-anim animate-spark absolute left-1/2 h-3 w-3 -translate-x-1/2 rounded-full bg-gold"
                  style={{ top, animationDelay: `${i * 0.22}s`, boxShadow: '0 0 12px rgba(255,215,0,.9)' }}
                />
              ))}

            {/* 迷雾（纯半透明，不用 backdrop-blur：避免每帧重采样导致卡顿） */}
            {fog && <div className="pointer-events-none absolute inset-0 bg-ink/50" />}
          </>
        )}
      </div>
    </div>
  );
}