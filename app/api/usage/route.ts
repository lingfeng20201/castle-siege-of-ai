import { NextRequest, NextResponse } from 'next/server';
import { assertSameOrigin, getSessionFromRequest } from '@/lib/auth';
import { query } from '@/lib/db';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

/**
 * /api/usage —— 模型用量统计（模块三）
 *
 * GET    ?range=7d|30d|all & providerId & model & roomId & format=json|csv
 *        返回：顶部卡片汇总、近 N 天趋势、各模型占比、按 provider 聚合、最近记录
 * DELETE 一键清空当前用户的用量记录
 *
 * 安全：JWT 校验 + user_id 过滤（永不跨用户查询）+ 全部参数化查询。
 */

const DAY_MS = 86_400_000;

type RangeKey = '7d' | '30d' | '90d' | 'all';

interface Filters {
  clause: string;
  params: unknown[];
}

function buildFilters(req: NextRequest, uid: string, alias = 'u'): Filters {
  const sp = req.nextUrl.searchParams;
  const params: unknown[] = [uid];
  const where: string[] = [`${alias}.user_id = $1`];

  const providerId = sp.get('providerId');
  if (providerId && /^[0-9a-f-]{36}$/i.test(providerId)) {
    params.push(providerId);
    where.push(`${alias}.provider_id = $${params.length}`);
  }

  const model = sp.get('model');
  if (model) {
    params.push(model.slice(0, 120));
    where.push(`${alias}.model_name = $${params.length}`);
  }

  const roomId = sp.get('roomId');
  if (roomId) {
    params.push(roomId.slice(0, 64));
    where.push(`${alias}.room_id = $${params.length}`);
  }

  const range = (sp.get('range') ?? '30d') as RangeKey;
  const days = range === '7d' ? 7 : range === '90d' ? 90 : range === 'all' ? null : 30;
  if (days) {
    params.push(days);
    where.push(
      `${alias}.created_at >= date_trunc('day', now()) - ($${params.length}::int - 1) * interval '1 day'`,
    );
  }

  return { clause: `WHERE ${where.join(' AND ')}`, params };
}

