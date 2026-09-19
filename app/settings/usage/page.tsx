'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { cls, fmtCost, fmtNum, fmtTokens, roleLabel } from '@/lib/client/ui';
import UsageChart from '@/components/settings/UsageChart';

/**
 * app/settings/usage/page.tsx —— 用量统计（模块三）
 *
 * 对应接口：GET /api/usage?range=7d|30d|90d|all&providerId&model&roomId
 *          DELETE /api/usage（一键清空）
 *
 * 页面结构：顶部卡片（今日/本月/总量）→ 趋势折线与模型占比 → 按 provider / 用途聚合 → 最近记录。
 * 支持按筛选条件导出 CSV（带 UTF-8 BOM，Excel 直接打开不乱码；最多 5000 行）。
 */

type RangeKey = '7d' | '30d' | '90d' | 'all';

interface UsageResponse {
  range: RangeKey;
  summary: {
    todayCalls: number;
    todayTokens: number;
    todayCost: number;
    monthCalls: number;
    monthTokens: number;
    monthCost: number;
    totalCalls: number;
    totalTokens: number;
    totalCost: number;
  };
  series: { date: string; calls: number; tokens: number; cost: number }[];
  byModel: { model: string; calls: number; tokens: number; cost: number }[];
  byProvider: {
    providerId: string | null;
    name: string;
    calls: number;
    tokens: number;
    cost: number;
    avgLatency: number;
    successRate: number;
  }[];
  byRole: { role: string; calls: number; tokens: number; cost: number }[];
  recent: {
    id: string;
    createdAt: string;
    role: string | null;
    modelName: string | null;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cost: number;
    latencyMs: number;
    success: boolean;
    roomId: string | null;
    errorMsg: string | null;
  }[];
}

