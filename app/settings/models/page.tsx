'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { SafeProvider } from '@/lib/providers';
import { cls } from '@/lib/client/ui';
import ProviderCard from '@/components/settings/ProviderCard';
import ProviderDrawer, {
  draftFromSafe,
  emptyDraft,
  type ProviderDraft,
} from '@/components/settings/ProviderDrawer';

/**
 * app/settings/models/page.tsx —— 模型配置中心（模块二 · BYOK）
 *
 * 对应接口：
 *   GET    /api/models          → { items: SafeProvider[] }
 *   POST   /api/models          → 新增（apiKey 加密存储）
 *   PATCH  /api/models/[id]     → 更新（apiKey 留空则不改）
 *   DELETE /api/models/[id]     → 删除
 *   POST   /api/models/test     → 测试连接（成功/失败均 200，看 ok 字段）
 *
 * 安全：API Key 只会以 sk-****尾号 回显；未登录访问接口返回 401 → 跳转登录页。
 * 规则：每个用户最多 20 条配置；未配置模型可进房观战，但不能参战。
 */

interface Toast {
  kind: 'ok' | 'err';
  text: string;
}

export default function ModelsSettingsPage() {
  const router = useRouter();

  const [items, setItems] = useState<SafeProvider[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<{ isNew: boolean; draft: ProviderDraft } | null>(null);

  /* ── 拉取列表 ── */
  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/models');
      if (r.status === 401) {
        router.replace('/login');
        return;
      }
      const d = (await r.json().catch(() => ({}))) as { items?: SafeProvider[]; message?: string };
      if (!r.ok || !d.items) {
        setLoadError(d.message || '加载失败，请稍后重试');
        setItems([]);
        return;
      }
      setLoadError(null);
      setItems(d.items);
    } catch {
      setLoadError('网络异常，无法加载配置列表');
      setItems([]);
    }
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  /* 3.5 秒后自动清除 toast */
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 3500);
    return () => window.clearTimeout(t);
  }, [toast]);

  /* ── 抽屉保存：新建 POST / 编辑 PATCH ── */
  async function handleSave(draft: ProviderDraft): Promise<string | null> {
    const isNew = !draft.id;
    try {
      const body: Record<string, unknown> = {
        name: draft.name.trim(),
        providerType: draft.providerType,
        baseUrl: draft.baseUrl.trim(),
        modelName: draft.modelName.trim(),
        extraHeaders: draft.extraHeaders,
        params: draft.params,
        isDefault: draft.isDefault,
        enabled: draft.enabled,
      };
      if (isNew || draft.apiKey) body.apiKey = draft.apiKey;

      const r = await fetch(isNew ? '/api/models' : `/api/models/${draft.id}`, {
        method: isNew ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = (await r.json().catch(() => ({}))) as { ok?: boolean; message?: string };

      if (r.status === 401) {
        router.replace('/login');
        return '登录已过期，请重新登录';
      }
      if (r.ok && d.ok) {
        setToast({ kind: 'ok', text: isNew ? '配置已创建' : '配置已更新' });
        setDrawer(null);
        void load();
        return null;
      }
      return d.message || '保存失败，请稍后重试';
    } catch {
      return '网络异常，请稍后重试';
    }
  }

  /* ── 通用 PATCH（启停 / 设为默认） ── */
  async function patchItem(item: SafeProvider, patch: Record<string, unknown>, okText: string) {
    setBusyId(item.id);
    try {
      const r = await fetch(`/api/models/${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const d = (await r.json().catch(() => ({}))) as { ok?: boolean; message?: string };
      if (r.status === 401) {
        router.replace('/login');
        return;
      }
      if (r.ok && d.ok) {
        setToast({ kind: 'ok', text: okText });
        void load();
      } else {
        setToast({ kind: 'err', text: d.message || '操作失败' });
      }
    } catch {
      setToast({ kind: 'err', text: '网络异常，请稍后重试' });
    } finally {
      setBusyId(null);
    }
  }

  /* ── 测试连接 ── */
  async function testItem(item: SafeProvider) {
    setBusyId(item.id);
    try {
      const r = await fetch('/api/models/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id }),
      });
      const d = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        latency?: number;
        error?: string;
        message?: string;
      };
      if (r.status === 401) {
        router.replace('/login');
        return;
      }
      if (d.ok) {
        setToast({ kind: 'ok', text: `「${item.name}」连接成功 · 延迟 ${d.latency ?? 0}ms` });
      } else {
        setToast({ kind: 'err', text: `「${item.name}」连接失败：${d.error || d.message || '未知错误'}` });
      }
      void load();
    } catch {
      setToast({ kind: 'err', text: '网络异常，无法完成测试' });
    } finally {
      setBusyId(null);
    }
  }

  /* ── 删除 ── */
  async function deleteItem(item: SafeProvider) {
    if (!window.confirm(`确定删除配置「${item.name}」？该操作不可撤销。`)) return;
    setBusyId(item.id);
    try {
      const r = await fetch(`/api/models/${item.id}`, { method: 'DELETE' });
      const d = (await r.json().catch(() => ({}))) as { ok?: boolean; message?: string };
      if (r.status === 401) {
        router.replace('/login');
        return;
      }
      if (r.ok && d.ok) {
        setToast({ kind: 'ok', text: '配置已删除' });
        void load();
      } else {
        setToast({ kind: 'err', text: d.message || '删除失败' });
      }
    } catch {
      setToast({ kind: 'err', text: '网络异常，请稍后重试' });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-5">
      {/* 标题与操作 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-lg text-[#e6f1ff]">模型配置中心</h2>
          <p className="mt-1 text-xs text-fog">
            BYOK：配置你的大模型指挥官（每用户上限 20 条）。未配置时可观战，但不能加入对战。
          </p>
        </div>
        <button
          type="button"
          className="btn-blue"
          onClick={() => setDrawer({ isNew: true, draft: emptyDraft() })}
        >
          ＋ 新增配置
        </button>
      </div>

      {/* 提示条 */}
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

      {/* 列表 */}
      {items === null ? (
        <div className="panel grid h-40 place-items-center text-sm text-fog animate-csai-pulse">
          正在校验会话并加载配置…
        </div>
      ) : loadError ? (
        <div className="panel border-neon-red/40 px-4 py-3 text-sm text-neon-red">
          {loadError}
          <button type="button" className="btn-ghost ml-3" onClick={() => void load()}>
            重试
          </button>
        </div>
      ) : items.length === 0 ? (
        <div className="panel flex flex-col items-center gap-3 px-4 py-10 text-center">
          <div className="text-3xl">🏰</div>
          <p className="text-sm text-fog">
            还没有模型配置。添加一条后，你的 AI 指挥官就能在对局中替你思考出牌了。
          </p>
          <button
            type="button"
            className="btn-blue"
            onClick={() => setDrawer({ isNew: true, draft: emptyDraft() })}
          >
            ＋ 新增第一条配置
          </button>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {items.map((item) => (
            <ProviderCard
              key={item.id}
              item={item}
              busy={busyId === item.id}
              onEdit={() => setDrawer({ isNew: false, draft: draftFromSafe(item) })}
              onTest={() => void testItem(item)}
              onToggle={() =>
                void patchItem(item, { enabled: !item.enabled }, item.enabled ? '已停用' : '已启用')
              }
              onSetDefault={() => void patchItem(item, { isDefault: true }, '已设为默认配置')}
              onDelete={() => void deleteItem(item)}
            />
          ))}
        </div>
      )}

      {/* 说明卡片 */}
      <div className="panel space-y-1 p-4 text-[11px] leading-relaxed text-fog">
        <p>· API Key 使用 AES-256-GCM 加密存储，前端只回显尾号 sk-****xxxx，日志自动脱敏。</p>
        <p>· Base URL 需兼容 OpenAI 的 /chat/completions 协议；服务端默认禁止内网地址（SSRF 防护）。</p>
        <p>· 「设为默认」的配置会优先用于新对局；房间内也可按需切换（后续版本）。</p>
        <p>· 测试连接会发送一条 max_tokens=1 的最小请求，15 秒超时，用于确认 Key 与网络可用。</p>
      </div>

      {/* 抽屉 */}
      {drawer && (
        <ProviderDrawer
          value={drawer.draft}
          isNew={drawer.isNew}
          onChange={(v) => setDrawer((cur) => (cur ? { ...cur, draft: v } : cur))}
          onSave={handleSave}
          onClose={() => setDrawer(null)}
        />
      )}
    </div>
  );
}