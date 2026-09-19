#!/usr/bin/env node
/**
 * scripts/check-troops.mjs —— 常备军（小兵真打）引擎自检
 *
 * 覆盖：征兵、兵种克制、编制上限、交战损失、部队推进拆墙、每回合自动补员、
 *       40 回合整局回归（不抛异常 / 状态不崩）。
 *
 * 用法：node scripts/check-troops.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';

const ENTRY = new URL('./.troops-entry.ts', import.meta.url).pathname;
const BUNDLE = new URL('./.troops.bundle.mjs', import.meta.url).pathname;

writeFileSync(
  ENTRY,
  [
    "export * from '../lib/engine';",
    "export * from '../lib/troops';",
    "export * from '../lib/cards';",
    '',
  ].join('\n'),
);

execFileSync(
  './node_modules/.bin/esbuild',
  [ENTRY, '--bundle', '--format=esm', '--platform=node', `--outfile=${BUNDLE}`, '--log-level=warning'],
  { stdio: ['ignore', 'ignore', 'inherit'] },
);

const E = await import(BUNDLE);

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass += 1;
    console.log(`✔ ${name}`);
  } else {
    fail += 1;
    console.log(`✘ ${name} ${extra}`);
  }
};

/* 固定随机源：让测试可复现（0.5 恒定） */
const rng = () => 0.5;

function room(ids, mode = 'ffa') {
  const players = {};
  for (const id of ids) players[id] = E.createEnginePlayer({ id, nickname: id.toUpperCase(), team: 'solo' }, rng);
  return { mode, turn: 1, players, alliances: [], lurkers: [] };
}

/* ── 1. 招募 ── */
{
  const S = room(['a', 'b']);
  S.players.a.hand = ['recruit_sword'];
  const out = E.resolveTurn(S, [{ playerId: 'a', cards: [{ id: 'recruit_sword' }] }], rng);
  ok('兵营牌能征募剑士', out.state.players.a.troops.sword === 1, JSON.stringify(out.state.players.a.troops));
  ok('产出 troop:recruited 事件', out.events.some((e) => e.type === 'troop:recruited' && e.playerId === 'a'));
  ok('征募消耗资源', out.state.players.a.resources.gold === 15 - 1, String(out.state.players.a.resources.gold));
}

/* ── 2. 编制上限 ── */
{
  const t = E.emptyTroops();
  E.addTroops(t, 'giant', 99);
  ok('单兵种上限 6', t.giant === 6, String(t.giant));
  E.addTroops(t, 'sword', 99);
  ok('总兵力上限 12', E.totalTroops(t) === 12, String(E.totalTroops(t)));
}

/* ── 3. 兵种克制：剑士克弓手 ── */
{
  const sword3 = { sword: 3, archer: 0, spear: 0, giant: 0 };
  const archer3 = { sword: 0, archer: 3, spear: 0, giant: 0 };
  const pSword = E.armyPower(sword3, archer3);
  const pArcher = E.armyPower(archer3, sword3);
  ok('剑士战力高于弓手（克制 1.5 / 0.7）', pSword > pArcher * 1.5, `${pSword} vs ${pArcher}`);

  const spear3 = { sword: 0, archer: 0, spear: 3, giant: 0 };
  ok('矛兵克制剑士', E.armyPower(spear3, sword3) > E.armyPower(sword3, spear3));
}

/* ── 4. 交锋：双方互有损失，强者推进拆墙 ── */
{
  const S = room(['a', 'b']);
  S.players.a.troops = { sword: 6, archer: 0, spear: 0, giant: 0 };
  S.players.b.troops = { sword: 0, archer: 2, spear: 0, giant: 0 };
  const wallBefore = S.players.b.castle.outerWall.hp;
  const out = E.resolveTurn(S, [], rng);

  const clash = out.events.find((e) => e.type === 'troop:clash');
  ok('产出 troop:clash 事件', !!clash);
  ok('弱势方（弓手）承受损失', (out.state.players.b.troops.archer ?? 0) < 2, JSON.stringify(out.state.players.b.troops));
  ok('强势方推进造成城墙伤害', clash && clash.damage > 0, JSON.stringify(clash));
  ok('城墙 HP 下降', out.state.players.b.castle.outerWall.hp < wallBefore);
  ok('未触发箭塔反伤（部队推进不算攻击牌）', out.events.filter((e) => e.type === 'castle:hit').length <= 1);
}

/* ── 5. 无兵 vs 有兵：有兵方零损失推进 ── */
{
  const S = room(['a', 'b']);
  S.players.a.troops = { sword: 4, archer: 0, spear: 0, giant: 0 };
  const out = E.resolveTurn(S, [], rng);
  ok('对手无兵时己方零损失', out.state.players.a.troops.sword === 4, JSON.stringify(out.state.players.a.troops));
  const clash = out.events.find((e) => e.type === 'troop:clash');
  ok('对手无兵时仍推进拆墙', clash && clash.damage > 0, JSON.stringify(clash));
}

/* ── 6. 每回合自动补员 ── */
{
  const S = room(['a', 'b']);
  const before = E.totalTroops(S.players.a.troops);
  const out = E.recoverPhase(S, rng);
  ok('恢复阶段自动补 1 名新兵', E.totalTroops(out.state.players.a.troops) === before + 1);
}

/* ── 7. 整局回归：3 人 ffa 跑满 40 回合 ── */
{
  const S = room(['a', 'b', 'c']);
  let state = E.beginTurn(S, rng).state;
  let over = false;
  let rounds = 0;
  for (let i = 0; i < 40 && !over; i += 1) {
    const plays = Object.values(state.players)
      .filter((p) => !p.eliminated)
      .map((p) => E.fallbackPlayIntent(p));
    const r1 = E.resolveTurn(state, plays, rng);
    state = r1.state;
    const r2 = E.recoverPhase(state, rng);
    state = r2.state;
    rounds += 1;
    const res = E.checkVictory(state);
    over = res.over;
    if (!over) state = E.beginTurn(state, rng).state;
  }
  ok('整局 40 回合无异常', rounds > 0);
  ok('胜负判定可收敛', over === true || state.turn >= 40);
  const totalTroopsOnField = Object.values(state.players).reduce((s, p) => s + E.totalTroops(p.troops), 0);
  ok('战场上有常备军存在（自动补员生效）', totalTroopsOnField > 0, String(totalTroopsOnField));
}

/* 清理临时文件 */
for (const f of [ENTRY, BUNDLE]) if (existsSync(f)) rmSync(f);

console.log(`\n${pass} passed / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);