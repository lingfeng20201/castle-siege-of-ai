/**
 * lib/castle.ts —— 城堡结构 + 战斗状态类型
 *
 * 城堡分层防御：攻击必须先破 外墙 → 内墙 → 才能打到主堡；
 * 箭塔持续反伤，拆除箭塔才能安全进攻。
 */

export const CASTLE_CONST = {
  keepHp: 100,
  keepShieldMax: 50,
  /** 补充设计：护盾每回合自然恢复 5（保证 0-50 量程有效） */
  keepShieldRegen: 5,
  outerHp: 80,
  outerArmorMax: 10,
  innerHp: 60,
  towerCount: 4,
  towerHp: 30,
  towerReflectMin: 2,
  towerReflectMax: 5,
  farmGold: 5,
  farmWood: 3,
  farmIntel: 1,
  barracksRepair: 5,
  startGold: 15,
  startWood: 10,
  startIntel: 3,
  maxTurns: 40,
  decideSeconds: 30,
  resolveSeconds: 3,
} as const;

export interface KeepState {
  hp: number;
  maxHp: number;
  shield: number;
}

export interface WallState {
  hp: number;
  maxHp: number;
  armor: number;
}

export interface TowerState {
  id: string;
  hp: number;
  maxHp: number;
  /** 每回合反伤（建塔时随机 2-5） */
  reflect: number;
}

export interface CastleState {
  keep: KeepState;
  outerWall: WallState;
  innerWall: WallState;
  towers: TowerState[];
  farm: { goldPerTurn: number; woodPerTurn: number };
  barracks: { repairPerTurn: number };
  eliminated: boolean;
}

/** 状态效果（buff / debuff），由结算引擎读写，回合恢复阶段清理 */
export interface PlayerStatus {
  /** 坚壁：外墙护甲 +N，持续到 expiresAtTurn（含该回合） */
  armorBuff: { amount: number; expiresAtTurn: number } | null;
  /** 加固：箭塔反伤 +N */
  reflectBuff: { amount: number; expiresAtTurn: number } | null;
  /** 破盾锤：下回合护甲 -N */
  armorPenalty: { amount: number; untilTurn: number } | null;
  /** 反击：下次受击反弹 ratio 比例伤害 */
  counterStance: { ratio: number } | null;
  /** 假堡数量 */
  decoys: number;
  /** 幻象：指定回合只能出 count 张牌 */
  playLimit: { count: number; forTurn: number } | null;
  /** 断粮：这些回合无法修复 */
  repairBlockedTurns: number[];
  /** 破晓：这些回合攻击失效 */
  attackNullTurns: number[];
  /** 迷雾：该回合前看不到战场信息（-1 = 无） */
  fogUntilTurn: number;
  /** 哨塔：该回合前可看到对手手牌（-1 = 无） */
  revealUntilTurn: number;
}

export function createCastle(rng: () => number = Math.random): CastleState {
  const rollReflect = () =>
    CASTLE_CONST.towerReflectMin +
    Math.floor(rng() * (CASTLE_CONST.towerReflectMax - CASTLE_CONST.towerReflectMin + 1));
  return {
    keep: { hp: CASTLE_CONST.keepHp, maxHp: CASTLE_CONST.keepHp, shield: 0 },
    outerWall: { hp: CASTLE_CONST.outerHp, maxHp: CASTLE_CONST.outerHp, armor: 0 },
    innerWall: { hp: CASTLE_CONST.innerHp, maxHp: CASTLE_CONST.innerHp, armor: 0 },
    towers: Array.from({ length: CASTLE_CONST.towerCount }, (_, i) => ({
      id: `t${i + 1}`,
      hp: CASTLE_CONST.towerHp,
      maxHp: CASTLE_CONST.towerHp,
      reflect: rollReflect(),
    })),
    farm: { goldPerTurn: CASTLE_CONST.farmGold, woodPerTurn: CASTLE_CONST.farmWood },
    barracks: { repairPerTurn: CASTLE_CONST.barracksRepair },
    eliminated: false,
  };
}

export function createPlayerStatus(): PlayerStatus {
  return {
    armorBuff: null,
    reflectBuff: null,
    armorPenalty: null,
    counterStance: null,
    decoys: 0,
    playLimit: null,
    repairBlockedTurns: [],
    attackNullTurns: [],
    fogUntilTurn: -1,
    revealUntilTurn: -1,
  };
}

/** 有效护甲 = 基础护甲 + 坚壁 - 破盾锤惩罚（下限 0） */
export function effectiveArmor(castle: CastleState, status: PlayerStatus, turn: number): number {
  let armor = castle.outerWall.armor;
  if (status.armorBuff && turn <= status.armorBuff.expiresAtTurn) armor += status.armorBuff.amount;
  if (status.armorPenalty && turn <= status.armorPenalty.untilTurn) armor -= status.armorPenalty.amount;
  return Math.max(0, armor);
}

/** 超时排名用：主堡 HP + 城墙 HP 总和 */
export function castlePower(castle: CastleState): number {
  return castle.keep.hp + castle.outerWall.hp + castle.innerWall.hp;
}

export function aliveTowerCount(castle: CastleState): number {
  return castle.towers.filter((t) => t.hp > 0).length;
}

/** 是否仍存活（未被淘汰且主堡有血） */
export function isCastleStanding(castle: CastleState): boolean {
  return !castle.eliminated && castle.keep.hp > 0;
}