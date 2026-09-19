/**
 * lib/cards.ts —— 《AI攻防战：城堡围攻》全部卡牌定义
 *
 * ⚠️ 安全边界：本文件中的「攻击牌」仅是对安全概念的游戏化抽象标签，
 * 效果只在游戏数值层面结算（伤害 / 减益 / 倒计时），不包含、也不映射任何真实攻击技术细节。
 *
 * 每张卡牌结构：
 * - id        唯一标识（协议中使用）
 * - name      卡名
 * - kind      'attack' | 'defense'
 * - category  群攻/直击/延迟/削弱/封锁/破防/攻城/偷袭/干扰/强化/侦察/治疗/反制/误导/增益/应急/终极
 * - cost      消耗（gold 金币 / wood 木材 / intel 情报）
 * - targeting 目标类型（服务端严格校验）
 * - effect    判别联合：结算引擎 lib/engine.ts 按 type 分支处理
 * - tag       概念标签（纯游戏化抽象）
 * - desc      效果描述（UI 展示）
 * - icon      展示用图标（emoji）
 */
import type { TroopKind } from './troops';

export type ResourceKey = 'gold' | 'wood' | 'intel';

export interface ResourceBag {
  gold: number;
  wood: number;
  intel: number;
}

export type CardKind = 'attack' | 'defense';

/**
 * 目标类型：
 * none      —— 无需目标（自身 / 全场）
 * enemy     —— 单个敌方玩家
 * enemyWall —— 敌方玩家 + 指定墙体层（outer / inner）
 * ally      —— 友方玩家
 */
export type CardTargeting = 'none' | 'enemy' | 'enemyWall' | 'ally';

export type CardEffect =
  /* ── 攻击牌效果 ── */
  | { type: 'damage_all_outer'; amount: number } // 洪水术
  | { type: 'damage_keep_pierce'; amount: number } // 毒箭
  | { type: 'delayed_keep'; amount: number; delayTurns: number } // 潜伏者
  | { type: 'limit_plays'; count: number } // 幻象
  | { type: 'block_repair' } // 断粮
  | { type: 'break_shield'; armorPenalty: number } // 破盾锤
  | { type: 'damage_wall'; amount: number } // 裂墙
  | { type: 'damage_random_tower'; amount: number } // 无声箭
  | { type: 'apply_fog' } // 迷雾
  | { type: 'smith_hammer'; amount: number; discardSelf: number } // 铁匠之锤
  | { type: 'revenge_strike'; amount: number } // 复仇（特殊：被背叛时获得）
  /* ── 防御牌效果 ── */
  | { type: 'buff_armor'; amount: number; turns: number } // 坚壁
  | { type: 'reveal_hand'; turns: number } // 哨塔
  | { type: 'purify'; keepHeal: number } // 净化
  | { type: 'heal_wall'; amount: number } // 修复
  | { type: 'buff_reflect'; amount: number; turns: number } // 加固
  | { type: 'counter_stance'; ratio: number } // 反击
  | { type: 'decoy'; count: number } // 假堡
  | { type: 'grant_allies_gold'; amount: number } // 团结
  | { type: 'discard_heal'; heal: number; discard: number } // 弃甲
  | { type: 'global_attack_nullify' } // 破晓
  /* ── 兵营牌效果（常备军，见 lib/troops.ts） ── */
  | { type: 'recruit'; troop: TroopKind; count: number };

export interface CardDef {
  id: string;
  name: string;
  kind: CardKind;
  category: string;
  cost: Partial<Record<ResourceKey, number>>;
  targeting: CardTargeting;
  effect: CardEffect;
  /** 概念标签（纯游戏化抽象） */
  tag: string;
  desc: string;
  icon: string;
}

/* ══════════════════════ 攻击牌（10 张） ══════════════════════ */

