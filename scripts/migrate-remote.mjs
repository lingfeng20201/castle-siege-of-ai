#!/usr/bin/env node
/**
 * 远程数据库建表：把 sql/schema.sql 应用到 DATABASE_URL 指向的 Postgres（Neon / Supabase / Aiven…）
 *
 * 用法：
 *   DATABASE_URL='postgres://...' node scripts/migrate-remote.mjs
 *   node scripts/migrate-remote.mjs 'postgres://...'          # 也可用第一个参数传
 *
 * 特性：可重复执行（schema.sql 已用 IF NOT EXISTS）；完成后打印表清单自检。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const url = process.argv[2] || process.env.DATABASE_URL;
if (!url) {
  console.error('缺少连接串：请设置 DATABASE_URL 或作为第一个参数传入');
  process.exit(1);
}

const sqlPath = join(__dirname, '..', 'sql', 'schema.sql');
const sql = readFileSync(sqlPath, 'utf8');

const client = new pg.Client({
  connectionString: url,
  // Neon / 大多数云 Postgres 需要 TLS；本地 PGlite 桥不需要
  ssl: /sslmode=require|neon\.tech|supabase\.co|aivencloud\.com/.test(url)
    ? { rejectUnauthorized: false }
    : undefined,
});

const t0 = Date.now();
try {
  await client.connect();
  const who = await client.query('select current_database() db, version() v');
  console.log('已连接：', who.rows[0].db, '·', String(who.rows[0].v).split(' ').slice(0, 2).join(' '));

  await client.query(sql);
  console.log(`schema.sql 执行完成（${Date.now() - t0}ms）`);

  const tables = await client.query(
    `select table_name from information_schema.tables
     where table_schema = 'public' order by table_name`,
  );
  const idx = await client.query(
    `select indexname from pg_indexes where schemaname = 'public' order by indexname`,
  );
  console.log('表：', tables.rows.map((r) => r.table_name).join(', ') || '(空)');
  console.log('索引：', idx.rows.map((r) => r.indexname).join(', ') || '(空)');
  console.log('MIGRATE_OK');
} catch (e) {
  console.error('MIGRATE_FAIL:', e.message);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
