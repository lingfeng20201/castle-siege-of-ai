import {
  HAND_LIMIT,
  MAX_PLAYS_PER_TURN,
  canAfford,
  createDeck,
  getCard,
  payCost,
} from './cards';
import type { CardDef, ResourceBag } from './cards';
import {
  CASTLE_CONST,
  castlePower,
  createCastle,
  createPlayerStatus,
  effectiveArmor,
} from './castle';
import type { CastleState, PlayerStatus } from './castle';
import {
  TROOP_KINDS,
  TROOP_META,
  addTroops,
  cloneTroops,
  emptyTroops,
  resolveClash,
  subtractTroops,
  totalTroops,
} from './troops';
import type { TroopBag } from './troops';
import type {
  AllianceLink,
  BattleEvent,
  GameMode,
  LogEntry,
  PlayCardIntent,
  PlayIntent,
} from './protocol';

/**
 * lib/engine.ts —— 《AI攻防战：城堡围攻》结算引擎（纯函数）
 *
 * (roomState, plays[]) → (newState, events[], logs[])
 *
 * 结算顺序（resolveTurn）：
 *   P0 前奏：破晓（全场敌人本回合攻击失效）
 *   P1 控制：断粮 / 幻象 / 迷雾 / 破盾锤 / 潜伏者
 *   P2 防御：坚壁 / 哨塔 / 净化 / 修复 / 加固 / 反击 / 假堡 / 团结 / 弃甲
 *   P3 强攻：洪水术 / 毒箭 / 裂墙 / 无声箭 / 铁匠之锤
 *   P4 箭塔反伤
 *   P5 潜伏者倒计时 / 爆发
 *   P6 淘汰判定
 *
 * 回合恢复（recoverPhase）：资源田产出 / 兵营修复 / 状态清理 / 随机事件（每 5 回合）
 * 回合开始（beginTurn）：抽牌 3 张
 *
 * ⚠️ 所有伤害只在「游戏数值」层面结算，无任何真实攻击含义。
 */

export type RNG = () => number;

export interface EnginePlayer {
  id: string;
  nickname: string;
  team: string;
  resources: ResourceBag;
  hand: string[];
  deck: string[];
  discard: string[];
  castle: CastleState;
  status: PlayerStatus;
  /** 常备军编制：每回合推进/交战，见 lib/troops.ts */
  troops: TroopBag;
  eliminated: boolean;
}

export interface LurkState {
  id: string;
  sourceId: string;
  targetId: string;
  amount: number;
  turnsLeft: number;
}

export interface BattleState {
  mode: GameMode;
  turn: number;
  players: Record<string, EnginePlayer>;
  alliances: AllianceLink[];
  lurkers: LurkState[];
}

export interface ResolveOutput {
  state: BattleState;
  events: BattleEvent[];
  logs: LogEntry[];
}

export interface VictoryResult {
  over: boolean;
  winner: string | null;
  winnerName: string | null;
  reason: string;
  ranking: { id: string; name: string; power: number }[];
}

/* ══════════════════════ 基础工具 ══════════════════════ */

