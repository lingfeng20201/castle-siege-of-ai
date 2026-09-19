import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { assertSameOrigin, getSessionFromRequest } from '@/lib/auth';
import { query } from '@/lib/db';
import { decryptSecret } from '@/lib/crypto';
import { assertSafeBaseUrl } from '@/lib/ssrf';
import { callModel } from '@/lib/llm';
import { redact } from '@/lib/logger';
import { PROVIDER_TYPES } from '@/lib/providers';

export const runtime = 'nodejs';

/**
 * POST /api/models/test
 * 测试连接：发送 max_tokens=1 的最小请求，15 秒超时。
 * 返回：成功/失败、延迟、错误信息（脱敏）。
 *
 * - 携带 id 且未提供 apiKey 时，使用服务端解密后的已存 Key
 * - 若携带 id，测试结果会回写 last_tested_at / last_test_ok
 */

const Body = z.object({
  id: z.string().uuid().optional(),
  baseUrl: z.string().trim().optional(),
  apiKey: z.string().trim().optional(),
  modelName: z.string().trim().optional(),
  providerType: z.string().trim().optional(),
  extraHeaders: z.record(z.string(), z.string()).optional(),
});

function allowLocal(): boolean {
  return process.env.ALLOW_LOCAL_MODEL_URL === 'true';
}

export async function POST(req: NextRequest) {
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ code: 'CSRF', message: '请求被拒绝' }, { status: 403 });
  }
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ code: 'UNAUTHORIZED', message: '请先登录' }, { status: 401 });

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (e) {
    const msg = e instanceof z.ZodError ? e.issues[0]?.message : '参数不合法';
    return NextResponse.json({ code: 'INVALID_INPUT', message: msg }, { status: 400 });
  }

  let { baseUrl, apiKey, modelName, providerType, extraHeaders } = body;
  providerType =
    providerType && (PROVIDER_TYPES as readonly string[]).includes(providerType) ? providerType : 'custom';

  // 已有配置：补全缺失字段 + 解密已存 Key
  if (body.id) {
    type Row = {
      base_url: string;
      model_name: string;
      provider_type: string;
      api_key_enc: string;
      api_key_iv: string;
      api_key_tag: string;
      extra_headers: Record<string, string> | null;
    };
    const rows = await query<Row>(
      `SELECT base_url, model_name, provider_type, api_key_enc, api_key_iv, api_key_tag, extra_headers
       FROM model_providers WHERE id = $1 AND user_id = $2`,
      [body.id, session.uid],
    );
    if (rows.length === 0) {
      return NextResponse.json({ code: 'NOT_FOUND', message: '配置不存在' }, { status: 404 });
    }
    const row = rows[0];
    baseUrl = baseUrl || row.base_url;
    modelName = modelName || row.model_name;
    providerType = row.provider_type;
    extraHeaders = extraHeaders ?? row.extra_headers ?? {};
    if (!apiKey) {
      try {
        apiKey = decryptSecret({ enc: row.api_key_enc, iv: row.api_key_iv, tag: row.api_key_tag });
      } catch {
        return NextResponse.json({ code: 'DECRYPT_FAILED', message: 'API Key 解密失败，请重新保存' }, { status: 400 });
      }
    }
  }

  if (!baseUrl || !modelName) {
    return NextResponse.json({ code: 'INVALID_INPUT', message: '请先填写 Base URL 和模型名' }, { status: 400 });
  }
  if (!apiKey) {
    return NextResponse.json({ code: 'INVALID_INPUT', message: '缺少 API Key' }, { status: 400 });
  }

  try {
    assertSafeBaseUrl(baseUrl, { allowLocal: allowLocal() });
  } catch (e) {
    return NextResponse.json({ code: 'BASE_URL_BLOCKED', message: (e as Error).message }, { status: 400 });
  }

  const started = Date.now();
  try {
    const r = await callModel(
      { providerType, baseUrl, modelName, apiKey, extraHeaders },
      [{ role: 'user', content: 'ping' }],
      { maxTokens: 1, temperature: 0, timeoutMs: 15_000 },
    );
    if (body.id) {
      await query(
        'UPDATE model_providers SET last_tested_at = now(), last_test_ok = true WHERE id = $1 AND user_id = $2',
        [body.id, session.uid],
      );
    }
    // servedModel：供应商响应里的实际模型标识（可能带版本后缀，如 deepseek-chat-0324）
    return NextResponse.json({
      ok: true,
      latency: Date.now() - started,
      servedModel: r.servedModel ?? null,
      requestedModel: modelName,
    });
  } catch (e) {
    const message = redact((e as Error)?.message || String(e));
    if (body.id) {
      await query(
        'UPDATE model_providers SET last_tested_at = now(), last_test_ok = false WHERE id = $1 AND user_id = $2',
        [body.id, session.uid],
      );
    }
    return NextResponse.json({ ok: false, latency: Date.now() - started, error: message });
  }
}