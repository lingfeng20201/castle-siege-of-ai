import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { assertSameOrigin, getSessionFromRequest } from '@/lib/auth';
import { db, query } from '@/lib/db';
import { encryptSecret } from '@/lib/crypto';
import { assertSafeBaseUrl } from '@/lib/ssrf';
import { providerPatchSchema, toSafeProvider, type ProviderRow } from '@/lib/providers';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

/**
 * GET    /api/models/[id] —— 读取单条（脱敏）
 * PATCH  /api/models/[id] —— 更新（apiKey 留空则不改；baseUrl 变更重新做 SSRF 校验）
 * DELETE /api/models/[id] —— 删除
 *
 * 所有操作均带 user_id 过滤，只能操作自己的配置。
 */

const SELECT_COLS = `id, user_id, name, provider_type, base_url, api_key_tail, model_name,
  extra_headers, params, is_default, enabled, last_tested_at, last_test_ok,
  usage_count, total_tokens, total_cost, created_at, updated_at`;

type Ctx = { params: { id: string } };

function allowLocal(): boolean {
  return process.env.ALLOW_LOCAL_MODEL_URL === 'true';
}

export async function GET(req: NextRequest, { params }: Ctx) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ code: 'UNAUTHORIZED', message: '请先登录' }, { status: 401 });

  const rows = await query<ProviderRow>(
    `SELECT ${SELECT_COLS} FROM model_providers WHERE id = $1 AND user_id = $2`,
    [params.id, session.uid],
  );
  if (rows.length === 0) {
    return NextResponse.json({ code: 'NOT_FOUND', message: '配置不存在' }, { status: 404 });
  }
  return NextResponse.json({ item: toSafeProvider(rows[0]) });
}

export async function PATCH(req: NextRequest, { params }: Ctx) {
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ code: 'CSRF', message: '请求被拒绝' }, { status: 403 });
  }
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ code: 'UNAUTHORIZED', message: '请先登录' }, { status: 401 });

  const raw = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  // 前端「留空则不修改」：空字符串视作未提供
  if (raw && typeof raw === 'object' && raw.apiKey === '') delete raw.apiKey;

  let input: z.infer<typeof providerPatchSchema>;
  try {
    input = providerPatchSchema.parse(raw);
  } catch (e) {
    const msg = e instanceof z.ZodError ? e.issues[0]?.message : '参数不合法';
    return NextResponse.json({ code: 'INVALID_INPUT', message: msg }, { status: 400 });
  }

  if (input.baseUrl !== undefined) {
    try {
      assertSafeBaseUrl(input.baseUrl, { allowLocal: allowLocal() });
    } catch (e) {
      return NextResponse.json({ code: 'BASE_URL_BLOCKED', message: (e as Error).message }, { status: 400 });
    }
  }

  // 动态 SET 子句
  const sets: string[] = [];
  const values: unknown[] = [];
  const add = (col: string, value: unknown, cast = '') => {
    values.push(value);
    sets.push(`${col} = $${values.length}${cast}`);
  };

  if (input.name !== undefined) add('name', input.name);
  if (input.providerType !== undefined) add('provider_type', input.providerType);
  if (input.baseUrl !== undefined) add('base_url', input.baseUrl);
  if (input.modelName !== undefined) add('model_name', input.modelName);
  if (input.extraHeaders !== undefined) add('extra_headers', JSON.stringify(input.extraHeaders), '::jsonb');
  if (input.params !== undefined) add('params', JSON.stringify(input.params), '::jsonb');
  if (input.enabled !== undefined) add('enabled', input.enabled);
  if (input.isDefault !== undefined) add('is_default', input.isDefault);
  if (input.apiKey) {
    const s = encryptSecret(input.apiKey);
    add('api_key_enc', s.enc);
    add('api_key_iv', s.iv);
    add('api_key_tag', s.tag);
    add('api_key_tail', s.tail);
  }
  sets.push('updated_at = now()');

  const client = await db().connect();
  try {
    await client.query('BEGIN');
    if (input.isDefault === true) {
      await client.query(
        'UPDATE model_providers SET is_default = false WHERE user_id = $1 AND is_default = true',
        [session.uid],
      );
    }
    const { rows } = await client.query<ProviderRow>(
      `UPDATE model_providers SET ${sets.join(', ')}
       WHERE id = $${values.length + 1} AND user_id = $${values.length + 2}
       RETURNING ${SELECT_COLS}`,
      [...values, params.id, session.uid],
    );
    await client.query('COMMIT');
    if (rows.length === 0) {
      return NextResponse.json({ code: 'NOT_FOUND', message: '配置不存在' }, { status: 404 });
    }
    return NextResponse.json({ ok: true, item: toSafeProvider(rows[0]) });
  } catch (e) {
    await client.query('ROLLBACK');
    logger.error('models: update failed', { message: (e as Error).message });
    return NextResponse.json({ code: 'SERVER_ERROR', message: '更新失败，请稍后重试' }, { status: 500 });
  } finally {
    client.release();
  }
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ code: 'CSRF', message: '请求被拒绝' }, { status: 403 });
  }
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ code: 'UNAUTHORIZED', message: '请先登录' }, { status: 401 });

  const rows = await query<{ id: string }>(
    'DELETE FROM model_providers WHERE id = $1 AND user_id = $2 RETURNING id',
    [params.id, session.uid],
  );
  if (rows.length === 0) {
    return NextResponse.json({ code: 'NOT_FOUND', message: '配置不存在' }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}