function deepClone<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function uid(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

export function shuffle<T>(arr: T[], rng: RNG): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function createEnginePlayer(
  input: { id: string; nickname: string; team: string },
  rng: RNG = Math.random,
): EnginePlayer {
  return {
    id: input.id,
    nickname: input.nickname,
    team: input.team,
    resources: {
      gold: CASTLE_CONST.startGold,
      wood: CASTLE_CONST.startWood,
      intel: CASTLE_CONST.startIntel,
    },
    hand: [],
    deck: shuffle(createDeck(), rng),
    discard: [],
    castle: createCastle(rng),
    status: createPlayerStatus(),
    troops: emptyTroops(),
    eliminated: false,
  };
}

export function playLimitFor(p: EnginePlayer, turn: number): number {
  if (p.status.playLimit && p.status.playLimit.forTurn === turn) {
    return Math.min(p.status.playLimit.count, MAX_PLAYS_PER_TURN);
  }
  return MAX_PLAYS_PER_TURN;
}

interface Ctx {
  S: BattleState;
  turn: number;
  events: BattleEvent[];
  logs: LogEntry[];
  rng: RNG;
  /** defenderId → attackerIds（用于箭塔反伤） */
  pairs: Map<string, Set<string>>;
}

function makeCtx(S: BattleState, events: BattleEvent[], logs: LogEntry[], rng: RNG): Ctx {
  return { S, turn: S.turn, events, logs, rng, pairs: new Map() };
}

function ulog(ctx: Ctx, channel: LogEntry['channel'], text: string): void {
  ctx.logs.push({ id: uid('l'), ts: Date.now(), channel, text });
}

function isAllied(S: BattleState, a: string, b: string, turn: number): boolean {
  return S.alliances.some(
    (al) => al.untilTurn >= turn && ((al.a === a && al.b === b) || (al.a === b && al.b === a)),
  );
}

/** 敌对判定：非同一阵营（solo 除外）且存活 */
function hostilesOf(ctx: Ctx, p: EnginePlayer): EnginePlayer[] {
  return Object.values(ctx.S.players).filter(
    (t) =>
      t.id !== p.id &&
      !t.eliminated &&
      t.team !== 'spectator' &&
      !(t.team === p.team && p.team !== 'solo') &&
      !isAllied(ctx.S, p.id, t.id, ctx.turn),
  );
}

function allyPlayersOf(S: BattleState, p: EnginePlayer, turn: number): EnginePlayer[] {
  return Object.values(S.players).filter(
    (t) =>
      t.id !== p.id &&
      !t.eliminated &&
      ((t.team === p.team && p.team !== 'solo') || isAllied(S, p.id, t.id, turn)),
  );
}

/** 校验单目标攻击合法性，返回 null 表示无效（已写日志） */
function resolveEnemy(ctx: Ctx, p: EnginePlayer, targetId?: string): EnginePlayer | null {
  if (!targetId) {
    ulog(ctx, 'battle', `${p.nickname} 的出牌缺少目标，未生效`);
    return null;
  }
  const t = ctx.S.players[targetId];
  if (!t || t.id === p.id) {
    ulog(ctx, 'battle', `${p.nickname} 的出牌目标无效，未生效`);
    return null;
  }
  if (t.eliminated) {
    ulog(ctx, 'battle', `目标已被淘汰，${p.nickname} 的出牌未生效`);
    return null;
  }
  if (t.team === p.team && p.team !== 'solo') {
    ulog(ctx, 'battle', `${p.nickname} 试图攻击同阵营目标，未生效`);
    return null;
  }
  if (isAllied(ctx.S, p.id, t.id, ctx.turn)) {
    ulog(ctx, 'battle', `${p.nickname} 与 ${t.nickname} 的同盟协议生效中，攻击未能落地`);
    return null;
  }
  return t;
}

/* ══════════════════════ 伤害管线 ══════════════════════ */

interface DamageTick {
  layer: string;
  damage: number;
  hpLeft: number;
  destroyed?: boolean;
}

/** 主堡：护盾 → HP */
function applyKeepRoute(castle: CastleState, amount: number, ticks: DamageTick[]): void {
  let rem = amount;
  const s = Math.min(castle.keep.shield, rem);
  if (s > 0) {
    castle.keep.shield -= s;
    rem -= s;
  }
  if (rem > 0) {
    const dealt = Math.min(Math.max(castle.keep.hp, 0), rem);
    castle.keep.hp -= dealt;
    ticks.push({ layer: 'keep', damage: dealt, hpLeft: castle.keep.hp, destroyed: castle.keep.hp <= 0 });
  }
}

function pushInner(castle: CastleState, amount: number, ticks: DamageTick[]): number {
  if (amount <= 0 || castle.innerWall.hp <= 0) return amount;
  const dealt = Math.min(castle.innerWall.hp, amount);
  castle.innerWall.hp -= dealt;
  ticks.push({ layer: 'inner', damage: dealt, hpLeft: castle.innerWall.hp, destroyed: castle.innerWall.hp <= 0 });
  return amount - dealt;
}

/** 外墙（吃护甲）→ 内墙 → 主堡；pierceWalls 时直达主堡 */
function applyDamageChain(
  castle: CastleState,
  amount: number,
  opts: { pierceWalls: boolean; armor: number },
): DamageTick[] {
  const ticks: DamageTick[] = [];
  let remaining = Math.max(0, Math.floor(amount));
  if (remaining <= 0) return ticks;

  if (opts.pierceWalls) {
    applyKeepRoute(castle, remaining, ticks);
    return ticks;
  }

  if (castle.outerWall.hp > 0) {
    const eff = Math.max(1, remaining - opts.armor);
    const dealt = Math.min(castle.outerWall.hp, eff);
    castle.outerWall.hp -= dealt;
    remaining = eff - dealt;
    ticks.push({ layer: 'outer', damage: dealt, hpLeft: castle.outerWall.hp, destroyed: castle.outerWall.hp <= 0 });
  }
  if (remaining > 0) remaining = pushInner(castle, remaining, ticks);
  if (remaining > 0) applyKeepRoute(castle, remaining, ticks);
  return ticks;
}

function emitTicks(ctx: Ctx, target: EnginePlayer, ticks: DamageTick[]): void {
  for (const tick of ticks) {
    ctx.events.push({
      type: 'castle:hit',
      playerId: target.id,
      layer: tick.layer,
      damage: tick.damage,
      hpLeft: tick.hpLeft,
    });
    if (tick.destroyed) {
      ctx.events.push({ type: 'castle:destroyed', playerId: target.id, layer: tick.layer });
    }
  }
}

function registerPair(ctx: Ctx, defenderId: string, attackerId: string): void {
  if (!attackerId || defenderId === attackerId) return;
  let set = ctx.pairs.get(defenderId);
  if (!set) {
    set = new Set();
    ctx.pairs.set(defenderId, set);
  }
  set.add(attackerId);
}

interface DamageOpts {
  sourceId: string;
  pierceWalls: boolean;
  label: string;
  noCounter?: boolean;
  noPair?: boolean;
}

/** 对目标城堡结算一次伤害实例（含反击判定），返回实际总伤害 */
function damageInstance(ctx: Ctx, target: EnginePlayer, amount: number, opts: DamageOpts): number {
  if (target.eliminated || amount <= 0) return 0;

  const armor = effectiveArmor(target.castle, target.status, ctx.turn);
  const ticks = applyDamageChain(target.castle, amount, { pierceWalls: opts.pierceWalls, armor });
  emitTicks(ctx, target, ticks);
  if (!opts.noPair) registerPair(ctx, target.id, opts.sourceId);

  const total = ticks.reduce((s, t) => s + t.damage, 0);

  // 反击（溯源反制）：下次受击反弹 ratio 比例伤害
  if (!opts.noCounter && target.status.counterStance && opts.sourceId !== target.id) {
    const reflected = Math.floor(total * target.status.counterStance.ratio);
    target.status.counterStance = null;
    const src = ctx.S.players[opts.sourceId];
    if (reflected > 0 && src && !src.eliminated) {
      ulog(ctx, 'battle', `${target.nickname} 的【反击】生效：反弹 ${reflected} 伤害给 ${src.nickname}`);
      damageInstance(ctx, src, reflected, {
        sourceId: target.id,
        pierceWalls: false,
        label: '反击',
        noCounter: true,
        noPair: true,
      });
    } else {
      ulog(ctx, 'battle', `${target.nickname} 的【反击】架势被消耗`);
    }
  }
  return total;
}

/** 指定墙体打击：只打该层墙，溢出后：外→内→主堡 / 内→主堡 */
function damageWall(
  ctx: Ctx,
  t: EnginePlayer,
  layer: 'outer' | 'inner',
  amount: number,
  opts: { sourceId: string; label: string },
): void {
  const armor = effectiveArmor(t.castle, t.status, ctx.turn);
  const wall = layer === 'outer' ? t.castle.outerWall : t.castle.innerWall;

  if (wall.hp <= 0) {
    // 该墙已被摧毁：攻击直接穿透到主堡
    const ticks: DamageTick[] = [];
    applyKeepRoute(t.castle, amount, ticks);
    emitTicks(ctx, t, ticks);
    registerPair(ctx, t.id, opts.sourceId);
    return;
  }

  const eff = layer === 'outer' ? Math.max(1, amount - armor) : amount;
  const dealt = Math.min(wall.hp, eff);
  wall.hp -= dealt;
  ctx.events.push({ type: 'castle:hit', playerId: t.id, layer, damage: dealt, hpLeft: wall.hp });
  if (wall.hp <= 0) ctx.events.push({ type: 'castle:destroyed', playerId: t.id, layer });
  registerPair(ctx, t.id, opts.sourceId);

  const overflow = eff - dealt;
  if (overflow > 0) {
    const ticks: DamageTick[] = [];
    if (layer === 'outer') {
      const rest = pushInner(t.castle, overflow, ticks);
      if (rest > 0) applyKeepRoute(t.castle, rest, ticks);
    } else {
      applyKeepRoute(t.castle, overflow, ticks);
    }
    emitTicks(ctx, t, ticks);
  }
}

/** 假堡（蜜罐）吸收一次即时伤害攻击 */
function tryDecoyAbsorb(ctx: Ctx, target: EnginePlayer, label: string): boolean {
  if (!target.eliminated && target.status.decoys > 0) {
    target.status.decoys -= 1;
    ctx.events.push({ type: 'decoy:absorbed', playerId: target.id });
    ulog(ctx, 'battle', `${target.nickname} 的【假堡】吸收了【${label}】`);
    return true;
  }
  return false;
}

/* ══════════════════════ 出牌执行 ══════════════════════ */

function stageRank(effect: CardDef['effect']): number {
  switch (effect.type) {
    case 'global_attack_nullify':
      return 0;
    case 'block_repair':
    case 'limit_plays':
    case 'apply_fog':
    case 'break_shield':
    case 'delayed_keep':
      return 1;
    case 'damage_all_outer':
    case 'damage_keep_pierce':
    case 'damage_wall':
    case 'damage_random_tower':
    case 'smith_hammer':
    case 'revenge_strike':
      return 3;
    default:
      return 2; // 其余均为防御牌
  }
}

function previewTargets(ctx: Ctx, p: EnginePlayer, card: CardDef, entry: PlayCardIntent): string[] {
  switch (card.effect.type) {
    case 'damage_all_outer':
      return hostilesOf(ctx, p).map((t) => t.id);
    case 'damage_keep_pierce':
    case 'damage_wall':
    case 'damage_random_tower':
    case 'smith_hammer':
    case 'revenge_strike':
    case 'break_shield':
    case 'limit_plays':
    case 'apply_fog':
    case 'block_repair':
    case 'delayed_keep':
      return entry.target ? [entry.target] : [];
    default:
      return [p.id];
  }
}

function discardFromHand(p: EnginePlayer, cardId: string): void {
  const i = p.hand.indexOf(cardId);
  if (i >= 0) {
    p.hand.splice(i, 1);
    p.discard.push(cardId);
  }
}

function healKeep(p: EnginePlayer, amount: number): number {
  const before = p.castle.keep.hp;
  p.castle.keep.hp = Math.min(p.castle.keep.maxHp, p.castle.keep.hp + amount);
  return p.castle.keep.hp - before;
}

function healWall(wall: { hp: number; maxHp: number }, amount: number): number {
  const before = wall.hp;
  wall.hp = Math.min(wall.maxHp, wall.hp + amount);
  return wall.hp - before;
}

function executeCard(ctx: Ctx, p: EnginePlayer, card: CardDef, entry: PlayCardIntent): void {
  const eff = card.effect;
  const turn = ctx.turn;

  switch (eff.type) {
    /* ── 兵营：征兵（形成常备军，回合末推进交战） ── */
    case 'recruit': {
      const added = addTroops(p.troops, eff.troop, eff.count);
      const total = totalTroops(p.troops);
      if (added <= 0) {
        ulog(ctx, 'battle', `${p.nickname} 的兵营已满编，【${card.name}】未能征募新兵`);
        return;
      }
      ctx.events.push({ type: 'troop:recruited', playerId: p.id, troop: eff.troop, count: added, total });
      ulog(ctx, 'battle', `${p.nickname} 征募了 ${added} 名${TROOP_META[eff.troop].name}（现有兵力 ${total}）`);
      return;
    }
    /* ── P0 前奏 ── */
    case 'global_attack_nullify': {
      for (const q of hostilesOf(ctx, p)) q.status.attackNullTurns.push(turn);
      ulog(ctx, 'battle', `${p.nickname} 打出【破晓】：全场敌人本回合的攻击失效`);
      return;
    }

    /* ── P1 控制 ── */
    case 'block_repair': {
      const t = resolveEnemy(ctx, p, entry.target);
      if (!t) return;
      t.status.repairBlockedTurns.push(turn);
      ulog(ctx, 'battle', `${p.nickname} 对 ${t.nickname} 打出【断粮】：其本回合无法修复`);
      return;
    }
    case 'limit_plays': {
      const t = resolveEnemy(ctx, p, entry.target);
      if (!t) return;
      t.status.playLimit = { count: eff.count, forTurn: turn + 1 };
      ulog(ctx, 'battle', `${p.nickname} 对 ${t.nickname} 打出【幻象】：其下回合只能出 ${eff.count} 张牌`);
      return;
    }
    case 'apply_fog': {
      const t = resolveEnemy(ctx, p, entry.target);
      if (!t) return;
      t.status.fogUntilTurn = Math.max(t.status.fogUntilTurn, turn + 1);
      ulog(ctx, 'battle', `${p.nickname} 对 ${t.nickname} 打出【迷雾】：其下回合战场信息被遮蔽`);
      return;
    }
    case 'break_shield': {
      const t = resolveEnemy(ctx, p, entry.target);
      if (!t) return;
      t.castle.keep.shield = 0;
      t.status.armorPenalty = { amount: eff.armorPenalty, untilTurn: turn + 1 };
      ulog(ctx, 'battle', `${p.nickname} 对 ${t.nickname} 打出【破盾锤】：护盾归零，下回合其护甲 -${eff.armorPenalty}`);
      return;
    }
    case 'delayed_keep': {
      const t = resolveEnemy(ctx, p, entry.target);
      if (!t) return;
      ctx.S.lurkers.push({
        id: uid('lurk'),
        sourceId: p.id,
        targetId: t.id,
        amount: eff.amount,
        turnsLeft: eff.delayTurns,
      });
      ctx.events.push({ type: 'lurk:planted', playerId: t.id, turn });
      ulog(ctx, 'battle', `${p.nickname} 向 ${t.nickname} 的城堡埋入【潜伏者】：${eff.delayTurns} 回合后对主堡爆发 ${eff.amount} 伤`);
      return;
    }

    /* ── P2 防御 ── */
    case 'buff_armor': {
      p.status.armorBuff = { amount: eff.amount, expiresAtTurn: turn + eff.turns - 1 };
      ulog(ctx, 'battle', `${p.nickname} 打出【坚壁】：外墙护甲 +${eff.amount}（${eff.turns} 回合）`);
      return;
    }
    case 'reveal_hand': {
      p.status.revealUntilTurn = turn + eff.turns - 1;
      ulog(ctx, 'battle', `${p.nickname} 打出【哨塔】：可看到对手手牌（${eff.turns} 回合）`);
      return;
    }
    case 'purify': {
      const before = ctx.S.lurkers.length;
      ctx.S.lurkers = ctx.S.lurkers.filter((l) => l.targetId !== p.id);
      const cleared = before - ctx.S.lurkers.length;
      const healed = healKeep(p, eff.keepHeal);
      ulog(ctx, 'battle', `${p.nickname} 打出【净化】：清除 ${cleared} 个潜伏者，主堡恢复 ${healed} 血`);
      return;
    }
    case 'heal_wall': {
      if (p.status.repairBlockedTurns.includes(turn)) {
        ulog(ctx, 'battle', `${p.nickname} 的【修复】被【断粮】封锁`);
        return;
      }
      const healed = healWall(p.castle.outerWall, eff.amount);
      ulog(ctx, 'battle', `${p.nickname} 打出【修复】：外墙恢复 ${healed} HP`);
      return;
    }
    case 'buff_reflect': {
      p.status.reflectBuff = { amount: eff.amount, expiresAtTurn: turn + eff.turns - 1 };
      ulog(ctx, 'battle', `${p.nickname} 打出【加固】：箭塔反伤 +${eff.amount}（${eff.turns} 回合）`);
      return;
    }
    case 'counter_stance': {
      p.status.counterStance = { ratio: eff.ratio };
      ulog(ctx, 'battle', `${p.nickname} 进入【反击】架势：下次受击反弹 ${Math.round(eff.ratio * 100)}% 伤害`);
      return;
    }
    case 'decoy': {
      p.status.decoys += eff.count;
      ulog(ctx, 'battle', `${p.nickname} 布下【假堡】：可吸收 ${eff.count} 次攻击`);
      return;
    }
    case 'grant_allies_gold': {
      const allies = allyPlayersOf(ctx.S, p, turn);
      for (const a of allies) a.resources.gold += eff.amount;
      ulog(ctx, 'battle', `${p.nickname} 打出【团结】：${allies.length} 位盟友各 +${eff.amount} 金`);
      return;
    }
    case 'discard_heal': {
      let discarded: string | null = null;
      if (entry.sacrifice && p.hand.includes(entry.sacrifice)) {
        discardFromHand(p, entry.sacrifice);
        discarded = entry.sacrifice;
      } else if (p.hand.length > 0) {
        const idx = Math.floor(ctx.rng() * p.hand.length);
        discarded = p.hand[idx];
        discardFromHand(p, discarded);
      }
      const healed = healKeep(p, eff.heal);
      ulog(ctx, 'battle', `${p.nickname} 打出【弃甲】：${discarded ? '弃掉 1 张牌，' : ''}主堡恢复 ${healed} 血`);
      return;
    }

    /* ── P3 强攻 ── */
    case 'damage_all_outer': {
      for (const t of hostilesOf(ctx, p)) {
        if (tryDecoyAbsorb(ctx, t, card.name)) continue;
        damageInstance(ctx, t, eff.amount, { sourceId: p.id, pierceWalls: false, label: card.name });
      }
      ulog(ctx, 'battle', `${p.nickname} 打出【洪水术】：冲击全体敌人的外墙`);
      return;
    }
    case 'damage_keep_pierce': {
      const t = resolveEnemy(ctx, p, entry.target);
      if (!t) return;
      if (tryDecoyAbsorb(ctx, t, card.name)) return;
      damageInstance(ctx, t, eff.amount, { sourceId: p.id, pierceWalls: true, label: card.name });
      ulog(ctx, 'battle', `${p.nickname} 用【毒箭】越过墙体直击 ${t.nickname} 的主堡`);
      return;
    }
    case 'damage_wall': {
      const t = resolveEnemy(ctx, p, entry.target);
      if (!t) return;
      if (tryDecoyAbsorb(ctx, t, card.name)) return;
      const layer = entry.layer === 'inner' ? 'inner' : 'outer';
      damageWall(ctx, t, layer, eff.amount, { sourceId: p.id, label: card.name });
      ulog(ctx, 'battle', `${p.nickname} 用【裂墙】轰击 ${t.nickname} 的${layer === 'outer' ? '外墙' : '内墙'}（-${eff.amount}）`);
      return;
    }
    case 'damage_random_tower': {
      const t = resolveEnemy(ctx, p, entry.target);
      if (!t) return;
      if (tryDecoyAbsorb(ctx, t, card.name)) return;
      const towers = t.castle.towers.filter((x) => x.hp > 0);
      if (towers.length === 0) {
        ulog(ctx, 'battle', `${t.nickname} 已无箭塔可攻击，${p.nickname} 的出牌未生效`);
        return;
      }
      const tw = towers[Math.floor(ctx.rng() * towers.length)];
      const dealt = Math.min(tw.hp, eff.amount);
      tw.hp -= dealt;
      ctx.events.push({ type: 'castle:hit', playerId: t.id, layer: `tower:${tw.id}`, damage: dealt, hpLeft: tw.hp });
      registerPair(ctx, t.id, p.id);
      if (tw.hp <= 0) {
        ctx.events.push({ type: 'castle:destroyed', playerId: t.id, layer: `tower:${tw.id}` });
      }
      ulog(ctx, 'battle', `${p.nickname} 用【无声箭】命中 ${t.nickname} 的箭塔（-${dealt}）`);
      return;
    }
    case 'smith_hammer': {
      const t = resolveEnemy(ctx, p, entry.target);
      if (!t) return;
      if (tryDecoyAbsorb(ctx, t, card.name)) return;
      const layer = entry.layer === 'inner' ? 'inner' : 'outer';
      damageWall(ctx, t, layer, eff.amount, { sourceId: p.id, label: card.name });
      ulog(ctx, 'battle', `${p.nickname} 用【铁匠之锤】重击 ${t.nickname} 的${layer === 'outer' ? '外墙' : '内墙'}（-${eff.amount}）`);
      if (p.hand.length > 0) {
        const idx = Math.floor(ctx.rng() * p.hand.length);
        const lost = p.hand[idx];
        discardFromHand(p, lost);
        ulog(ctx, 'battle', `${p.nickname} 的【铁匠之锤】反震：损失 1 张手牌`);
      }
      return;
    }
    case 'revenge_strike': {
      const t = resolveEnemy(ctx, p, entry.target);
      if (!t) return;
      if (tryDecoyAbsorb(ctx, t, card.name)) return;
      damageInstance(ctx, t, eff.amount, { sourceId: p.id, pierceWalls: false, label: card.name });
      ulog(ctx, 'battle', `${p.nickname} 打出【复仇】：对 ${t.nickname} 造成 ${eff.amount} 伤`);
      return;
    }
    default:
      return;
  }
}

/* ══════════════════════ P4 箭塔反伤 ══════════════════════ */

function applyTowerReflect(ctx: Ctx): void {
  for (const [defenderId, attackers] of ctx.pairs) {
    const d = ctx.S.players[defenderId];
    if (!d || d.eliminated) continue;
    const aliveTowers = d.castle.towers.filter((t) => t.hp > 0);
    if (aliveTowers.length === 0) continue;

    const buff =
      d.status.reflectBuff && ctx.turn <= d.status.reflectBuff.expiresAtTurn
        ? d.status.reflectBuff.amount
        : 0;
    const perAttacker = aliveTowers.reduce((s, t) => s + t.reflect + buff, 0);
    if (perAttacker <= 0) continue;

    for (const attackerId of attackers) {
      const a = ctx.S.players[attackerId];
      if (!a || a.eliminated) continue;
      damageInstance(ctx, a, perAttacker, {
        sourceId: defenderId,
        pierceWalls: false,
        label: '箭塔反伤',
        noCounter: true,
        noPair: true,
      });
      ulog(ctx, 'battle', `${d.nickname} 的 ${aliveTowers.length} 座箭塔对 ${a.nickname} 造成 ${perAttacker} 反伤`);
    }
  }
}

/* ══════════════════════ P5 潜伏者 ══════════════════════ */

function tickLurkers(ctx: Ctx): void {
  for (const l of ctx.S.lurkers) l.turnsLeft -= 1;
  const boom = ctx.S.lurkers.filter((l) => l.turnsLeft <= 0);
  ctx.S.lurkers = ctx.S.lurkers.filter((l) => l.turnsLeft > 0);

  for (const l of boom) {
    const t = ctx.S.players[l.targetId];
    if (!t || t.eliminated) continue;
    const ticks = applyDamageChain(t.castle, l.amount, { pierceWalls: true, armor: 0 });
    emitTicks(ctx, t, ticks);
    const total = ticks.reduce((s, x) => s + x.damage, 0);
    ctx.events.push({ type: 'lurk:exploded', playerId: t.id, damage: total });
    ulog(ctx, 'battle', `【潜伏者】在 ${t.nickname} 的城堡中爆发，主堡受到 ${total} 伤害`);
  }
}

/* ══════════════════════ P6 淘汰判定 ══════════════════════ */

/* ══════════════════════ 常备军：推进与交战 ══════════════════════ */

/** 本回合主攻目标：优先取自己出牌打过的对象，否则取第一个敌对势力 */
function primaryTargetOf(ctx: Ctx, p: EnginePlayer): EnginePlayer | null {
  const score = new Map<string, number>();
  for (const ev of ctx.events) {
    if (ev.type !== 'card:played' || ev.playerId !== p.id) continue;
    for (const t of ev.targets) score.set(t, (score.get(t) ?? 0) + 1);
  }
  let bestId: string | null = null;
  let bestV = 0;
  for (const [id, v] of score) {
    const q = ctx.S.players[id];
    if (!q || q.eliminated) continue;
    if (v > bestV) {
      bestV = v;
      bestId = id;
    }
  }
  if (bestId) return ctx.S.players[bestId] ?? null;
  const foes = hostilesOf(ctx, p).filter((f) => !f.eliminated && f.team !== 'spectator');
  return foes.length > 0 ? foes[0] : null;
}

/**
 * 常备军推进：每对势力每回合只结算一次交锋；
 * 占优（战力高出 5%）的一方把兵推到对方城墙下，走 damageInstance 吃护甲 / 假堡 / 反击。
 */
function resolveTroops(ctx: Ctx): void {
  const movers = Object.values(ctx.S.players)
    .filter((p) => !p.eliminated && p.team !== 'spectator' && totalTroops(p.troops) > 0)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const settled = new Set<string>();

  for (const p of movers) {
    if (p.eliminated || totalTroops(p.troops) === 0) continue;
    const foe = primaryTargetOf(ctx, p);
    if (!foe || foe.eliminated) continue;
    const key = [p.id, foe.id].sort().join('|');
    if (settled.has(key)) continue;
    settled.add(key);

    const res = resolveClash(cloneTroops(p.troops), cloneTroops(foe.troops), ctx.rng);
    subtractTroops(p.troops, res.aLoss);
    subtractTroops(foe.troops, res.bLoss);

    let damage = 0;
    if (res.winner !== 'tie') {
      const winnerP = res.winner === 'a' ? p : foe;
      const loserP = res.winner === 'a' ? foe : p;
      const remainPower = res.winner === 'a' ? res.aRemainPower : res.bRemainPower;
      const push = Math.floor(remainPower * 1.1);
      if (push > 0) {
        damage = damageInstance(ctx, loserP, push, {
          sourceId: winnerP.id,
          pierceWalls: false,
          label: '部队推进',
          noPair: true, // 部队推进不是「攻击牌」，不触发箭塔反伤
        });
        ulog(ctx, 'battle', `⚔️ ${winnerP.nickname} 的部队推进到 ${loserP.nickname} 城下，造成 ${damage} 点破坏`);
      }
    } else {
      ulog(ctx, 'battle', `${p.nickname} 与 ${foe.nickname} 的部队僵持不下，各自收兵`);
    }

    ctx.events.push({
      type: 'troop:clash',
      attackerId: p.id,
      defenderId: foe.id,
      attackerLoss: totalTroops(res.aLoss),
      defenderLoss: totalTroops(res.bLoss),
      damage,
      attackerRemain: totalTroops(p.troops),
      defenderRemain: totalTroops(foe.troops),
    });
  }
}

function checkEliminations(ctx: Ctx): void {
  for (const p of Object.values(ctx.S.players)) {
    if (!p.eliminated && p.castle.keep.hp <= 0) {
      p.castle.keep.hp = 0;
      p.castle.eliminated = true;
      p.eliminated = true;
      ctx.events.push({ type: 'player:eliminated', playerId: p.id });
      ulog(ctx, 'battle', `💥 ${p.nickname} 的主堡被攻陷，退出战场！`);
    }
  }
}

/* ══════════════════════ 主流程：结算回合 ══════════════════════ */

export function resolveTurn(
  state: BattleState,
  plays: PlayIntent[],
  rng: RNG = Math.random,
): ResolveOutput {
  const S = deepClone(state);
  const events: BattleEvent[] = [];
  const logs: LogEntry[] = [];
  const ctx = makeCtx(S, events, logs, rng);
  const turn = S.turn;

  // 1) 收集并清洗出牌意图（手牌有效性 / 出牌上限）
  const plan: { player: EnginePlayer; card: CardDef; entry: PlayCardIntent }[] = [];
  for (const play of plays ?? []) {
    const p = S.players[play.playerId];
    if (!p || p.eliminated) continue;

    const limit = playLimitFor(p, turn);
    const handCopy = [...p.hand];
    let used = 0;
    for (const entry of play.cards ?? []) {
      if (used >= limit) break;
      const idx = handCopy.indexOf(entry.id);
      if (idx === -1) continue;
      const card = getCard(entry.id);
      if (!card) continue;
      handCopy.splice(idx, 1);
      used += 1;
      plan.push({ player: p, card, entry });
    }
  }

  // 2) 排序：破晓 → 控制 → 防御 → 强攻（稳定排序）
  plan.sort((a, b) => stageRank(a.card.effect) - stageRank(b.card.effect));

  // 3) 逐张结算
  for (const item of plan) {
    const p = item.player;
    if (p.eliminated) continue;
    const card = item.card;

    // 破晓压制：敌方攻击牌整体失效（牌仍消耗）
    if (card.kind === 'attack' && p.status.attackNullTurns.includes(turn)) {
      if (canAfford(p.resources, card.cost)) payCost(p.resources, card.cost);
      discardFromHand(p, card.id);
      ulog(ctx, 'battle', `${p.nickname} 的【${card.name}】被【破晓】压制，未能生效`);
      continue;
    }

    if (!canAfford(p.resources, card.cost)) {
      ulog(ctx, 'battle', `${p.nickname} 资源不足，【${card.name}】出牌失败`);
      continue;
    }
    payCost(p.resources, card.cost);
    discardFromHand(p, card.id);

    events.push({
      type: 'card:played',
      playerId: p.id,
      cardId: card.id,
      targets: previewTargets(ctx, p, card, item.entry),
    });
    executeCard(ctx, p, card, item.entry);
  }

  // 4) 箭塔反伤 → 5) 潜伏者 → 6) 常备军推进 → 7) 淘汰判定
  applyTowerReflect(ctx);
  tickLurkers(ctx);
  resolveTroops(ctx);
  checkEliminations(ctx);

  return { state: S, events, logs };
}

/* ══════════════════════ 回合开始：抽牌 ══════════════════════ */

function drawInto(p: EnginePlayer, count: number, rng: RNG): string[] {
  const drawn: string[] = [];
  for (let i = 0; i < count; i++) {
    if (p.hand.length >= HAND_LIMIT) break;
    if (p.deck.length === 0) {
      if (p.discard.length === 0) break;
      p.deck = shuffle(p.discard, rng);
      p.discard = [];
    }
    const c = p.deck.pop();
    if (!c) break;
    p.hand.push(c);
    drawn.push(c);
  }
  return drawn;
}

export function beginTurn(state: BattleState, rng: RNG = Math.random): ResolveOutput {
  const S = deepClone(state);
  const events: BattleEvent[] = [];
  const logs: LogEntry[] = [];
  S.turn += 1;
  const ctx = makeCtx(S, events, logs, rng);

  ulog(ctx, 'system', `—— 第 ${S.turn} 回合开始 ——`);
  for (const p of Object.values(S.players)) {
    if (p.eliminated) continue;
    const drawn = drawInto(p, 3, rng);
    if (drawn.length > 0) events.push({ type: 'card:drawn', playerId: p.id, cards: drawn });
  }
  return { state: S, events, logs };
}

/* ══════════════════════ 回合恢复 ══════════════════════ */

/** 兵营修复：优先外墙 → 内墙 → 受伤最重的箭塔（5 点 / 回合） */
function repairStructure(castle: CastleState, amount: number): number {
  let left = amount;
  let total = 0;

  const w1 = castle.outerWall;
  if (left > 0 && w1.hp < w1.maxHp) {
    const h = Math.min(left, w1.maxHp - w1.hp);
    w1.hp += h;
    left -= h;
    total += h;
  }
  const w2 = castle.innerWall;
  if (left > 0 && w2.hp < w2.maxHp) {
    const h = Math.min(left, w2.maxHp - w2.hp);
    w2.hp += h;
    left -= h;
    total += h;
  }
  if (left > 0) {
    const targets = castle.towers.filter((t) => t.hp < t.maxHp).sort((a, b) => a.hp - b.hp);
    for (const t of targets) {
      if (left <= 0) break;
      const h = Math.min(left, t.maxHp - t.hp);
      t.hp += h;
      left -= h;
      total += h;
    }
  }
  return total;
}

function pruneStatus(st: PlayerStatus, turn: number): void {
  if (st.armorBuff && turn >= st.armorBuff.expiresAtTurn) st.armorBuff = null;
  if (st.reflectBuff && turn >= st.reflectBuff.expiresAtTurn) st.reflectBuff = null;
  if (st.armorPenalty && turn >= st.armorPenalty.untilTurn) st.armorPenalty = null;
  if (st.playLimit && turn >= st.playLimit.forTurn) st.playLimit = null;
  st.repairBlockedTurns = st.repairBlockedTurns.filter((t) => t > turn);
  st.attackNullTurns = st.attackNullTurns.filter((t) => t > turn);
  if (st.fogUntilTurn >= 0 && turn >= st.fogUntilTurn) st.fogUntilTurn = -1;
  if (st.revealUntilTurn >= 0 && turn >= st.revealUntilTurn) st.revealUntilTurn = -1;
}

/** 随机事件（每 5 回合触发一次） */
function applyRandomEvent(ctx: Ctx): void {
  const alive = Object.values(ctx.S.players).filter((p) => !p.eliminated && p.team !== 'spectator');
  if (alive.length === 0) return;

  const roll = Math.floor(ctx.rng() * 5);
  if (roll === 0) {
    for (const p of alive) {
      const layer: 'outer' | 'inner' = p.castle.outerWall.hp > 0 ? 'outer' : 'inner';
      const wall = layer === 'outer' ? p.castle.outerWall : p.castle.innerWall;
      if (wall.hp <= 0) continue;
      const dealt = Math.min(wall.hp, 10);
      wall.hp -= dealt;
      ctx.events.push({ type: 'castle:hit', playerId: p.id, layer, damage: dealt, hpLeft: wall.hp });
      if (wall.hp <= 0) ctx.events.push({ type: 'castle:destroyed', playerId: p.id, layer });
    }
    ulog(ctx, 'battle', '【天灾】狂风肆虐：全体城墙受到冲击（-10）');
    ctx.events.push({ type: 'random:event', kind: 'disaster', text: '天灾：全体随机城墙 -10' });
  } else if (roll === 1) {
    for (const p of alive) p.resources.gold += 5;
    ulog(ctx, 'battle', '【丰收】资源田大丰收：全体 +5 金');
    ctx.events.push({ type: 'random:event', kind: 'harvest', text: '丰收：全体 +5 金' });
  } else if (roll === 2) {
    const p = alive[Math.floor(ctx.rng() * alive.length)];
    if (p.hand.length > 0) {
      const idx = Math.floor(ctx.rng() * p.hand.length);
      const lost = p.hand[idx];
      p.hand.splice(idx, 1);
      p.discard.push(lost);
      ulog(ctx, 'battle', `【黑天鹅】混战中，${p.nickname} 损失 1 张手牌`);
      ctx.events.push({ type: 'random:event', kind: 'blackswan', text: `黑天鹅：${p.nickname} 损失 1 张手牌` });
    }
  } else if (roll === 3) {
    const p = alive[Math.floor(ctx.rng() * alive.length)];
    const prev = p.status.reflectBuff?.amount ?? 0;
    p.status.reflectBuff = { amount: prev + 3, expiresAtTurn: ctx.turn + 2 };
    ulog(ctx, 'battle', `【铁匠来访】${p.nickname} 的箭塔反伤 +3（3 回合）`);
    ctx.events.push({ type: 'random:event', kind: 'smith', text: `铁匠来访：${p.nickname} 箭塔反伤 +3` });
  } else {
    for (const p of alive) {
      p.status.fogUntilTurn = Math.max(p.status.fogUntilTurn, ctx.turn + 1);
    }
    ulog(ctx, 'battle', '【迷雾】战场被浓雾笼罩：下回合所有人看不到对手状态');
    ctx.events.push({ type: 'random:event', kind: 'fog', text: '迷雾：下回合全员视野受限' });
  }
}

export function recoverPhase(state: BattleState, rng: RNG = Math.random): ResolveOutput {
  const S = deepClone(state);
  const events: BattleEvent[] = [];
  const logs: LogEntry[] = [];
  const ctx = makeCtx(S, events, logs, rng);
  const turn = S.turn;

  for (const p of Object.values(S.players)) {
    if (p.eliminated) continue;

    // 资源田产出：金币 +5 / 木材 +3 / 情报 +1
    p.resources.gold += CASTLE_CONST.farmGold;
    p.resources.wood += CASTLE_CONST.farmWood;
    p.resources.intel += CASTLE_CONST.farmIntel;

    // 护盾自然恢复（补充设计）
    p.castle.keep.shield = Math.min(
      CASTLE_CONST.keepShieldMax,
      p.castle.keep.shield + CASTLE_CONST.keepShieldRegen,
    );

    // 兵营修复（可被断粮封锁）
    if (!p.status.repairBlockedTurns.includes(turn)) {
      const repaired = repairStructure(p.castle, CASTLE_CONST.barracksRepair);
      if (repaired > 0) ulog(ctx, 'system', `${p.nickname} 的兵营修复了 ${repaired} 点结构`);
    } else {
      ulog(ctx, 'system', `${p.nickname} 的兵营修复被【断粮】封锁`);
    }

    // 征兵：兵营每回合自动补充 1 名新兵（随机兵种），保证战场不至于空场
    // ponytail: 自动补员是「保底」，主要兵力仍靠玩家出「兵营牌」招募
    const kind = TROOP_KINDS[Math.floor(ctx.rng() * TROOP_KINDS.length)] ?? 'sword';
    const added = addTroops(p.troops, kind, 1);
    if (added > 0) {
      events.push({ type: 'troop:recruited', playerId: p.id, troop: kind, count: added, total: totalTroops(p.troops) });
    }

    pruneStatus(p.status, turn);
  }

  // 随机事件：每 5 回合触发一次
  if (turn > 0 && turn % 5 === 0) applyRandomEvent(ctx);

  return { state: S, events, logs };
}

/* ══════════════════════ 胜负判定 ══════════════════════ */

export function checkVictory(S: BattleState): VictoryResult {
  const ranking = Object.values(S.players)
    .filter((p) => p.team !== 'spectator')
    .map((p) => ({ id: p.id, name: p.nickname, power: castlePower(p.castle) }))
    .sort((a, b) => b.power - a.power);

  const alive = Object.values(S.players).filter((p) => !p.eliminated && p.team !== 'spectator');

  let over = false;
  let winner: string | null = null;
  let reason = '';

  if (S.mode === 'ffa' || S.mode === 'coop') {
    if (alive.length <= 1) {
      over = true;
      winner = alive[0]?.id ?? null;
      reason = 'last-standing';
    }
  } else {
    const teams = Array.from(new Set(alive.map((p) => p.team)));
    if (alive.length > 0 && teams.length <= 1) {
      over = true;
      winner = teams[0];
      reason = 'team-victory';
    }
  }

  // 时间上限：40 回合后按「主堡 HP + 城墙 HP 总和」排名
  if (!over && S.turn >= CASTLE_CONST.maxTurns) {
    over = true;
    reason = 'timeout-ranking';
    if (S.mode === 'ffa' || S.mode === 'coop') {
      winner = ranking[0]?.id ?? null;
    } else {
      const teamPower = new Map<string, number>();
      for (const p of Object.values(S.players)) {
        if (p.team === 'spectator') continue;
        teamPower.set(p.team, (teamPower.get(p.team) ?? 0) + castlePower(p.castle));
      }
      let best: string | null = null;
      let bestVal = -1;
      for (const [team, val] of teamPower) {
        if (val > bestVal) {
          bestVal = val;
          best = team;
        }
      }
      winner = best;
    }
  }

  const winnerName = winner ? (S.players[winner]?.nickname ?? winner) : null;
  return { over, winner, winnerName, reason, ranking };
}

/* ══════════════════════ 保底出牌 ══════════════════════ */

/**
 * 非法返回 / 掉线托管 / 模型不可用时使用：
 * 优先「弃甲」保底，否则出得起的最便宜牌，否则空过。
 */
export function fallbackPlayIntent(p: EnginePlayer): PlayIntent {
  const pick = (id: string): PlayIntent | null => {
    const card = getCard(id);
    if (card && p.hand.includes(id) && canAfford(p.resources, card.cost)) {
      return { playerId: p.id, cards: [{ id }] };
    }
    return null;
  };

  const guard = pick('discard_armor');
  if (guard) return guard;

  for (const id of p.hand) {
    const c = getCard(id);
    if (c && canAfford(p.resources, c.cost)) {
      return { playerId: p.id, cards: [{ id }] };
    }
  }
  return { playerId: p.id, cards: [] };
}