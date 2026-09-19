import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { decryptSecret } from '@/lib/crypto';
import { query } from '@/lib/db';
import { recordUsage } from '@/lib/llm';
import { redis } from '@/lib/redis';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

/**
 * POST /api/internal/party —— 内部桥接 API（仅限 PartyKit 房间服务器调用）
 *
 * 认证：Authorization: Bearer <INTERNAL_API_KEY>（或 x-internal-key）
 *
 * 动作：
 * - provider.get   取用户模型配置（含解密后的 Key，仅内存转发，绝不落日志）
 * - usage.add      写入模型用量（commander / judge / report）
 * - match.save     保存对局存档
 * - lobby.upsert   房间心跳上报（Redis，供大厅列表）
 * - lobby.remove   房间下线
 */

let warnedMissingKey = false;

function authorized(req: NextRequest): boolean {
  const expected = process.env.INTERNAL_API_KEY;
  if (!expected) {
    if (!warnedMissingKey) {
      logger.error('internal: INTERNAL_API_KEY 未配置，内部 API 拒绝所有请求');
      warnedMissingKey = true;
    }
    return false;
  }
  const raw = req.headers.get('authorization') ?? '';
  const token = raw.startsWith('Bearer ') ? raw.slice(7).trim() : (req.headers.get('x-internal-key') ?? '');
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

const Envelope = z.object({
  action: z.enum(['provider.get', 'usage.add', 'match.save', 'lobby.upsert', 'lobby.remove']),
  payload: z.record(z.string(), z.unknown()).default({}),
});

export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ code: 'FORBIDDEN', message: '无效的内部密钥' }, { status: 403 });
  }

  let body: z.infer<typeof Envelope>;
  try {
    body = Envelope.parse(await req.json());
  } catch {
    return NextResponse.json({ code: 'INVALID_INPUT', message: '参数不合法' }, { status: 400 });
  }

  try {
    switch (body.action) {
      case 'provider.get':
        return await handleProviderGet(body.payload);
      case 'usage.add':
        return await handleUsageAdd(body.payload);
      case 'match.save':
        return await handleMatchSave(body.payload);
      case 'lobby.upsert':
        return await handleLobbyUpsert(body.payload);
      case 'lobby.remove':
        return await handleLobbyRemove(body.payload);
    }
  } catch (e) {
    logger.error('internal: action failed', { action: body.action, message: (e as Error).message });
    return NextResponse.json({ code: 'SERVER_ERROR', message: '内部操作失败' }, { status: 500 });
  }
  return NextResponse.json({ code: 'UNKNOWN_ACTION' }, { status: 400 });
}

/* ────────────────────── 各动作实现 ────────────────────── */

type ProviderRow = {
  id: string;
  provider_type: string;
  base_url: string;
  model_name: string;
  api_key_enc: string;
  api_key_iv: string;
  api_key_tag: string;
  extra_headers: Record<string, string> | null;
  params: Record<string, unknown> | null;
};

async function handleProviderGet(payload: Record<string, unknown>) {
  const userId = String(payload.userId ?? '');
  const providerId =
    typeof payload.providerId === 'string' && payload.providerId ? payload.providerId : null;
  if (!userId) {
    return NextResponse.json({ code: 'INVALID_INPUT', message: '缺少 userId' }, { status: 400 });
  }

  const cols = `id, provider_type, base_url, model_name, api_key_enc, api_key_iv, api_key_tag, extra_headers, params`;
  let rows: ProviderRow[] = [];
  if (providerId) {
    rows = await query<ProviderRow>(
      `SELECT ${cols} FROM model_providers WHERE id = $1 AND user_id = $2 AND enabled = true`,
      [providerId, userId],
    );
  }
  if (rows.length === 0) {
    rows = await query<ProviderRow>(
      `SELECT ${cols} FROM model_providers
       WHERE user_id = $1 AND enabled = true
       ORDER BY is_default DESC, created_at ASC LIMIT 1`,
      [userId],
    );
  }
  if (rows.length === 0) {
    // ── 系统兜底（可选）：部署者提供公共模型，DEFAULT_MODEL_KEY 留空则关闭 ──
    // 用途：演示部署 / 自建环境，让尚未配置 BYOK 的玩家也能体验「AI 指挥官」。
    // 注意：启用后未配置模型的用户会消耗部署者的模型额度，请勿在公开生产环境随意开启。
    const fbKey = process.env.DEFAULT_MODEL_KEY;
    const fbUrl = process.env.DEFAULT_MODEL_BASE_URL;
    if (fbKey && fbUrl) {
      return NextResponse.json({
        provider: {
          id: null, // 系统兜底没有具体配置记录；用量仍记到用户名下（provider_id 为 NULL）
          providerType: 'custom',
          baseUrl: fbUrl,
          modelName: process.env.DEFAULT_MODEL_NAME || 'deepseek-chat',
          apiKey: fbKey,
          extraHeaders: {},
          params: {},
          isSystemDefault: true,
        },
      });
    }
    return NextResponse.json({ provider: null });
  }

  const row = rows[0];
  let apiKey = '';
  try {
    apiKey = decryptSecret({ enc: row.api_key_enc, iv: row.api_key_iv, tag: row.api_key_tag });
  } catch {
    return NextResponse.json({ provider: null, error: 'DECRYPT_FAILED' });
  }

  return NextResponse.json({
    provider: {
      id: row.id,
      providerType: row.provider_type,
      baseUrl: row.base_url,
      modelName: row.model_name,
      apiKey,
      extraHeaders: row.extra_headers ?? {},
      params: row.params ?? {},
    },
  });
}