export const ATTACK_CARDS: CardDef[] = [
  {
    id: 'flood', name: '洪水术', kind: 'attack', category: '群攻',
    cost: { gold: 3 }, targeting: 'none',
    effect: { type: 'damage_all_outer', amount: 8 },
    tag: 'DDoS', desc: '对所有敌人外墙造成 8 伤', icon: '🌊',
  },
  {
    id: 'poison_arrow', name: '毒箭', kind: 'attack', category: '直击',
    cost: { gold: 4 }, targeting: 'enemy',
    effect: { type: 'damage_keep_pierce', amount: 6 },
    tag: '注入攻击', desc: '无视墙体，对主堡造成 6 伤', icon: '🏹',
  },
  {
    id: 'lurker', name: '潜伏者', kind: 'attack', category: '延迟',
    cost: { gold: 5 }, targeting: 'enemy',
    effect: { type: 'delayed_keep', amount: 15, delayTurns: 3 },
    tag: 'APT 潜伏', desc: '3 回合后爆发，对主堡 15 伤', icon: '🕷️',
  },
  {
    id: 'mirage', name: '幻象', kind: 'attack', category: '削弱',
    cost: { gold: 3 }, targeting: 'enemy',
    effect: { type: 'limit_plays', count: 1 },
    tag: '社工', desc: '目标下回合只能出 1 张牌', icon: '🎭',
  },
  {
    id: 'supply_cut', name: '断粮', kind: 'attack', category: '封锁',
    cost: { gold: 3 }, targeting: 'enemy',
    effect: { type: 'block_repair' },
    tag: '供应链攻击', desc: '目标本回合无法修复', icon: '🌾',
  },
  {
    id: 'shield_breaker', name: '破盾锤', kind: 'attack', category: '破防',
    cost: { gold: 4 }, targeting: 'enemy',
    effect: { type: 'break_shield', armorPenalty: 5 },
    tag: '0day', desc: '使目标护盾归零，下回合护甲 -5', icon: '🔨',
  },
  {
    id: 'wall_cracker', name: '裂墙', kind: 'attack', category: '攻城',
    cost: { gold: 2 }, targeting: 'enemyWall',
    effect: { type: 'damage_wall', amount: 12 },
    tag: '漏洞扫描', desc: '对指定墙体造成 12 伤', icon: '🧱',
  },
  {
    id: 'silent_arrow', name: '无声箭', kind: 'attack', category: '偷袭',
    cost: { gold: 4 }, targeting: 'enemy',
    effect: { type: 'damage_random_tower', amount: 15 },
    tag: '端口扫描', desc: '对随机箭塔造成 15 伤', icon: '🎯',
  },
  {
    id: 'fog', name: '迷雾', kind: 'attack', category: '干扰',
    cost: { gold: 2 }, targeting: 'enemy',
    effect: { type: 'apply_fog' },
    tag: '拒绝服务', desc: '目标下回合看不到战场信息', icon: '🌫️',
  },
  {
    id: 'smith_hammer', name: '铁匠之锤', kind: 'attack', category: '攻城',
    cost: { gold: 5 }, targeting: 'enemyWall',
    effect: { type: 'smith_hammer', amount: 20, discardSelf: 1 },
    tag: '暴力破解', desc: '对城墙造成 20 伤，自身损失 1 张牌', icon: '⚒️',
  },
];

/* ══════════════════════ 防御牌 + 兵营牌（14 张） ══════════════════════ */

export const DEFENSE_CARDS: CardDef[] = [
  {
    id: 'bulwark', name: '坚壁', kind: 'defense', category: '强化',
    cost: { wood: 3 }, targeting: 'none',
    effect: { type: 'buff_armor', amount: 5, turns: 2 },
    tag: 'WAF', desc: '外墙护甲 +5，持续 2 回合', icon: '🛡️',
  },
  {
    id: 'watchtower', name: '哨塔', kind: 'defense', category: '侦察',
    cost: { gold: 2, intel: 1 }, targeting: 'none',
    effect: { type: 'reveal_hand', turns: 2 },
    tag: 'IDS', desc: '看到对手手牌 2 回合', icon: '👁️',
  },
  {
    id: 'purify', name: '净化', kind: 'defense', category: '治疗',
    cost: { wood: 3 }, targeting: 'none',
    effect: { type: 'purify', keepHeal: 5 },
    tag: '杀毒', desc: '清除潜伏者 + 恢复主堡 5 血', icon: '✨',
  },
  {
    id: 'repair', name: '修复', kind: 'defense', category: '治疗',
    cost: { wood: 4 }, targeting: 'none',
    effect: { type: 'heal_wall', amount: 15 },
    tag: '备份恢复', desc: '外墙恢复 15 HP', icon: '🧰',
  },
  {
    id: 'reinforce', name: '加固', kind: 'defense', category: '强化',
    cost: { wood: 3 }, targeting: 'none',
    effect: { type: 'buff_reflect', amount: 2, turns: 3 },
    tag: '补丁管理', desc: '箭塔反伤 +2，持续 3 回合', icon: '🔧',
  },
  {
    id: 'counter', name: '反击', kind: 'defense', category: '反制',
    cost: { gold: 3 }, targeting: 'none',
    effect: { type: 'counter_stance', ratio: 0.5 },
    tag: '溯源反制', desc: '下次受击反弹 50% 伤害', icon: '↩️',
  },
  {
    id: 'decoy', name: '假堡', kind: 'defense', category: '误导',
    cost: { wood: 3 }, targeting: 'none',
    effect: { type: 'decoy', count: 1 },
    tag: '蜜罐', desc: '假目标吸收一次攻击', icon: '🏰',
  },
  {
    id: 'unity', name: '团结', kind: 'defense', category: '增益',
    cost: { gold: 2 }, targeting: 'none',
    effect: { type: 'grant_allies_gold', amount: 2 },
    tag: '联盟', desc: '盟友本回合 +2 金', icon: '🤝',
  },
  {
    id: 'discard_armor', name: '弃甲', kind: 'defense', category: '应急',
    cost: { gold: 1 }, targeting: 'none',
    effect: { type: 'discard_heal', heal: 10, discard: 1 },
    tag: '降级运行', desc: '弃 1 张牌，恢复 10 HP', icon: '🎒',
  },
  {
    id: 'dawn', name: '破晓', kind: 'defense', category: '终极',
    cost: { gold: 8 }, targeting: 'none',
    effect: { type: 'global_attack_nullify' },
    tag: '应急响应', desc: '全场敌人本回合攻击失效', icon: '🌅',
  },
  /* ── 兵营牌（4 张）：把资源变成常备军，小兵会真的推进与交战 ── */
  {
    id: 'recruit_sword', name: '剑士营', kind: 'defense', category: '兵营',
    cost: { gold: 1 }, targeting: 'none',
    effect: { type: 'recruit', troop: 'sword', count: 1 },
    tag: '常备军', desc: '训练 1 名剑士（前排·克弓手）', icon: '🗡️',
  },
  {
    id: 'recruit_archer', name: '弓手营', kind: 'defense', category: '兵营',
    cost: { gold: 2 }, targeting: 'none',
    effect: { type: 'recruit', troop: 'archer', count: 1 },
    tag: '常备军', desc: '训练 1 名弓手（远程·克矛兵）', icon: '🏹',
  },
  {
    id: 'recruit_spear', name: '矛兵营', kind: 'defense', category: '兵营',
    cost: { gold: 1, wood: 2 }, targeting: 'none',
    effect: { type: 'recruit', troop: 'spear', count: 1 },
    tag: '常备军', desc: '训练 1 名矛兵（克剑士）', icon: '🔱',
  },
  {
    id: 'recruit_giant', name: '巨人营', kind: 'defense', category: '兵营',
    cost: { gold: 3, wood: 2 }, targeting: 'none',
    effect: { type: 'recruit', troop: 'giant', count: 1 },
    tag: '常备军', desc: '训练 1 名巨人（高战力·推进慢）', icon: '🗿',
  },
];

