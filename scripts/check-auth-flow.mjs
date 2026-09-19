#!/usr/bin/env node
/**
 * scripts/check-auth-flow.mjs —— 登录 / 注册 / 初始数据 / 输入框 / 按钮响应 自检
 *
 * 覆盖：
 *   1. 登录页 / 注册页可打开（200），输入框与按钮的关键属性存在（按钮默认 disabled、输入框 id / aria-label）
 *   2. 登录 API：错误密码 → 401 且模糊提示；正确密码 → 200 + 会话 Cookie
 *   3. 初始数据：带 Cookie 访问首页（大厅）200 且带用户名；未带 Cookie 被重定向到 /login
 *   4. 登出：清 Cookie
 *
 * 依赖：本地 dev server（127.0.0.1:3000）+ .env.local 的 DATABASE_URL。
 * 用法：node scripts/check-auth-flow.mjs
 */
import fs from 'node:fs';
import pg from 'pg';
import argon2 from 'argon2';

const BASE = process.env.APP_BASE || 'http://127.0.0.1:3000';

/* ── 读 .env.local ── */
const raw = fs.readFileSync('/root/castle-siege-of-ai/.env.local', 'utf8');
const env = Object.fromEntries(
  raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i), l.slice(i + 1)];
    }),
);
if (!env.DATABASE_URL) {
  console.error('DATABASE_URL 缺失');
  process.exit(1);
}

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

const rand = Math.floor(Math.random() * 900000) + 100000;
const username = `e2e${rand}`;
const email = `${rand}0000@qq.com`;
const password = 'Test12345';

const db = new pg.Client({ connectionString: env.DATABASE_URL, ssl: false });

async function cleanup() {
  try {
    await db.query('DELETE FROM email_codes WHERE email = $1', [email]);
    await db.query('DELETE FROM users WHERE email = $1', [email]);
  } catch {
    /* 忽略清理错误 */
  }
}

try {
  await db.connect();

  /* 造一个已验证用户（注册接口需要真实邮箱验证码，脚本改为直接落库，等价「邮箱已验证」状态） */
  const hash = await argon2.hash(password, { type: argon2.argon2id });
  await db.query(
    `INSERT INTO users (username, email, password_hash, avatar_seed, last_login_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, username = EXCLUDED.username`,
    [username, email, hash, 'e2e'],
  );

  /* ── 1. 页面可打开 + 输入框/按钮属性 ── */
  const loginHtml = await (await fetch(`${BASE}/login`)).text();
  ok('登录页可打开', loginHtml.includes('进入指挥中心') && loginHtml.includes('指挥官登录'));
  ok('登录页有用户名输入框', loginHtml.includes('id="ident"'));
  ok('登录页有密码输入框（可切换显示）', loginHtml.includes('id="password"') && loginHtml.includes('type="password"'));
  ok('登录按钮初始为 disabled（未填不允许提交）', /<button[^>]*disabled[^>]*>\s*进入指挥中心/.test(loginHtml));
  ok('登录页有注册入口', loginHtml.includes('注册指挥官'));

  const regHtml = await (await fetch(`${BASE}/register`)).text();
  ok('注册页可打开', regHtml.includes('创建指挥官') && regHtml.includes('完成注册 · 入驻城堡'));
  ok('注册页有 4 个输入框（用户名/邮箱/密码/确认）', ['id="username"', 'id="email"', 'id="password"', 'id="confirm"'].every((k) => regHtml.includes(k)));
  ok('注册页验证码输入框存在（aria-label）', regHtml.includes('aria-label="邮箱验证码"'));
  ok('注册页「发送验证码」按钮初始 disabled（邮箱未填）', /<button[^>]*disabled[^>]*>\s*发送验证码/.test(regHtml));
  ok('注册页提交按钮初始 disabled', /<button[^>]*disabled[^>]*>\s*完成注册/.test(regHtml));

  /* ── 2. 登录 API ── */
  const badRes = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'WrongPass123' }),
  });
  const badBody = await badRes.json();
  ok('错误密码 → 401', badRes.status === 401, `status=${badRes.status}`);
  ok('错误密码提示不泄露账号是否存在', badBody.message === '用户名或密码错误', JSON.stringify(badBody));

  const okRes = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const okBody = await okRes.json();
  const setCookie = okRes.headers.get('set-cookie') ?? '';
  ok('正确密码 → 200', okRes.status === 200 && okBody.ok === true, `status=${okRes.status}`);
  ok('下发 httpOnly 会话 Cookie', setCookie.includes('csai_session=') && /httponly/i.test(setCookie), setCookie.slice(0, 60));
  ok('返回用户信息（不含密码）', !!okBody.user?.username && !('password_hash' in (okBody.user ?? {})));

  /* 邮箱登录同样可用 */
  const emailLogin = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: email, password }),
  });
  ok('支持邮箱登录', emailLogin.status === 200);

  const cookie = setCookie.split(';')[0];

  /* ── 3. 初始数据 ── */
  const homeNoAuth = await fetch(`${BASE}/`, { redirect: 'manual' });
  const homeNoAuthText = await homeNoAuth.text();
  ok(
    '未登录访问大厅被重定向到 /login',
    homeNoAuth.status >= 300 && homeNoAuth.status < 400 ? (homeNoAuth.headers.get('location') ?? '').includes('/login') : homeNoAuthText.includes('/login'),
    `status=${homeNoAuth.status}`,
  );

  const homeRes = await fetch(`${BASE}/`, { headers: { cookie }, redirect: 'manual' });
  const homeHtml = await homeRes.text();
  ok('登录后大厅可打开（初始数据）', homeRes.status === 200, `status=${homeRes.status}`);
  ok('大厅带出当前用户名', homeHtml.includes(username), 'HTML 未包含用户名');
  ok('大厅渲染房间列表区域', homeHtml.includes('创建') || homeHtml.includes('房间'));

  const lobbyApi = await fetch(`${BASE}/api/lobby`, { headers: { cookie } });
  const lobbyBody = await lobbyApi.json().catch(() => null);
  ok('大厅接口返回初始房间列表', lobbyApi.status === 200 && Array.isArray(lobbyBody?.rooms ?? lobbyBody), `status=${lobbyApi.status}`);

  /* ── 4. 登出 ── */
  const outRes = await fetch(`${BASE}/api/auth/logout`, { method: 'POST', headers: { cookie } });
  ok('登出成功', outRes.status === 200, `status=${outRes.status}`);
  const outCookie = outRes.headers.get('set-cookie') ?? '';
  ok('登出清空会话 Cookie', /csai_session=;|csai_session=(?:;|,)|Max-Age=0/i.test(outCookie), outCookie.slice(0, 60));
} catch (e) {
  fail += 1;
  console.log(`✘ 脚本异常：${e.message}`);
} finally {
  await cleanup();
  await db.end().catch(() => {});
}

console.log(`\n${pass} passed / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);