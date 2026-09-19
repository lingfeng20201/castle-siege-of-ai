#!/usr/bin/env node
/**
 * 手动回归脚本：验证 coop 模式的「40 回合上限」。
 *
 * 用法：先 npm run dev:local 启动服务，再 node scripts/check-coop-turn-cap.mjs（约 1–2 分钟）。
 *
 * 做法：注册一个账号 → 用 mode=coop 连房间（coop 单人即可开局）→ 准备 → 开始
 *      → 打开 AI 托管让自己自动出牌 → 观察是否能跑到 40 回合并正常结算。
 *
 * 判定：
 *   - 收到 game:over 且 turns >= 40 且 reason 含「回合到期」 → PASS_AT_CAP（修复生效）
 *   - 更早结束（比如 BOSS 被提前打掉）→ ENDED_EARLY（未验证到上限，但不算失败）
 */
import WebSocket from 'ws';

const BASE = 'http://127.0.0.1:3000';
const PARTY = '127.0.0.1:1999';
const H = { 'Content-Type': 'application/json', Origin: BASE, 'Sec-Fetch-Site': 'same-origin' };
const stamp = String(Date.now()).slice(-6);
const email = `1${stamp}000@qq.com`;
const username = `c${stamp}`;
const roomId = `coop-${stamp}`;
let cookie = '';

async function post(p, body) {
  const r = await fetch(BASE + p, {
    method: 'POST',
    headers: { ...H, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
  const setC = r.headers.getSetCookie?.() ?? [];
  if (setC.length) cookie = setC.map((c) => c.split(';')[0]).join('; ');
  return { status: r.status, json: await r.json().catch(() => null) };
}

const sc = await post('/api/auth/send-code', { email });
if (!sc.json?.devCode) {
  console.log('拿不到 devCode');
  process.exit(2);
}
await post('/api/auth/register', { username, email, password: 'Test12345', code: sc.json.devCode });
const tr = await fetch(BASE + '/api/party-ticket', { headers: { ...H, cookie } });
const ticket = (await tr.json()).ticket;
console.log(`账号 ${username} 就绪，连接 coop 房间 ${roomId}`);

const ws = new WebSocket(`ws://${PARTY}/parties/main/${roomId}?ticket=${encodeURIComponent(ticket)}&mode=coop`);
let started = false;
let autoOn = false;
let lastTurn = 0;
let report = null;

const done = new Promise((resolve) => {
  const timer = setTimeout(() => resolve('timeout'), 200_000);
  ws.on('open', () => console.log('✔ 已连接'));
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.t === 'hello') {
      ws.send(JSON.stringify({ t: 'player:ready', ready: true }));
      return;
    }
    if (m.t === 'room:state') {
      const s = m.snapshot;
      if (s.status === 'waiting' && !started && s.hostId) {
        started = true;
        console.log(`开始对局（人数 ${s.players?.length ?? 0}）`);
        ws.send(JSON.stringify({ t: 'cmd:start' }));
      }
      if (s.status === 'running' && !autoOn) {
        autoOn = true;
        console.log('已开启 AI 托管');
        ws.send(JSON.stringify({ t: 'action:auto', enabled: true }));
      }
      return;
    }
    if (m.t === 'turn:start') {
      lastTurn = m.turn;
      if (m.turn % 5 === 0) console.log(`  … 第 ${m.turn} 回合`);
      return;
    }
    if (m.t === 'game:over') {
      report = m.report;
      clearTimeout(timer);
      resolve('over');
      return;
    }
    if (m.t === 'error' && m.code !== 'NOT_READY') console.log(`  ⚠ ${m.code} ${m.message}`);
  });
  ws.on('error', (e) => {
    console.log('✘', e.message);
    clearTimeout(timer);
    resolve('error');
  });
});

const outcome = await done;
ws.close();
console.log(`\n结果：${outcome}，最后回合 ${lastTurn}`);
if (report) {
  console.log(
    `结算：${report.turns} 回合 · 胜者 ${report.winnerName ?? '—'} · 原因 ${report.reason}`,
  );
  console.log('排名：', JSON.stringify(report.ranking));
  const atCap = report.turns >= 40 && /回合到期/.test(report.reason);
  console.log(atCap ? '\nCOOP_TEST_PASS_AT_CAP' : '\nCOOP_TEST_ENDED_EARLY');
  process.exit(atCap ? 0 : 3);
}
console.log('\nCOOP_TEST_FAIL(未收到 game:over)');
process.exit(1);