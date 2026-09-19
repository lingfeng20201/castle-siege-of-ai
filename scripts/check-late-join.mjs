#!/usr/bin/env node
/**
 * scripts/check-late-join.mjs —— 验证「对局中可自由加入」
 *
 * 流程：注册 A/B/C → A 建房 → A、B 准备 → A 开局（running）→ C 在对局中加入
 * 断言：C 连接后收到 status=running 的快照，且日志里出现「中途杀入战场」
 *      （说明服务端真的把 C 建进了 seats + state.players，而不是被降级成观众）
 *
 * 满员拦截（seats.size >= maxPlayers → 只能当观众）走的是原有分支，未在此脚本覆盖。
 * 用法：node scripts/check-late-join.mjs
 */
import WebSocket from 'ws';

const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:3000';
const PARTY = process.env.SMOKE_PARTY_HOST || '127.0.0.1:1999';
const stamp = String(Date.now()).slice(-6);
const roomId = `late-${stamp}`;
const password = 'Test12345';
const H = { 'Content-Type': 'application/json', Origin: BASE, 'Sec-Fetch-Site': 'same-origin' };

let pass = 0;
let fail = 0;
const ok = (name, cond) => {
  cond ? (pass += 1) : (fail += 1);
  console.log(`${cond ? '✔' : '✘'} ${name}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await wait(250);
  }
  return false;
}

/** 注册一个用户，返回 { cookie, username } */
async function register(tag) {
  const email = `1${stamp}${tag}0@qq.com`;
  const username = `u${stamp}${tag}`;
  let cookie = '';
  const post = async (p, body) => {
    const r = await fetch(BASE + p, {
      method: 'POST',
      headers: { ...H, ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });
    const setC = r.headers.getSetCookie?.() ?? [];
    if (setC.length) cookie = setC.map((c) => c.split(';')[0]).join('; ');
    const text = await r.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* 非 JSON */
    }
    return { status: r.status, json };
  };
  const sc = await post('/api/auth/send-code', { email });
  const devCode = sc.json?.devCode;
  if (!devCode) throw new Error('未拿到 devCode：本地需要 MAIL_DEV_LOG=true 且未配置 QQ SMTP');
  const reg = await post('/api/auth/register', { username, email, password, code: devCode });
  if (!cookie) throw new Error(`注册失败：${reg.status} ${JSON.stringify(reg.json)}`);
  return { cookie, username };
}

async function ticket(cookie) {
  const r = await fetch(BASE + '/api/party-ticket', { headers: { ...H, cookie } });
  const j = await r.json();
  if (!j.ticket) throw new Error(`取票失败：${JSON.stringify(j)}`);
  return j.ticket;
}

/** 连接房间，收集 room:state 快照 */
function connect(tk) {
  const url = `ws://${PARTY}/parties/main/${roomId}?ticket=${encodeURIComponent(tk)}&mode=ffa`;
  const ws = new WebSocket(url);
  const st = { ws, snapshots: [], last: null };
  ws.on('message', (d) => {
    let m;
    try {
      m = JSON.parse(d.toString());
    } catch {
      return;
    }
    if (m.t === 'room:state') {
      st.last = m.snapshot;
      st.snapshots.push(m.snapshot);
    }
  });
  return st;
}

const [ua, ub, uc] = await Promise.all([register(1), register(2), register(3)]);
const [ta, tb, tc] = await Promise.all([ticket(ua.cookie), ticket(ub.cookie), ticket(uc.cookie)]);

const A = connect(ta);
ok('A 连接房间', await waitFor(() => A.snapshots.length >= 1));
A.ws.send(JSON.stringify({ t: 'player:ready', ready: true }));

const B = connect(tb);
ok('B 连接房间', await waitFor(() => B.snapshots.length >= 1));
B.ws.send(JSON.stringify({ t: 'player:ready', ready: true }));
await wait(600);

A.ws.send(JSON.stringify({ t: 'cmd:start' }));
ok('A 开局成功（status=running）', await waitFor(() => A.snapshots.some((s) => s.status === 'running')));
ok('开局时仅 2 名席位', (A.last?.players?.length ?? 0) === 2);

/* ── 关键：对局进行中 C 加入 ── */
const C = connect(tc);
const gotRunning = await waitFor(() => C.snapshots.some((s) => s.status === 'running'));
ok('C 在 running 状态连上房间', gotRunning);
await wait(600);

const snap = C.last;
ok('C 的席位被计入（3 席）', (snap?.players?.length ?? 0) === 3);
ok(
  'C 有可参战的城堡',
  !!snap?.players?.find((p) => p.nickname === uc.username)?.castle?.outerWall?.hp,
);
ok(
  '服务端日志出现「中途杀入战场」',
  (snap?.logs ?? []).some((l) => String(l.text).includes('中途杀入战场')),
);
ok('C 不是观众（ spectatorCount 不含自己）', (snap?.spectatorCount ?? 1) === 0);

A.ws.close();
B.ws.close();
C.ws.close();
await wait(300);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);