const UsageRecordSchema = z.object({
  userId: z.string(),
  providerId: z.string().nullable().optional(),
  roomId: z.string().nullable().optional(),
  role: z.string(),
  modelName: z.string(),
  promptTokens: z.number().int().nonnegative().default(0),
  completionTokens: z.number().int().nonnegative().default(0),
  latencyMs: z.number().int().nonnegative().default(0),
  success: z.boolean().default(true),
  errorMsg: z.string().nullable().optional(),
});

async function handleUsageAdd(payload: Record<string, unknown>) {
  const parsed = z.array(UsageRecordSchema).safeParse(payload.records);
  if (!parsed.success) {
    return NextResponse.json({ code: 'INVALID_INPUT', message: '记录的用量格式不合法' }, { status: 400 });
  }
  let count = 0;
  for (const r of parsed.data.slice(0, 50)) {
    await recordUsage({
      userId: r.userId,
      providerId: r.providerId ?? null,
      roomId: r.roomId ?? null,
      role: r.role,
      modelName: r.modelName,
      promptTokens: r.promptTokens,
      completionTokens: r.completionTokens,
      latencyMs: r.latencyMs,
      success: r.success,
      errorMsg: r.errorMsg ?? null,
    });
    count += 1;
  }
  return NextResponse.json({ ok: true, count });
}

const MatchSchema = z.object({
  roomId: z.string(),
  mode: z.string(),
  winnerId: z.string().uuid().nullable().optional(),
  turns: z.number().int().nonnegative().default(0),
  players: z.array(z.record(z.string(), z.unknown())).default([]),
  report: z.string().nullable().optional(),
});

async function handleMatchSave(payload: Record<string, unknown>) {
  const parsed = MatchSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json({ code: 'INVALID_INPUT', message: '对局存档格式不合法' }, { status: 400 });
  }
  const p = parsed.data;
  await query(
    `INSERT INTO matches (room_id, mode, winner_id, turns, players_json, report)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
    [p.roomId, p.mode, p.winnerId ?? null, p.turns, JSON.stringify(p.players), p.report ?? null],
  );
  return NextResponse.json({ ok: true });
}

const LobbyRoomSchema = z
  .object({
    id: z.string(),
    code: z.string(),
    mode: z.string(),
    status: z.string(),
    playerCount: z.number(),
    maxPlayers: z.number(),
    turn: z.number(),
    hostName: z.string(),
  })
  .passthrough();

async function handleLobbyUpsert(payload: Record<string, unknown>) {
  const parsed = LobbyRoomSchema.safeParse(payload.room);
  if (!parsed.success) {
    return NextResponse.json({ code: 'INVALID_INPUT', message: '房间信息格式不合法' }, { status: 400 });
  }
  const room = parsed.data;
  const r = redis();
  await r.hset('csai:lobby', { [room.id]: JSON.stringify({ ...room, updatedAt: Date.now() }) });
  await r.expire('csai:lobby', 600);
  return NextResponse.json({ ok: true });
}

async function handleLobbyRemove(payload: Record<string, unknown>) {
  const roomId = String(payload.roomId ?? '');
  if (!roomId) {
    return NextResponse.json({ code: 'INVALID_INPUT', message: '缺少 roomId' }, { status: 400 });
  }
  await redis().hdel('csai:lobby', roomId);
  return NextResponse.json({ ok: true });
}