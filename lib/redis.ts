import Redis from 'ioredis';
import { logger } from './logger';

/**
 * lib/redis.ts —— Redis 客户端 + 固定窗口限流
 */

const globalRef = globalThis as unknown as { __csaiRedis?: Redis };

export function redis(): Redis {
  if (globalRef.__csaiRedis) return globalRef.__csaiRedis;

  const url = process.env.REDIS_URL;
  if (!url) throw new Error('REDIS_URL 未配置');

  const client = new Redis(url, { maxRetriesPerRequest: 2 });
  client.on('error', (err) => logger.warn('redis error', { message: err.message }));

  globalRef.__csaiRedis = client;
  return client;
}

/** 固定窗口限流：INCR + EXPIRE，返回是否放行与剩余时间 */
export async function rateLimit(
  key: string,
  limit: number,
  windowSec: number,
): Promise<{ allowed: boolean; count: number; ttl: number }> {
  const c = redis();
  const count = await c.incr(key);
  if (count === 1) await c.expire(key, windowSec);
  const ttl = await c.ttl(key);
  return { allowed: count <= limit, count, ttl: Math.max(ttl, 1) };
}