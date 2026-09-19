'use client';

import type { SafeProvider } from '@/lib/providers';
import { cls, fmtCost, fmtNum, fmtTokens, timeAgo } from '@/lib/client/ui';

/**
 * components/settings/ProviderCard.tsx —— 单条模型配置卡片
 *
 * 只展示服务端脱敏后的字段：API Key 永远只显示 sk-****尾号。
 * 所有动作（测试 / 编辑 / 设为默认 / 启停 / 删除）都回调给页面处理，
 * 卡片本身不直接发请求，便于页面统一刷新与提示。
 */

interface Props {
  item: SafeProvider;
  busy?: boolean;
  onEdit: () => void;
  onTest: () => void;
  onToggle: () => void;
  onSetDefault: () => void;
  onDelete: () => void;
}

const TYPE_LABEL: Record<string, string> = {
  openai: 'OpenAI',
  deepseek: 'DeepSeek',
  qwen: '通义千问',
  zhipu: '智谱 GLM',
  moonshot: 'Moonshot',
  anthropic: 'Anthropic',
  gemini: 'Gemini',
  ollama: 'Ollama 本地',
  custom: '自定义',
};

export default function ProviderCard({
  item,
  busy = false,
  onEdit,
  onTest,
  onToggle,
  onSetDefault,
  onDelete,
}: Props) {
  const tested = item.lastTestedAt ? timeAgo(new Date(item.lastTestedAt).getTime()) : null;

  return (
    <div
      className={cls(
        'panel animate-rise flex flex-col gap-3 p-4 transition-colors',
        item.enabled ? 'hover:border-neon-blue/40' : 'opacity-60',
      )}
    >
      {/* 头部：名称 + 徽章 */}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="truncate font-display text-base text-[#e6f1ff]">{item.name}</h3>
            {item.isDefault && <span className="chip border-gold/50 text-gold">★ 默认</span>}
            {!item.enabled && <span className="chip border-white/20 text-fog">已停用</span>}
          </div>
          <p className="mt-0.5 truncate font-mono text-[11px] text-fog">{item.modelName}</p>
        </div>
        <span className="chip shrink-0 border-neon-blue/40 text-neon-blue">
          {TYPE_LABEL[item.providerType] ?? item.providerType}
        </span>
      </div>

      {/* 连接信息 */}
      <div className="space-y-1 text-[11px] text-fog">
        <p className="break-all font-mono">
          <span className="text-fog/60">URL </span>
          {item.baseUrl}
        </p>
        <p className="font-mono">
          <span className="text-fog/60">KEY </span>
          {item.apiKeyMasked ?? '—'}
        </p>
      </div>

      {/* 汇总 */}
      <div className="grid grid-cols-3 gap-2 border-y border-white/5 py-2 text-center">
        <div>
          <div className="font-mono text-sm text-neon-blue">{fmtNum(item.usageCount)}</div>
          <div className="text-[10px] text-fog">调用</div>
        </div>
        <div>
          <div className="font-mono text-sm text-gold">{fmtTokens(item.totalTokens)}</div>
          <div className="text-[10px] text-fog">tokens</div>
        </div>
        <div>
          <div className="font-mono text-sm text-ok">{fmtCost(item.totalCost)}</div>
          <div className="text-[10px] text-fog">预估费用</div>
        </div>
      </div>

      {/* 测试状态 */}
      <p
        className={cls(
          'text-[11px]',
          item.lastTestOk === true ? 'text-ok' : item.lastTestOk === false ? 'text-neon-red' : 'text-fog/70',
        )}
      >
        {item.lastTestOk === true && `✓ 最近测试成功 · ${tested}`}
        {item.lastTestOk === false && `✗ 最近测试失败 · ${tested}`}
        {item.lastTestOk === null && '· 尚未测试连接'}
      </p>

      {/* 操作 */}
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={onTest} disabled={busy} className="btn-ok">
          测试
        </button>
        <button type="button" onClick={onEdit} disabled={busy} className="btn-blue">
          编辑
        </button>
        {!item.isDefault && (
          <button type="button" onClick={onSetDefault} disabled={busy} className="btn-gold">
            设为默认
          </button>
        )}
        <button type="button" onClick={onToggle} disabled={busy} className="btn-ghost">
          {item.enabled ? '停用' : '启用'}
        </button>
        <button type="button" onClick={onDelete} disabled={busy} className="btn-red ml-auto">
          删除
        </button>
      </div>
    </div>
  );
}