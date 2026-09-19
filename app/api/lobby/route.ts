import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';
import type { LobbyRoom } from '@/lib/protocol';

export const runtime = 'nodejs';

const STALE_MS = 90_000;

/**
 * GET /api/lobby —— 大厅房间列表
 *
 * 战斗房通过内部桥接 API（/api/internal/party，lobby.upsert）定期上报心跳，
 * 这里从 Redis 读取并剔除 90 秒未心跳的僵尸房间。
 */
export async function GET() {
  const r = redis();
  const all = await r.hgetall('csai:lobby');
  const now = Date.now();
  const rooms: Array<LobbyRoom & { updatedAt: number }> = [];
  const stale: string[] = [];

  for (const [id, raw] of Object.entries(all)) {
    try {
      const obj = JSON.parse(raw) as LobbyRoom & { updatedAt: number };
      if (now - (obj.updatedAt ?? 0) > STALE_MS) {
        stale.push(id);
        continue;
      }
      rooms.push(obj);
    } catch {
      stale.push(id);
    }
  }

  if (stale.length > 0) {
    try {
      await r.hdel('csai:lobby', ...stale);
    } catch {
      // 忽略清理失败
    }
  }

  rooms.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return NextResponse.json({ rooms });
}