export const ALL_CARDS: CardDef[] = [...ATTACK_CARDS, ...DEFENSE_CARDS];

/** 特殊牌：不进入初始牌堆（例如结盟背叛后授予被背叛方的「复仇」） */
export const SPECIAL_CARDS: CardDef[] = [
  {
    id: 'revenge', name: '复仇', kind: 'attack', category: '复仇',
    cost: {}, targeting: 'enemy',
    effect: { type: 'revenge_strike', amount: 12 },
    tag: '信誉惩罚', desc: '对被背叛者造成 12 伤', icon: '⚔️',
  },
];

const CARD_INDEX: Map<string, CardDef> = new Map([...ALL_CARDS, ...SPECIAL_CARDS].map((c) => [c.id, c]));

/**
 * 运行期动态卡（AI 自由渗透行动，见 lib/improvise.ts）。
 * 只存在于进程内存中，不进初始牌堆、不落库；每局结束后自然失效。
 */
const DYNAMIC_CARDS: Map<string, CardDef> = new Map();

/** 注册 / 覆盖一张运行期动态卡 */
export function registerDynamicCard(card: CardDef): void {
  DYNAMIC_CARDS.set(card.id, card);
}

export function getCard(id: string): CardDef | undefined {
  return CARD_INDEX.get(id) ?? DYNAMIC_CARDS.get(id);
}

export function costText(cost: Partial<Record<ResourceKey, number>>): string {
  const parts: string[] = [];
  if (cost.gold) parts.push(`${cost.gold}金`);
  if (cost.wood) parts.push(`${cost.wood}木`);
  if (cost.intel) parts.push(`${cost.intel}情`);
  return parts.join(' + ') || '免费';
}

export function canAfford(res: ResourceBag, cost: Partial<Record<ResourceKey, number>>): boolean {
  return (Object.keys(cost) as ResourceKey[]).every((k) => res[k] >= (cost[k] ?? 0));
}

/** 直接扣减（引擎在结构克隆的副本上操作，纯函数语义由 engine 保证） */
export function payCost(res: ResourceBag, cost: Partial<Record<ResourceKey, number>>): boolean {
  if (!canAfford(res, cost)) return false;
  for (const k of Object.keys(cost) as ResourceKey[]) res[k] -= cost[k] ?? 0;
  return true;
}

/** 每回合最多出牌数 */
export const MAX_PLAYS_PER_TURN = 3;
/** 手牌上限 */
export const HAND_LIMIT = 12;

/** 每位玩家的初始牌堆：全部卡牌 ×2（共 40 张） */
export function createDeck(): string[] {
  const deck: string[] = [];
  for (const c of ALL_CARDS) deck.push(c.id, c.id);
  return deck;
}