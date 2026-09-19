#!/usr/bin/env node
/**
 * scripts/check-battlefield.mjs —— 横版战场渲染自检（无需浏览器）
 *
 * 把 components/Battlefield.tsx 用 esbuild 打包成临时 ESM，
 * 用 react-dom/server 渲染带真实编制（troops）的战场，断言：
 * 小兵数量 = 编制数量、四种兵种各有动作类、敌方镜像、兵力摘要、迷雾、陷落置灰等。
 *
 * 用法：node scripts/check-battlefield.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';

const BUNDLE = new URL('./.bf.bundle.mjs', import.meta.url).pathname;

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

/* 打包（react 保持 external，避免双实例 hook 报错） */
execFileSync(
  './node_modules/.bin/esbuild',
  [
    'components/Battlefield.tsx',
    '--bundle',
    '--format=esm',
    `--outfile=${BUNDLE}`,
    '--external:react',
    '--external:react-dom',
    '--external:react/jsx-runtime',
    '--alias:@=./',
    '--loader:.tsx=tsx',
    '--jsx=automatic',
    '--log-level=warning',
  ],
  { stdio: ['ignore', 'ignore', 'stderr'] },
);

const { default: Battlefield } = await import(BUNDLE);

/* ── 造数据 ── */
const troops = (sword, archer, spear, giant) => ({ sword, archer, spear, giant });

const mk = (id, nickname, team, hp, eliminated, t) => ({
  id,
  nickname,
  team,
  isAI: false,
  aiMode: 'auto',
  providerId: null,
  providerName: null,
  modelName: null,
  resources: { gold: 10, wood: 5, intel: 2 },
  troops: t,
  hand: [],
  handCount: 0,
  castle: {
    keep: { hp, maxHp: 100, shield: 0 },
    outerWall: { hp: 40, maxHp: 60, armor: 0 },
    innerWall: { hp: 30, maxHp: 40, armor: 0 },
    towers: [],
    farm: { goldPerTurn: 5, woodPerTurn: 3 },
    barracks: { repairPerTurn: 5 },
    eliminated,
  },
  status: {
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
  },
  online: true,
  ready: true,
  isHost: false,
  submission: null,
});

const players = [
  mk('me', '我方指挥官', 'solo', 82, false, troops(2, 1, 1, 1)),
  mk('foe', '敌方指挥官', 'solo', 47, false, troops(1, 0, 0, 2)),
  mk('dead', '陷落者', 'solo', 0, true, troops(0, 0, 0, 0)),
];

const render = (selectedTargetId, phase, fog, events = []) =>
  renderToStaticMarkup(
    React.createElement(Battlefield, {
      players,
      mode: 'ffa',
      meId: 'me',
      turn: 3,
      maxTurns: 40,
      phase,
      fog,
      events,
      selectedTargetId,
      onSelectTarget: () => {},
    }),
  );

const html = render('foe', 'decide', true);
const count = (needle) => html.split(needle).length - 1;

/* ── 断言：结构 ── */
ok('状态条（回合/存活）', html.includes('回合 3/40') && html.includes('存活 2'));
ok('战线概览 3 个 chip + 陷落标记', count('已陷落') === 1 && html.includes('我方指挥官') && html.includes('敌方指挥官'));
ok('我方要塞血条 82%', html.includes('width:82%'));
ok('敌方要塞血条 47%', html.includes('width:47%'));
ok('兵力摘要显示兵种图标', html.includes('🗡️') && html.includes('🗿'));

/* ── 断言：小兵数量 = 编制（含 2 名剑士等） ── */
ok('剑士合计 3 名（我方 2 + 敌方 1）', count('csai-slash') === 3, `slash=${count('csai-slash')}`);
ok('我方弓手 1 名', count('csai-draw') === 1, `draw=${count('csai-draw')}`);
ok('我方矛兵 1 名', count('csai-thrust') === 1, `thrust=${count('csai-thrust')}`);
ok('巨人合计 3 名（我方 1 + 敌方 2）', count('csai-stomp') === 3, `stomp=${count('csai-stomp')}`);
ok('敌方单位整体镜像', count('scale-x-[-1]') === 3, `mirror=${count('scale-x-[-1]')}`);
ok('每个小兵带血条', count('h-0.5 w-5') === 8, `bars=${count('h-0.5 w-5')}`);
ok('动效走 GPU 友好类', count('csai-anim') >= 8, `anim=${count('csai-anim')}`);

/* ── 断言：状态演出 ── */
ok('迷雾遮罩（无 backdrop-blur）', html.includes('bg-ink/50') && !html.includes('backdrop-blur'));
ok('decide 阶段有交战火花', count('animate-spark') === 3);
ok('没有「等待双方入场」占位', !html.includes('等待双方入场'));
ok('陷落玩家 chip 置灰', html.includes('#3a465c'));
ok('无事件时不误渲染弹道', count('animate-bolt-') === 0);

/* ── 断言：陷落目标要塞置灰 + waiting 不闪火花 ── */
const htmlDead = render('dead', 'waiting', false);
ok('已陷落要塞置灰', htmlDead.includes('grayscale'));
ok('waiting 阶段不闪火花', !htmlDead.includes('animate-spark'));

/* ── 断言：事件驱动（纯函数 deriveMarks，SSR 不会跑 useEffect，故直接单测） ── */
const { deriveMarks } = await import(BUNDLE);
const events = [
  { type: 'troop:recruited', playerId: 'me', troop: 'sword', count: 1, total: 7 },
  { type: 'troop:clash', attackerId: 'me', defenderId: 'foe', attackerLoss: 2, defenderLoss: 3, damage: 6, attackerRemain: 5, defenderRemain: 1 },
  { type: 'card:played', playerId: 'me', cardId: 'wall_cracker', targets: ['foe'] },
  { type: 'castle:hit', playerId: 'foe', layer: 'outer', damage: 6, hpLeft: 34 },
];
const m = deriveMarks(events, 'me', 'foe');
ok('征兵事件归到「我方」', m.recruits.some((r) => r.side === 'mine' && r.count === 1));
ok('交锋损失：我军 -2 / 敌军 -3', !!m.clash && m.clash.mineLoss === 2 && m.clash.foeLoss === 3);
ok('推进伤害 6 且被打的是敌方', !!m.clash && m.clash.damage === 6 && m.clash.loser === 'foe');
ok('技能卡弹道方向为右（我方打敌方）', m.casts.length === 1 && m.casts[0].dir === 'r');
ok('敌方要塞收到受击标记 -6', !!m.hits.foe && m.hits.foe.dmg === 6);

/* 反向事件：敌方打我方 → 弹道朝左 */
const m2 = deriveMarks(
  [{ type: 'card:played', playerId: 'foe', cardId: 'flood', targets: ['me'] }],
  'me',
  'foe',
);
ok('敌方攻击时弹道朝左', m2.casts.length === 1 && m2.casts[0].dir === 'l');

/* 无关玩家的事件不应产生标记 */
const m3 = deriveMarks([{ type: 'card:played', playerId: 'dead', cardId: 'flood', targets: ['foe'] }], 'me', 'foe');
ok('第三方事件不产生弹道/标记', m3.casts.length === 0 && !m3.clash);

if (existsSync(BUNDLE)) rmSync(BUNDLE);

console.log(`\n${pass} passed / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);