/**
 * lib/troops.ts —— 常备军（小兵）系统
 *
 * 回合制的「部队编制」模型：不做实时寻路/帧同步，只在每回合结算时
 * 用纯函数算一次交战结果（谁损失多少、谁把兵推到对方城下）。
 * 演出层（components/Battlefield.tsx）只读取编制数字来画小兵。
 *
 * ⚠️ 与卡牌一样，这里全部是游戏数值抽象，不映射任何真实技术细节。
 */

export type TroopKind = 'sword' | 'archer' | 'spear' | 'giant';
export type TroopBag = Record<TroopKind, number>;

export interface TroopMeta {
  key: TroopKind;
  name: string;
  /** 单体战力 */
  power: number;
  icon: string;
  /** 推进速度档（演出用：3 快 / 1 慢） */
  speed: 1 | 2 | 3;
}

export const TROOP_KINDS: TroopKind[] = ['sword', 'archer', 'spear', 'giant'];

export const TROOP_META: Record<TroopKind, TroopMeta> = {
  sword: { key: 'sword', name: '剑士', power: 2, icon: '🗡️', speed: 3 },
  archer: { key: 'archer', name: '弓手', power: 2, icon: '🏹', speed: 2 },
  spear: { key: 'spear', name: '矛兵', power: 2.4, icon: '🔱', speed: 2 },
  giant: { key: 'giant', name: '巨人', power: 5, icon: '🗿', speed: 1 },
};

/** 兵种克制：A 打 B 的系数（>1 克制，<1 被克） */
const COUNTER: Record<TroopKind, Record<TroopKind, number>> = {
  sword: { sword: 1, archer: 1.5, spear: 0.7, giant: 1 },
  archer: { sword: 0.7, archer: 1, spear: 1.5, giant: 1 },
  spear: { sword: 1.5, archer: 0.7, spear: 1, giant: 1 },
  giant: { sword: 1.2, archer: 1.2, spear: 0.8, giant: 1 },
};

/** 阵亡顺序：前排先倒 */
const EXPOSE: TroopKind[] = ['sword', 'spear', 'archer', 'giant'];

export const TROOP_CAP = { total: 12, perKind: 6 } as const;

/** 单回合最多损失比例（避免一次交锋全灭） */
const MAX_LOSS_RATE = 0.7;

export function emptyTroops(): TroopBag {
  return { sword: 0, archer: 0, spear: 0, giant: 0 };
}

/** 容错克隆：外部数据（快照 / 旧存档）可能缺字段 */
export function cloneTroops(input: TroopBag | null | undefined): TroopBag {
  const out = emptyTroops();
  if (!input || typeof input !== 'object') return out;
  for (const k of TROOP_KINDS) {
    const v = (input as Partial<TroopBag>)[k];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
      out[k] = Math.min(Math.floor(v), TROOP_CAP.perKind);
    }
  }
  return out;
}

export function totalTroops(t: TroopBag): number {
  return TROOP_KINDS.reduce((s, k) => s + (t[k] ?? 0), 0);
}

/** 征兵（受总上限与单兵种上限约束）→ 返回实际加入数量 */
export function addTroops(t: TroopBag, kind: TroopKind, count: number): number {
  const want = Math.max(0, Math.floor(count));
  const room = Math.min(TROOP_CAP.perKind - (t[kind] ?? 0), TROOP_CAP.total - totalTroops(t));
  const added = Math.min(want, Math.max(0, room));
  t[kind] = (t[kind] ?? 0) + added;
  return added;
}

export function subtractTroops(t: TroopBag, loss: Partial<TroopBag> | null | undefined): void {
  if (!loss) return;
  for (const k of TROOP_KINDS) {
    const v = loss[k] ?? 0;
    if (v > 0) t[k] = Math.max(0, (t[k] ?? 0) - v);
  }
}

/** 某兵种面对敌方阵容时的加权克制系数（敌方无兵 → 1） */
export function counterFactor(kind: TroopKind, enemy: TroopBag | null | undefined): number {
  const e = cloneTroops(enemy);
  const total = totalTroops(e);
  if (total === 0) return 1;
  let acc = 0;
  for (const k of TROOP_KINDS) {
    const n = e[k];
    if (n > 0) acc += COUNTER[kind][k] * n;
  }
  return acc / total;
}

/** 阵容战力（含克制修正） */
export function armyPower(t: TroopBag, enemy: TroopBag | null | undefined): number {
  let p = 0;
  for (const k of TROOP_KINDS) {
    const n = t[k] ?? 0;
    if (n > 0) p += n * TROOP_META[k].power * counterFactor(k, enemy);
  }
  return Math.round(p * 100) / 100;
}

export interface ClashResult {
  winner: 'a' | 'b' | 'tie';
  aLoss: TroopBag;
  bLoss: TroopBag;
  aPower: number;
  bPower: number;
  aRemainPower: number;
  bRemainPower: number;
}

/** 按「前排先倒」的顺序分配损失 */
function distributeLoss(t: TroopBag, count: number, rng: () => number): TroopBag {
  const loss = emptyTroops();
  let left = count;
  for (const k of EXPOSE) {
    if (left <= 0) break;
    const have = t[k] ?? 0;
    if (have <= 0) continue;
    // 巨人皮厚：有 40% 概率漏过一次（保留）
    if (k === 'giant' && rng() < 0.4) continue;
    const take = Math.min(have, left);
    loss[k] += take;
    left -= take;
  }
  return loss;
}

export function makeLossBag(a: Partial<TroopBag>, b: Partial<TroopBag>): TroopBag {
  const out = emptyTroops();
  for (const k of TROOP_KINDS) out[k] = (a[k] ?? 0) + (b[k] ?? 0);
  return out;
}

/**
 * 一次交锋解算（纯函数）：
 * - 双方战力按比例互相消耗（劣势方损失更多）；
 * - 战力明显更高的一方成为推进方，可继续打到对方城下。
 */
export function resolveClash(a: TroopBag, b: TroopBag, rng: () => number = Math.random): ClashResult {
  const aPower = armyPower(a, b);
  const bPower = armyPower(b, a);
  const total = aPower + bPower;
  const aTotal = totalTroops(a);
  const bTotal = totalTroops(b);

  if (total <= 0) {
    return { winner: 'tie', aLoss: emptyTroops(), bLoss: emptyTroops(), aPower: 0, bPower: 0, aRemainPower: 0, bRemainPower: 0 };
  }

  const jitter = () => 0.85 + rng() * 0.3;
  const rateA = Math.min(MAX_LOSS_RATE, (bPower / total) * 0.9 * jitter());
  const rateB = Math.min(MAX_LOSS_RATE, (aPower / total) * 0.9 * jitter());

  const aLoss = distributeLoss(a, Math.round(aTotal * rateA), rng);
  const bLoss = distributeLoss(b, Math.round(bTotal * rateB), rng);

  const aLeft = cloneTroops(a);
  subtractTroops(aLeft, aLoss);
  const bLeft = cloneTroops(b);
  subtractTroops(bLeft, bLoss);

  const aRemainPower = armyPower(aLeft, bLeft);
  const bRemainPower = armyPower(bLeft, aLeft);

  let winner: ClashResult['winner'] = 'tie';
  if (aRemainPower > bRemainPower * 1.05) winner = 'a';
  else if (bRemainPower > aRemainPower * 1.05) winner = 'b';

  return { winner, aLoss, bLoss, aPower, bPower, aRemainPower, bRemainPower };
}