'use client';

import { useMemo } from 'react';
import { canAfford, costText, getCard, type ResourceBag } from '@/lib/cards';
import type { PlayCardIntent } from '@/lib/protocol';
import { cls } from '@/lib/client/ui';

/**
 * components/HandCards.tsx —— 手牌交互（⑰）
 *
 * - 手牌扇形展开（横向滑动，适配移动端）
 * - 点击选牌 → 进入出牌序列（编号即出牌顺序；1-9 快捷键由房间页统一处理）
 * - 显示消耗与「是否可支付」，不可支付置灰
 * - 「需要目标」的卡牌由房间页在选中后进入选目标状态
 */

export interface HandCardsProps {
  hand: string[];
  resources: ResourceBag;
  selection: PlayCardIntent[];
  /** 本回合有效出牌上限（幻象会临时压低） */
  maxSelect: number;
  /** 非决策阶段 / 已提交 → 禁止操作 */
  disabled: boolean;
  /** 已提交出牌 */
  submitted: boolean;
  onSubmit: () => void;
  onClear: () => void;
  onToggle: (cardId: string, index: number) => void;
}

const KIND_COLOR: Record<'attack' | 'defense', string> = {
  attack: '#ff3b5c',
  defense: '#00f0ff',
};

export default function HandCards({
  hand,
  resources,
  selection,
  maxSelect,
  disabled,
  submitted,
  onSubmit,
  onClear,
  onToggle,
}: HandCardsProps) {
  const selectionIndex = useMemo(() => {
    const map = new Map<string, number>();
    selection.forEach((s, i) => {
      if (!map.has(s.id)) map.set(s.id, i + 1);
    });
    return map;
  }, [selection]);

  const full = selection.length >= maxSelect;

  return (
    <div className="flex flex-col gap-2">
      {/* 工具条 */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-1 text-[11px]">
        <div className="flex flex-wrap items-center gap-2 text-fog">
          <span className="chip border-white/15">
            出牌序列 <span className="text-neon-blue">{selection.length}</span>/{maxSelect}
          </span>
          <span className="chip border-white/15">手牌 {hand.length}/12</span>
          <span className="hidden text-fog/70 sm:inline">
            空格 确认 · Esc 清空 · 1-9 选牌 · Tab 切换目标
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button className="btn-ghost text-xs" onClick={onClear} disabled={selection.length === 0 || submitted}>
            清空
          </button>
          <button
            className={cls('text-xs', submitted ? 'btn-ghost' : 'btn-gold')}
            onClick={onSubmit}
            disabled={disabled || submitted || selection.length === 0}
          >
            {submitted ? '已提交' : '⚔ 出牌'}
          </button>
        </div>
      </div>

      {/* 手牌 */}
      {hand.length === 0 ? (
        <div className="flex h-[150px] items-center justify-center rounded-xl border border-dashed border-white/10 text-xs text-fog">
          暂无手牌 —— 等待抽牌阶段
        </div>
      ) : (
        <div className="flex gap-2 overflow-x-auto pb-2 pt-1 no-scrollbar">
          {hand.map((id, index) => {
            const card = getCard(id);
            const order = selectionIndex.get(id);
            const selected = order !== undefined;
            const affordable = card ? canAfford(resources, card.cost) : false;
            const blocked = disabled || submitted || (!selected && full);

            if (!card) {
              return (
                <div
                  key={`${id}-${index}`}
                  className="flex h-[150px] w-[106px] shrink-0 items-center justify-center rounded-lg border border-white/10 bg-black/40 text-[10px] text-fog"
                >
                  未知卡牌 {id}
                </div>
              );
            }

            const color = KIND_COLOR[card.kind];

            return (
              <button
                // 手牌可能存在同名重复卡，index 参与 key 以保持稳定
                key={`${id}-${index}`}
                onClick={() => onToggle(id, index)}
                disabled={blocked || !affordable}
                title={`${card.name} · ${card.category} · ${costText(card.cost)} · 概念标签：${card.tag}`}
                className={cls(
                  'relative flex h-[150px] w-[106px] shrink-0 flex-col justify-between rounded-lg border p-2 text-left transition-all',
                  'bg-gradient-to-b from-[#0d1320] to-[#080c14]',
                  selected
                    ? '-translate-y-2 border-gold/80 shadow-glow-gold'
                    : 'border-white/12 hover:-translate-y-1 hover:border-white/30',
                  (blocked || !affordable) && 'opacity-40',
                )}
                style={{ borderColor: selected ? '#ffd700' : `${color}44` }}
              >
                {selected && (
                  <span className="absolute -left-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-gold text-[11px] font-bold text-black">
                    {order}
                  </span>
                )}

                <div className="flex items-start justify-between">
                  <span className="text-xl leading-none">{card.icon}</span>
                  <span
                    className="rounded px-1 text-[9px]"
                    style={{ color, background: `${color}18`, border: `1px solid ${color}44` }}
                  >
                    {card.category}
                  </span>
                </div>

                <div>
                  <div className="font-display text-[13px] leading-tight text-[#e6f1ff]">{card.name}</div>
                  <div className="mt-1 text-[10px] leading-snug text-fog">{card.desc}</div>
                </div>

                <div className="flex items-center justify-between text-[10px]">
                  <span className={affordable ? 'text-gold' : 'text-neon-red'}>{costText(card.cost)}</span>
                  <span className="rounded bg-white/5 px-1 text-fog">{card.tag}</span>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}