import { estimateCost } from './pricing';
import { logger, redact } from './logger';
import { query } from './db';
import { callModel } from './llm-core';
import type { LlmCallResult, LlmCallOptions, LlmMessage, LlmProviderConfig } from './llm-core';

/**
 * lib/llm.ts —— 服务端（Node）用量记录包装
 *
 * 核心调用 / 提示词 / 解析见 lib/llm-core.ts
 * （PartyKit Workers 复用同一份实现，避免在 Worker 中引入 pg / ioredis）
 */

export * from './llm-core';

export interface UsageRecordInput {
  userId: string;
  providerId: string | null;
  roomId?: string | null;
  campaignId?: string | null;
  role: string;
  modelName: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  success: boolean;
  errorMsg?: string | null;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

export async function recordUsage(rec: UsageRecordInput): Promise<void> {
  try {
    const totalTokens = rec.promptTokens + rec.completionTokens;
    const cost = estimateCost(rec.modelName, rec.promptTokens, rec.completionTokens);
    await query(
      `INSERT INTO model_usage (user_id, provider_id, room_id, campaign_id, role, model_name,
         prompt_tokens, completion_tokens, total_tokens, cost, latency_ms, success, error_msg)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        rec.userId,
        rec.providerId,
        rec.roomId ?? null,
        rec.campaignId ?? null,
        rec.role,
        rec.modelName,
        rec.promptTokens,
        rec.completionTokens,
        totalTokens,
        cost,
        rec.latencyMs,
        rec.success,
        rec.errorMsg ?? null,
      ],
    );
    if (rec.providerId) {
      await query(
        `UPDATE model_providers
         SET usage_count = usage_count + 1,
             total_tokens = total_tokens + $3,
             total_cost = total_cost + $4,
             updated_at = now()
         WHERE id = $1 AND user_id = $2`,
        [rec.providerId, rec.userId, totalTokens, cost],
      );
    }
  } catch (e) {
    // 用量记录失败不影响对战主流程
    logger.warn('recordUsage failed', { message: (e as Error).message });
  }
}

/** 调用 + 自动记录用量（成功/失败都记录） */
export async function callModelWithUsage(args: {
  provider: LlmProviderConfig;
  providerId: string | null;
  userId: string;
  role: string;
  roomId?: string | null;
  campaignId?: string | null;
  messages: LlmMessage[];
  opts?: LlmCallOptions;
}): Promise<LlmCallResult> {
  try {
    const r = await callModel(args.provider, args.messages, args.opts);
    await recordUsage({
      userId: args.userId,
      providerId: args.providerId,
      roomId: args.roomId,
      campaignId: args.campaignId,
      role: args.role,
      modelName: args.provider.modelName,
      promptTokens: r.usage.promptTokens,
      completionTokens: r.usage.completionTokens,
      latencyMs: r.latencyMs,
      success: true,
    });
    return r;
  } catch (e) {
    const message = (e as Error).message || String(e);
    await recordUsage({
      userId: args.userId,
      providerId: args.providerId,
      roomId: args.roomId,
      campaignId: args.campaignId,
      role: args.role,
      modelName: args.provider.modelName,
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: 0,
      success: false,
      errorMsg: truncate(redact(message), 500),
    });
    throw e;
  }
}