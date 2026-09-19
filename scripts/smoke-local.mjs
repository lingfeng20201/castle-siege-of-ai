#!/usr/bin/env node
/**
 * scripts/smoke-local.mjs —— 本地全链路冒烟测试
 *
 * 覆盖：注册验证码（本地 dev 模式返回 devCode）→ 注册 → 会话说 Cookie → 领 PartyKit 票据
 *       → WebSocket 连房间 → 收到 hello / room:state → 发 player:ready 看状态推进
 *
 * 用法：node scripts/smoke-local.mjs
 */
import WebSocket from 'ws';

const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:3000';
const PARTY = process.env.SMOKE_PARTY_HOST || '127.0.0.1:1999';
const stamp = String(Date.now()).slice(-6);
const email = `1${stamp}000@qq.com`;
const username = `t${stamp}`;
const password = 'Test12345';
const roomId = `smoke-${stamp}`;

const H = { 'Content-Type': 'application/json', Origin: BASE, 'Sec-Fetch-Site': 'same-origin' };
let cookie = '';

const post = async (p, body) => {
  const r = await fetch(BASE + p, { method: 'POST', headers: { ...H, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  const setC = r.headers.getSetCookie?.() ?? [];
  if (setC.length) cookie = setC.map((c) => c.split(';')[0]).join('; ');
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON */
  }
  return { status: r.status, json, text };
};

const step = (n, msg) => console.log(`\n[${n}] ${msg}`);

/* 1. 发验证码 */
step(1, `发送验证码 → ${email}`);
const sc = await post('/api/auth/send-code', { email });
console.log('   status =', sc.status, ' body =', JSON.stringify(sc.json));
const devCode = sc.json?.devCode;
if (!devCode) {
  console.log('   ⚠️ 未拿到 devCode（说明配置了真实 QQ SMTP，或未开 MAIL_DEV_LOG）');
  process.exit(2);
}

/* 2. 注册 */
step(2, `注册 ${username}`);
const reg = await post('/api/auth/register', { username, email, password, code: devCode });
console.log('   status =', reg.status, ' body =', JSON.stringify(reg.json).slice(0, 200));
console.log('   cookie =', cookie ? cookie.slice(0, 40) + '…' : '(无)');
if (!cookie) process.exit(3);

/* 3. 领票据 */
step(3, '领取 PartyKit 票据 GET /api/party-ticket');
const tr = await fetch(BASE + '/api/party-ticket', { headers: { ...H, cookie } });
const tj = await tr.json().catch(() => ({}));
console.log('   status =', tr.status, ' ticket =', tj.ticket ? tj.ticket.slice(0, 24) + '…' : JSON.stringify(tj));
if (!tj.ticket) process.exit(4);

/* 4. 连房间 */
step(4, `WebSocket 连接房间 ${roomId}（mode=ffa）`);
const url = `ws://${PARTY}/parties/main/${roomId}?ticket=${encodeURIComponent(tj.ticket)}&mode=ffa`;
const got = [];
const ws = new WebSocket(url);
const done = new Promise((res) => {
  const t = setTimeout(() => res('timeout'), 15000);
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    got.push(m.t);
    console.log(`   ← ${m.t}${m.t === 'hello' ? ' you=' + (m.you ? m.you.nickname : 'null') : ''}`);
    if (m.t === 'room:state') console.log(`     snapshot: status=${m.snapshot?.status} players=${m.snapshot?.players?.length ?? 0} host=${m.snapshot?.hostId ?? '?'}`);
    if (got.includes('hello') && got.filter((x) => x === 'room:state').length >= 2) {
      clearTimeout(t);
      res('ok');
    }
  });
  ws.on('open', () => {
    console.log('   ✔ 已连接');
    setTimeout(() => ws.send(JSON.stringify({ t: 'player:ready', ready: true })), 400);
  });
  ws.on('error', (e) => {
    console.log('   ✘ 连接错误:', e.message);
    clearTimeout(t);
    res('error');
  });
});
const outcome = await done;
console.log('   outcome =', outcome, ' events =', got.join(','));
ws.close();

/* 5. 大厅接口 */
step(5, '大厅列表 GET /api/lobby');
const lr = await fetch(BASE + '/api/lobby', { headers: { ...H, cookie } });
console.log('   status =', lr.status, ' body =', (await lr.text()).slice(0, 200));

console.log('\n===== 冒烟测试结束 =====');
process.exit(outcome === 'ok' ? 0 : 5);