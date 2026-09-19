import { Pool, type QueryResultRow } from 'pg';
import { logger } from './logger';

/**
 * lib/db.ts —— Postgres 连接池（Supabase / Neon 兼容）
 * 开发环境下热重载复用同一实例，避免连接数爆炸。
 */

const globalRef = globalThis as unknown as { __csaiPool?: Pool };

export function db(): Pool {
  if (globalRef.__csaiPool) return globalRef.__csaiPool;

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL 未配置');

  const needsSsl = /sslmode=require|neon|supabase|render\.com|aws/.test(url);
  const pool = new Pool({
    connectionString: url,
    max: 8,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
  });
  pool.on('error', (err) => logger.warn('pg pool error', { message: err.message }));

  globalRef.__csaiPool = pool;
  return pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await db().query<T>(text, params as never[]);
  return res.rows;
}