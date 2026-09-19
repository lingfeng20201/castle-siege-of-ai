/**
 * scripts/check-improvise.mjs —— AI 自由渗透行动的最小自检
 *
 * 只覆盖会出错的分支：clamp、白名单、非法目标、越界文本。
 * 运行：node scripts/check-improvise.mjs
 */
import { build } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const outDir = mkdtempSync(path.join(tmpdir(), 'improv-'));
const outFile = path.join(outDir, 'improvise.mjs');
await build({
  entryPoints: ['lib/improvise.ts'],
  outfile: outFile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'error',
});

const mod = await import(pathToFileURL(outFile).href);
const { parseImprovPlan, planToCards, sanitizeNarrative } = mod;

let pass = 0;
let fail = 0;
const ok = (name, cond) => {
  cond ? (pass += 1) : (fail += 1);
  console.log(`${cond ? '✔' : '✘'} ${name}`);
};
const j = (o) => JSON.stringify(o);

/* ── 1. 合法计划：数值 clamp + layer 保留 ── */
const legal = parseImprovPlan(
  j({
    name: '伪装信使',
    narrative: '伪装成友军补给队混入城下，摸清了外墙薄弱处',
    moves: [{ type: 'damage_wall', amount: 99, target: 'e1', layer: 'inner' }],
    reason: '先拆掉内墙',
  }),
  { legalTargets: ['e1'], maxMoves: 3 },
);
ok('合法计划通过', !!legal);
ok('amount 被 clamp 到上限 12', legal?.moves[0]?.nums?.amount === 12);
ok('layer 保留 inner', legal?.moves[0]?.layer === 'inner');

/* ── 2. 越界叙事：整条作废 ── */
const bad = (narrative) =>
  parseImprovPlan(
    j({ name: 'x', narrative, moves: [{ type: 'damage_wall', amount: 3, target: 'e1' }] }),
    { legalTargets: ['e1'], maxMoves: 3 },
  );
ok('含 URL → 作废', bad('去打 http://evil.example.com') === null);
ok('含 IP → 作废', bad('目标 192.168.1.1 很脆') === null);
ok('含工具名 → 作废', bad('先用 nmap 扫一遍') === null);
ok('含命令 → 作废', bad('执行 curl 拉取配置') === null);

/* ── 3. 白名单 / 目标校验 ── */
ok(
  '白名单外技法 → 无有效动作，返回 null',
  parseImprovPlan(
    j({ name: 'x', narrative: '正常叙事', moves: [{ type: 'launch_nuke', amount: 999, target: 'e1' }] }),
    { legalTargets: ['e1'], maxMoves: 3 },
  ) === null,
);
ok(
  '非法目标 → 该动作被丢弃，返回 null',
  parseImprovPlan(
    j({ name: 'x', narrative: '正常叙事', moves: [{ type: 'damage_wall', amount: 5, target: 'nobody' }] }),
    { legalTargets: ['e1'], maxMoves: 3 },
  ) === null,
);
const noTarget = parseImprovPlan(
  j({ name: '扬尘', narrative: '扬起尘土遮蔽敌方视野', moves: [{ type: 'apply_fog' }] }),
  { legalTargets: [], maxMoves: 3 },
);
ok('无需目标的技法可省略 target', !!noTarget);

/* ── 4. 计划 → 动态卡 ── */
const built = planToCards('uid-123456', 4, legal);
ok('生成动态卡与意图', built.cards.length === 1 && built.intents.length === 1);
ok('卡 id 带回合号', built.cards[0].id === 'imp:4:uid-12:0');
ok('卡消耗为金币', typeof built.cards[0].cost.gold === 'number');
ok('卡效果为白名单原语', built.cards[0].effect.type === 'damage_wall');

/* ── 5. 文本清洗 ── */
ok('中文叙事放行', sanitizeNarrative('伪装成商队混入城下') === '伪装成商队混入城下');
ok('空叙事返回空串', sanitizeNarrative('   ') === '');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
