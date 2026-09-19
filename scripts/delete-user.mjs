/**
 * scripts/delete-user.mjs —— 删除指定邮箱的账号（仅本地运维用）
 *
 * 用法：
 *   node scripts/delete-user.mjs                 # 只列出全部账号
 *   node scripts/delete-user.mjs <email>         # 删除该邮箱的账号（级联删除 BYOK 配置与用量）
 *
 * 依赖 /root/castle-siege-of-ai/.env.local 里的 DATABASE_URL。
 */
import fs from 'node:fs';
import pg from 'pg';

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

const target = process.argv[2];
const { Client } = pg;
const c = new Client({ connectionString: env.DATABASE_URL });
await c.connect();

const list = await c.query(
  'SELECT username, email, created_at FROM users ORDER BY created_at ASC',
);
console.log(`当前账号 ${list.rowCount} 个：`);
for (const r of list.rows) {
  console.log(`  - ${r.username} <${r.email}>  ${r.created_at.toISOString()}`);
}

if (target) {
  const del = await c.query('DELETE FROM users WHERE email = $1 RETURNING username, email', [target]);
  await c.query('DELETE FROM email_codes WHERE email = $1', [target]);
  if (del.rowCount === 0) {
    console.log(`\n未找到邮箱 ${target} 的账号，未做任何删除。`);
  } else {
    console.log(`\n已删除：${del.rows[0].username} <${del.rows[0].email}>（BYOK 配置与用量已级联删除）`);
  }
  const after = await c.query('SELECT count(*)::int AS n FROM users');
  console.log(`剩余账号：${after.rows[0].n} 个`);
}

await c.end();