interface SummaryRow {
  total_calls: number;
  total_tokens: number;
  total_cost: number;
  today_calls: number;
  today_tokens: number;
  today_cost: number;
  month_calls: number;
  month_tokens: number;
  month_cost: number;
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function fillSeries(
  rows: { day: string; calls: number; tokens: number; cost: number }[],
  days: number | null,
): { date: string; calls: number; tokens: number; cost: number }[] {
  const span = days ?? 30;
  const map = new Map(rows.map((r) => [r.day, r]));
  const out: { date: string; calls: number; tokens: number; cost: number }[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = span - 1; i >= 0; i -= 1) {
    const d = new Date(today.getTime() - i * DAY_MS);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const hit = map.get(key);
    out.push({
      date: key,
      calls: hit ? num(hit.calls) : 0,
      tokens: hit ? num(hit.tokens) : 0,
      cost: hit ? num(hit.cost) : 0,
    });
  }
  return out;
}

function toCsv(rows: {
  created_at: string | Date;
  role: string | null;
  model_name: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost: number;
  latency_ms: number;
  success: boolean;
  room_id: string | null;
}[]): string {
  const head = [
    '时间',
    '用途',
    '模型',
    '输入tokens',
    '输出tokens',
    '总tokens',
    '费用USD',
    '延迟ms',
    '成功',
    '房间',
  ];
  const cell = (v: unknown) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [head.join(',')];
  for (const r of rows) {
    lines.push(
      [
        new Date(r.created_at).toISOString(),
        r.role ?? '',
        r.model_name ?? '',
        r.prompt_tokens,
        r.completion_tokens,
        r.total_tokens,
        Number(r.cost ?? 0).toFixed(6),
        r.latency_ms,
        r.success ? 'Y' : 'N',
        r.room_id ?? '',
      ]
        .map(cell)
        .join(','),
    );
  }
  // BOM 便于 Excel 正确识别 UTF-8
  return `\uFEFF${lines.join('\r\n')}`;
}

export async function GET(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ code: 'UNAUTHORIZED', message: '请先登录' }, { status: 401 });

  const uid = session.uid;
  const range = (req.nextUrl.searchParams.get('range') ?? '30d') as RangeKey;
  const days = range === '7d' ? 7 : range === '90d' ? 90 : range === 'all' ? null : 30;
  const f = buildFilters(req, uid);

  try {
    /* ── 1. 顶部卡片汇总 ── */
    const summaryRows = await query<SummaryRow>(
      `SELECT
         count(*)::int AS total_calls,
         coalesce(sum(u.total_tokens), 0)::float8 AS total_tokens,
         coalesce(sum(u.cost), 0)::float8 AS total_cost,
         count(*) FILTER (WHERE u.created_at >= date_trunc('day', now()))::int AS today_calls,
         coalesce(sum(u.total_tokens) FILTER (WHERE u.created_at >= date_trunc('day', now())), 0)::float8 AS today_tokens,
         coalesce(sum(u.cost) FILTER (WHERE u.created_at >= date_trunc('day', now())), 0)::float8 AS today_cost,
         count(*) FILTER (WHERE u.created_at >= date_trunc('month', now()))::int AS month_calls,
         coalesce(sum(u.total_tokens) FILTER (WHERE u.created_at >= date_trunc('month', now())), 0)::float8 AS month_tokens,
         coalesce(sum(u.cost) FILTER (WHERE u.created_at >= date_trunc('month', now())), 0)::float8 AS month_cost
       FROM model_usage u
       ${f.clause}`,
      f.params,
    );
    const s = summaryRows[0];

    /* ── 2. CSV 导出（同筛选条件，最多 5000 行） ── */
    if (req.nextUrl.searchParams.get('format') === 'csv') {
      const rows = await query<{
        created_at: string;
        role: string | null;
        model_name: string | null;
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
        cost: number;
        latency_ms: number;
        success: boolean;
        room_id: string | null;
      }>(
        `SELECT u.created_at, u.role, u.model_name, u.prompt_tokens, u.completion_tokens,
                u.total_tokens, u.cost, u.latency_ms, u.success, u.room_id
         FROM model_usage u
         ${f.clause}
         ORDER BY u.created_at DESC
         LIMIT 5000`,
        f.params,
      );
      return new NextResponse(toCsv(rows), {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="castle-siege-usage-${Date.now()}.csv"`,
          'Cache-Control': 'no-store',
        },
      });
    }

    /* ── 3. 趋势（按天） ── */
    const seriesRows = await query<{ day: string; calls: number; tokens: number; cost: number }>(
      `SELECT to_char(date_trunc('day', u.created_at), 'YYYY-MM-DD') AS day,
              count(*)::int AS calls,
              coalesce(sum(u.total_tokens), 0)::float8 AS tokens,
              coalesce(sum(u.cost), 0)::float8 AS cost
       FROM model_usage u
       ${f.clause}
       GROUP BY 1
       ORDER BY 1 ASC`,
      f.params,
    );

    /* ── 4. 各模型占比 ── */
    const byModel = await query<{ model: string; calls: number; tokens: number; cost: number }>(
      `SELECT coalesce(u.model_name, '未知') AS model,
              count(*)::int AS calls,
              coalesce(sum(u.total_tokens), 0)::float8 AS tokens,
              coalesce(sum(u.cost), 0)::float8 AS cost
       FROM model_usage u
       ${f.clause}
       GROUP BY 1
       ORDER BY tokens DESC
       LIMIT 12`,
      f.params,
    );

    /* ── 5. 按 provider 聚合 ── */
    const byProvider = await query<{
      provider_id: string | null;
      name: string;
      calls: number;
      tokens: number;
      cost: number;
      avg_latency: number;
      success_rate: number;
    }>(
      `SELECT u.provider_id,
              coalesce(p.name, '(已删除配置)') AS name,
              count(*)::int AS calls,
              coalesce(sum(u.total_tokens), 0)::float8 AS tokens,
              coalesce(sum(u.cost), 0)::float8 AS cost,
              coalesce(avg(u.latency_ms), 0)::float8 AS avg_latency,
              (count(*) FILTER (WHERE u.success))::float8 / greatest(count(*), 1) AS success_rate
       FROM model_usage u
       LEFT JOIN model_providers p ON p.id = u.provider_id AND p.user_id = u.user_id
       ${f.clause}
       GROUP BY 1, 2
       ORDER BY tokens DESC
       LIMIT 20`,
      f.params,
    );

    /* ── 6. 按用途（commander / judge / report）聚合 ── */
    const byRole = await query<{ role: string | null; calls: number; tokens: number; cost: number }>(
      `SELECT u.role, count(*)::int AS calls,
              coalesce(sum(u.total_tokens), 0)::float8 AS tokens,
              coalesce(sum(u.cost), 0)::float8 AS cost
       FROM model_usage u
       ${f.clause}
       GROUP BY 1
       ORDER BY tokens DESC`,
      f.params,
    );

    /* ── 7. 最近记录 ── */
    const recent = await query<{
      id: string;
      created_at: string;
      role: string | null;
      model_name: string | null;
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
      cost: number;
      latency_ms: number;
      success: boolean;
      room_id: string | null;
      error_msg: string | null;
    }>(
      `SELECT u.id, u.created_at, u.role, u.model_name, u.prompt_tokens, u.completion_tokens,
              u.total_tokens, u.cost, u.latency_ms, u.success, u.room_id, u.error_msg
       FROM model_usage u
       ${f.clause}
       ORDER BY u.created_at DESC
       LIMIT 30`,
      f.params,
    );

    return NextResponse.json({
      range,
      summary: {
        todayCalls: num(s?.today_calls),
        todayTokens: num(s?.today_tokens),
        todayCost: num(s?.today_cost),
        monthCalls: num(s?.month_calls),
        monthTokens: num(s?.month_tokens),
        monthCost: num(s?.month_cost),
        totalCalls: num(s?.total_calls),
        totalTokens: num(s?.total_tokens),
        totalCost: num(s?.total_cost),
      },
      series: fillSeries(seriesRows, days),
      byModel: byModel.map((r) => ({
        model: r.model,
        calls: num(r.calls),
        tokens: num(r.tokens),
        cost: num(r.cost),
      })),
      byProvider: byProvider.map((r) => ({
        providerId: r.provider_id,
        name: r.name,
        calls: num(r.calls),
        tokens: num(r.tokens),
        cost: num(r.cost),
        avgLatency: Math.round(num(r.avg_latency)),
        successRate: num(r.success_rate),
      })),
      byRole: byRole.map((r) => ({
        role: r.role ?? 'unknown',
        calls: num(r.calls),
        tokens: num(r.tokens),
        cost: num(r.cost),
      })),
      recent: recent.map((r) => ({
        id: r.id,
        createdAt: r.created_at,
        role: r.role,
        modelName: r.model_name,
        promptTokens: num(r.prompt_tokens),
        completionTokens: num(r.completion_tokens),
        totalTokens: num(r.total_tokens),
        cost: num(r.cost),
        latencyMs: num(r.latency_ms),
        success: r.success,
        roomId: r.room_id,
        errorMsg: r.error_msg,
      })),
    });
  } catch (e) {
    logger.error('usage: query failed', { message: (e as Error).message });
    return NextResponse.json({ code: 'SERVER_ERROR', message: '统计查询失败' }, { status: 500 });
  }
}

/** 一键清空当前用户的用量记录 */
export async function DELETE(req: NextRequest) {
  if (!assertSameOrigin(req)) {
    return NextResponse.json({ code: 'CSRF', message: '请求被拒绝' }, { status: 403 });
  }
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ code: 'UNAUTHORIZED', message: '请先登录' }, { status: 401 });

  try {
    await query('DELETE FROM model_usage WHERE user_id = $1', [session.uid]);
    await query(
      `UPDATE model_providers SET usage_count = 0, total_tokens = 0, total_cost = 0, updated_at = now()
       WHERE user_id = $1`,
      [session.uid],
    );
    return NextResponse.json({ ok: true });
  } catch (e) {
    logger.error('usage: clear failed', { message: (e as Error).message });
    return NextResponse.json({ code: 'SERVER_ERROR', message: '清空失败，请稍后重试' }, { status: 500 });
  }
}