const RANGES: { key: RangeKey; label: string }[] = [
  { key: '7d', label: '近 7 天' },
  { key: '30d', label: '近 30 天' },
  { key: '90d', label: '近 90 天' },
  { key: 'all', label: '全部' },
];

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function UsageSettingsPage() {
  const router = useRouter();

  const [range, setRange] = useState<RangeKey>('30d');
  const [providerId, setProviderId] = useState('');
  const [model, setModel] = useState('');
  const [roomId, setRoomId] = useState('');
  const [roomInput, setRoomInput] = useState('');

  const [data, setData] = useState<UsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  /* ── 查询参数 ── */
  const query = useMemo(() => {
    const qs = new URLSearchParams({ range });
    if (providerId) qs.set('providerId', providerId);
    if (model) qs.set('model', model);
    if (roomId.trim()) qs.set('roomId', roomId.trim());
    return qs;
  }, [range, providerId, model, roomId]);

  /* ── 加载统计 ── */
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`/api/usage?${query.toString()}`);
      if (r.status === 401) {
        router.replace('/login');
        return;
      }
      const d = (await r.json().catch(() => ({}))) as UsageResponse & { message?: string };
      if (!r.ok || !d.summary) {
        setError(d.message || '统计查询失败');
        return;
      }
      setData(d);
    } catch {
      setError('网络异常，请稍后重试');
    } finally {
      setLoading(false);
    }
  }, [query, router]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 3500);
    return () => window.clearTimeout(t);
  }, [toast]);

  /* ── 导出 CSV（同源下载，浏览器自动携带会话 Cookie） ── */
  function exportCsv() {
    const qs = new URLSearchParams(query);
    qs.set('format', 'csv');
    window.location.href = `/api/usage?${qs.toString()}`;
  }

  /* ── 一键清空 ── */
  async function clearAll() {
    if (!window.confirm('确定清空你的全部用量记录？该操作不可撤销（不影响模型配置）。')) return;
    setClearing(true);
    try {
      const r = await fetch('/api/usage', { method: 'DELETE' });
      const d = (await r.json().catch(() => ({}))) as { ok?: boolean; message?: string };
      if (r.status === 401) {
        router.replace('/login');
        return;
      }
      if (r.ok && d.ok) {
        setToast({ kind: 'ok', text: '用量记录已清空' });
        void load();
      } else {
        setToast({ kind: 'err', text: d.message || '清空失败' });
      }
    } catch {
      setToast({ kind: 'err', text: '网络异常，请稍后重试' });
    } finally {
      setClearing(false);
    }
  }

  const s = data?.summary;

  return (
    <div className="space-y-5">
      {/* 标题与操作 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-lg text-[#e6f1ff]">用量统计</h2>
          <p className="mt-1 text-xs text-fog">
            模型调用的次数 / tokens / 预估费用（单价表见 lib/pricing.ts，CJK 估算约 1.5 字/token）。
          </p>
        </div>
        <div className="flex gap-2">
          <button type="button" className="btn-ghost" onClick={exportCsv} disabled={!data}>
            ⤓ 导出 CSV
          </button>
          <button type="button" className="btn-red" onClick={() => void clearAll()} disabled={clearing}>
            {clearing ? '清空中…' : '清空记录'}
          </button>
        </div>
      </div>

      {toast && (
        <div
          className={cls(
            'animate-rise rounded-lg border px-3 py-2 text-xs',
            toast.kind === 'ok'
              ? 'border-ok/40 bg-ok/10 text-ok'
              : 'border-neon-red/40 bg-neon-red/10 text-neon-red',
          )}
        >
          {toast.text}
        </div>
      )}

      {/* 筛选 */}
      <div className="panel flex flex-wrap items-center gap-2 p-3 text-xs">
        <div className="flex gap-1">
          {RANGES.map((r) => (
            <button
              key={r.key}
              type="button"
              onClick={() => setRange(r.key)}
              className={cls(
                'rounded-md border px-2.5 py-1 transition-colors',
                range === r.key
                  ? 'border-neon-blue/60 bg-neon-blue/10 text-neon-blue'
                  : 'border-white/10 text-fog hover:bg-white/5',
              )}
            >
              {r.label}
            </button>
          ))}
        </div>

        <select value={providerId} onChange={(e) => setProviderId(e.target.value)} className="field w-auto">
          <option value="">全部供应商</option>
          {(data?.byProvider ?? [])
            .filter((p) => p.providerId)
            .map((p) => (
              <option key={p.providerId} value={p.providerId ?? ''}>
                {p.name}
              </option>
            ))}
        </select>

        <select value={model} onChange={(e) => setModel(e.target.value)} className="field w-auto">
          <option value="">全部模型</option>
          {(data?.byModel ?? []).map((m) => (
            <option key={m.model} value={m.model}>
              {m.model}
            </option>
          ))}
        </select>

        <div className="flex items-center gap-1">
          <input
            value={roomInput}
            onChange={(e) => setRoomInput(e.target.value.toUpperCase().slice(0, 16))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') setRoomId(roomInput.trim());
            }}
            placeholder="按对局房号筛选"
            className="field w-36 font-mono"
          />
          <button type="button" className="btn-ghost" onClick={() => setRoomId(roomInput.trim())}>
            筛选
          </button>
          {roomId && (
            <button
              type="button"
              className="text-fog underline hover:text-neon-blue"
              onClick={() => {
                setRoomId('');
                setRoomInput('');
              }}
            >
              清除
            </button>
          )}
        </div>

        <button type="button" className="btn-ghost ml-auto" onClick={() => void load()} disabled={loading}>
          {loading ? '刷新中…' : '↻ 刷新'}
        </button>
      </div>

      {error && (
        <div className="panel border-neon-red/40 px-4 py-3 text-sm text-neon-red">
          {error}
          <button type="button" className="btn-ghost ml-3" onClick={() => void load()}>
            重试
          </button>
        </div>
      )}

      {/* 顶部卡片 */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="今日调用" value={fmtNum(s?.todayCalls ?? 0)} sub={`${fmtTokens(s?.todayTokens ?? 0)} tokens`} />
        <StatCard label="本月调用" value={fmtNum(s?.monthCalls ?? 0)} sub={`${fmtTokens(s?.monthTokens ?? 0)} tokens`} />
        <StatCard label="总 tokens" value={fmtTokens(s?.totalTokens ?? 0)} sub={`累计 ${fmtNum(s?.totalCalls ?? 0)} 次调用`} />
        <StatCard label="预估费用" value={fmtCost(s?.totalCost ?? 0)} sub={`本月 ${fmtCost(s?.monthCost ?? 0)}`} gold />
      </div>

      {/* 图表 */}
      <div className="grid gap-4 lg:grid-cols-2">
        <UsageChart title="token 趋势（柱=调用次数 / 线=tokens）" trend={data?.series ?? []} height={250} />
        <UsageChart
          title="各模型占比（按 tokens）"
          pie={(data?.byModel ?? []).map((m) => ({ name: m.model, value: m.tokens }))}
          height={250}
        />
      </div>

      {/* 按供应商聚合 */}
      <section className="panel overflow-hidden">
        <h3 className="border-b border-white/10 px-4 py-2.5 font-display text-sm text-neon-blue">
          按供应商聚合
        </h3>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-xs">
            <thead className="text-fog">
              <tr className="border-b border-white/5">
                <th className="px-4 py-2 font-normal">供应商</th>
                <th className="px-4 py-2 font-normal">调用</th>
                <th className="px-4 py-2 font-normal">tokens</th>
                <th className="px-4 py-2 font-normal">费用</th>
                <th className="px-4 py-2 font-normal">平均延迟</th>
                <th className="px-4 py-2 font-normal">成功率</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {(data?.byProvider ?? []).length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-fog">
                    暂无数据
                  </td>
                </tr>
              ) : (
                (data?.byProvider ?? []).map((p) => (
                  <tr key={`${p.providerId ?? 'none'}-${p.name}`} className="border-b border-white/5">
                    <td className="px-4 py-2">{p.name}</td>
                    <td className="px-4 py-2 text-neon-blue">{fmtNum(p.calls)}</td>
                    <td className="px-4 py-2 text-gold">{fmtTokens(p.tokens)}</td>
                    <td className="px-4 py-2 text-ok">{fmtCost(p.cost)}</td>
                    <td className="px-4 py-2">{fmtNum(p.avgLatency)}ms</td>
                    <td className={cls('px-4 py-2', p.successRate >= 0.95 ? 'text-ok' : 'text-warn')}>
                      {(p.successRate * 100).toFixed(1)}%
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* 按用途聚合 */}
      <section className="panel overflow-hidden">
        <h3 className="border-b border-white/10 px-4 py-2.5 font-display text-sm text-neon-blue">
          按用途聚合
        </h3>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-left text-xs">
            <thead className="text-fog">
              <tr className="border-b border-white/5">
                <th className="px-4 py-2 font-normal">用途</th>
                <th className="px-4 py-2 font-normal">调用</th>
                <th className="px-4 py-2 font-normal">tokens</th>
                <th className="px-4 py-2 font-normal">费用</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {(data?.byRole ?? []).length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center text-fog">
                    暂无数据
                  </td>
                </tr>
              ) : (
                (data?.byRole ?? []).map((r) => (
                  <tr key={r.role} className="border-b border-white/5">
                    <td className="px-4 py-2">{roleLabel(r.role)}</td>
                    <td className="px-4 py-2 text-neon-blue">{fmtNum(r.calls)}</td>
                    <td className="px-4 py-2 text-gold">{fmtTokens(r.tokens)}</td>
                    <td className="px-4 py-2 text-ok">{fmtCost(r.cost)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* 最近记录 */}
      <section className="panel overflow-hidden">
        <h3 className="border-b border-white/10 px-4 py-2.5 font-display text-sm text-neon-blue">
          最近记录（最多 30 条）
        </h3>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-xs">
            <thead className="text-fog">
              <tr className="border-b border-white/5">
                <th className="px-4 py-2 font-normal">时间</th>
                <th className="px-4 py-2 font-normal">用途</th>
                <th className="px-4 py-2 font-normal">模型</th>
                <th className="px-4 py-2 font-normal">tokens</th>
                <th className="px-4 py-2 font-normal">费用</th>
                <th className="px-4 py-2 font-normal">延迟</th>
                <th className="px-4 py-2 font-normal">状态</th>
                <th className="px-4 py-2 font-normal">房间</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {(data?.recent ?? []).length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-6 text-center text-fog">
                    暂无记录——打一局对战后再来看看吧。
                  </td>
                </tr>
              ) : (
                (data?.recent ?? []).map((r) => (
                  <tr key={r.id} className="border-b border-white/5">
                    <td className="px-4 py-2 whitespace-nowrap">{fmtTime(r.createdAt)}</td>
                    <td className="px-4 py-2">{roleLabel(r.role)}</td>
                    <td className="px-4 py-2">{r.modelName ?? '—'}</td>
                    <td className="px-4 py-2 text-gold">{fmtTokens(r.totalTokens)}</td>
                    <td className="px-4 py-2 text-ok">{fmtCost(r.cost)}</td>
                    <td className="px-4 py-2">{fmtNum(r.latencyMs)}ms</td>
                    <td className={cls('px-4 py-2', r.success ? 'text-ok' : 'text-neon-red')}>
                      {r.success ? '✓' : '✗'}
                    </td>
                    <td className="px-4 py-2">{r.roomId ?? '—'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <p className="text-[11px] leading-relaxed text-fog/70">
        提示：token 数优先读取模型返回的 usage；无 usage 时按「中文约 1.5 字/token」估算，费用为预估值，供参考。
        统计仅包含你本人账号的调用，绝不跨用户查询。
      </p>
    </div>
  );
}

/** 顶部统计卡片 */
function StatCard({
  label,
  value,
  sub,
  gold = false,
}: {
  label: string;
  value: string;
  sub?: string;
  gold?: boolean;
}) {
  return (
    <div className="panel animate-rise p-4">
      <div className="text-[11px] text-fog">{label}</div>
      <div className={cls('mt-1 font-mono text-xl', gold ? 'text-gold' : 'text-neon-blue')}>{value}</div>
      {sub && <div className="mt-1 text-[10px] text-fog/80">{sub}</div>}
    </div>
  );
}