import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { assertSameOrigin, getSessionFromRequest } from '@/lib/auth';
import { db, query } from '@/lib/db';
import { encryptSecret } from '@/lib/crypto';
import { assertSafeBaseUrl } from '@/lib/ssrf';
import { providerCreateSchema, toSafeProvider, type ProviderRow } from '@/lib/providers';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

/**
 * GET  /api/models —— 列出当前用户模型配置（脱敏）
 * POST /api/models —— 新增模型配置（API Key AES-256-GCM 加密存储）
 *
 * 安全：JWT 校验 + user_id 过滤 + SSRF 防护 + 每用户上限 20 条 + is_default 唯一。
 */

const MAX_PROVIDERS_PER_USER = 20;

const SELECT_COLS = `id, user_id, name, provider_type, base_url, api_key_tail, model_name,
  extra_headers, params, is_default, enabled, last_tested_at, last_test_ok,
  usage_count, total_tokens, total_cost, created_at, updated_at`;

function allowLocal(): boolean {
  return process.env.ALLOW_LOCAL_MODEL_URL === 'true';
}

export async function GET(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ code: 'UNAUTHORIZED', message: '请先登录' }, { status: 401 });

  const rows = await query<ProviderRow>(
    `SELECT ${SELECT_COLS} FROM model_providers
     WHERE user_id = $1
     ORDER BY is_default DESC, created_at ASC`,
    [session.uid],
  );
  return NextResponse.json({ items: rows.map(toSafeProvider) });
}

export async function POST(req: NextRequest) {
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ code: 'CSRF', message: '请求被拒绝' }, { status: 403 });
  }
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ code: 'UNAUTHORIZED', message: '请先登录' }, { status: 401 });

  let input: z.infer<typeof providerCreateSchema>;
  try {
    input = providerCreateSchema.parse(await req.json());
  } catch (e) {
    const msg = e instanceof z.ZodError ? e.issues[0]?.message : '参数不合法';
    return NextResponse.json({ code: 'INVALID_INPUT', message: msg }, { status: 400 });
  }

  try {
    assertSafeBaseUrl(input.baseUrl, { allowLocal: allowLocal() });
  } catch (e) {
    return NextResponse.json({ code: 'BASE_URL_BLOCKED', message: (e as Error).message }, { status: 400 });
  }

  // 每用户上限 20 条
  const cnt = await query<{ c: string }>(
    'SELECT count(*)::text AS c FROM model_providers WHERE user_id = $1',
    [session.uid],
  );
  if (Number(cnt[0]?.c ?? 0) >= MAX_PROVIDERS_PER_USER) {
    return NextResponse.json(
      { code: 'LIMIT_REACHED', message: `每个用户最多 ${MAX_PROVIDERS_PER_USER} 条模型配置` },
      { status: 400 },
    );
  }

  const secret = encryptSecret(input.apiKey);

  const client = await db().connect();
  try {
    await client.query('BEGIN');
    if (input.isDefault) {
      await client.query(
        'UPDATE model_providers SET is_default = false WHERE user_id = $1 AND is_default = true',
        [session.uid],
      );
    }
    const { rows } = await client.query<ProviderRow>(
      `INSERT INTO model_providers
         (user_id, name, provider_type, base_url, api_key_enc, api_key_iv, api_key_tag, api_key_tail,
          model_name, extra_headers, params, is_default, enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13)
       RETURNING ${SELECT_COLS}`,
      [
        session.uid,
        input.name,
        input.providerType,
        input.baseUrl,
        secret.enc,
        secret.iv,
        secret.tag,
        secret.tail,
        input.modelName,
        JSON.stringify(input.extraHeaders ?? {}),
        JSON.stringify(input.params ?? {}),
        input.isDefault ?? false,
        input.enabled ?? true,
      ],
    );
    await client.query('COMMIT');
    return NextResponse.json({ ok: true, item: toSafeProvider(rows[0]) });
  } catch (e) {
    await client.query('ROLLBACK');
    logger.error('models: create failed', { message: (e as Error).message });
    return NextResponse.json({ code: 'SERVER_ERROR', message: '保存失败，请稍后重试' }, { status: 500 });
  } finally {
    client.release();
  }
}