#!/usr/bin/env node
/**
 * scripts/dev-pglite.mjs —— 本地开发用数据库（PGlite = WASM 版 Postgres）+ TCP 桥
 *
 * 为什么需要它：
 *   项目生产环境用标准 PostgreSQL。但在某些受限环境（如 Android proot，
 *   不支持下 shmget 系统调用）原生 PostgreSQL 无法启动；PGlite 是纯 WASM 的
 *   Postgres 16，内存/文件实现，配合本 TCP 桥可让项目的 `pg` 客户端
 *   （lib/db.ts）原样连接，行为与真实 Postgres 一致。
 *
 * 用法：
 *   node scripts/dev-pglite.mjs
 *   # 默认监听 127.0.0.1:5432，数据目录 /root/pgdata
 *   # 可用环境变量覆盖：PGLITE_DIR / PGLITE_HOST / PGLITE_PORT
 *
 * 对应的连接串（写入 .env.local）：
 *   DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres
 *
 * 注意：仅用于本地/演示开发；生产请使用 Neon / Supabase 等真实 PostgreSQL。
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

// Node 18 没有全局 CustomEvent（Node 19+ 才内置），pglite-socket 内部会用它派发事件
if (typeof globalThis.CustomEvent === 'undefined') {
  class CustomEventPolyfill extends Event {
    constructor(type, params) {
      super(type);
      this.detail = params && 'detail' in params ? params.detail : null;
    }
  }
  globalThis.CustomEvent = CustomEventPolyfill;
}

const DATA_DIR = process.env.PGLITE_DIR || '/root/pgdata';
const HOST = process.env.PGLITE_HOST || '127.0.0.1';
const PORT = Number(process.env.PGLITE_PORT || 5432);

mkdirSync(DATA_DIR, { recursive: true });

console.log('[pglite] data dir :', DATA_DIR);
const db = await PGlite.create({ dataDir: DATA_DIR });

// 初始化 schema：直接复用项目的 sql/schema.sql
// 去掉 CREATE EXTENSION —— WASM 版未内置 pgcrypto，而 PG16 的 gen_random_uuid() 已是内置函数
const schemaPath = fileURLToPath(new URL('../sql/schema.sql', import.meta.url));
const ddl = readFileSync(schemaPath, 'utf8').replace(/CREATE\s+EXTENSION[^;]*;/gi, '');
await db.exec(ddl);
console.log('[pglite] schema ensured (users / email_codes / model_providers / model_usage / matches)');

// maxConnections 要足够大：项目里 pg.Pool 会开多条连接
const server = new PGLiteSocketServer({ db, host: HOST, port: PORT, maxConnections: 20 });
await server.start();
console.log(`[pglite] listening → postgres://postgres:postgres@${HOST}:${PORT}/postgres`);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    console.log(`[pglite] ${sig} received, shutting down…`);
    try {
      await server.stop();
      await db.close();
    } finally {
      process.exit(0);
    }
  });
}
