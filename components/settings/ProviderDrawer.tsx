'use client';

import { useMemo, useState } from 'react';
import { PROVIDER_PRESETS, type ProviderType } from '@/lib/providers';
import { cls } from '@/lib/client/ui';
import JsonEditor from './JsonEditor';

/**
 * components/settings/ProviderDrawer.tsx —— 模型配置抽屉（新增 / 编辑）
 *
 * 需求文档提供完整参考实现，这里做了三处工程化改造：
 *   1. 全量 TypeScript 类型（ProviderDraft / Props / TestResult）
 *   2. 预设表直接复用 lib/providers.ts 的 PROVIDER_PRESETS，避免前后端双份维护
 *   3. 样式统一走 globals.css 的 .field / .label / .btn-* 组件类（不再内联 <style jsx>）
 *
 * 交互：测试连接 → POST /api/models/test（成功/失败都返回 200，看 ok 字段）；
 *     保存 → 由父组件实现（新建 POST / 编辑 PATCH），返回错误文案或 null。
 */

export interface ProviderDraft {
  id?: string;
  name: string;
  providerType: ProviderType;
  baseUrl: string;
  modelName: string;
  /** 编辑态留空表示「不修改已存 Key」 */
  apiKey: string;
  extraHeaders: Record<string, string>;
  params: Record<string, number | string | boolean>;
  isDefault: boolean;
  enabled: boolean;
  /** 服务端下发的脱敏尾号，如 sk-****3f9a */
  apiKeyMasked?: string | null;
}

/** 新建配置时的空白草稿（默认选中 DeepSeek 预设，便于国内用户开箱即用） */
export function emptyDraft(): ProviderDraft {
  const preset = PROVIDER_PRESETS.deepseek;
  return {
    name: '',
    providerType: 'deepseek',
    baseUrl: preset.url,
    modelName: preset.model,
    apiKey: '',
    extraHeaders: {},
    params: { temperature: 0.7, max_tokens: 1024, top_p: 1 },
    isDefault: false,
    enabled: true,
    apiKeyMasked: null,
  };
}

/** 由服务端脱敏结构生成编辑草稿 */
export function draftFromSafe(item: {
  id: string;
  name: string;
  providerType: string;
  baseUrl: string;
  modelName: string;
  apiKeyMasked: string | null;
  extraHeaders: Record<string, string>;
  params: Record<string, unknown>;
  isDefault: boolean;
  enabled: boolean;
}): ProviderDraft {
  const type = (Object.keys(PROVIDER_PRESETS) as ProviderType[]).includes(item.providerType as ProviderType)
    ? (item.providerType as ProviderType)
    : 'custom';
  const params: Record<string, number | string | boolean> = {};
  for (const [k, v] of Object.entries(item.params ?? {})) {
    if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') params[k] = v;
  }
  return {
    id: item.id,
    name: item.name,
    providerType: type,
    baseUrl: item.baseUrl,
    modelName: item.modelName,
    apiKey: '',
    extraHeaders: item.extraHeaders ?? {},
    params,
    isDefault: item.isDefault,
    enabled: item.enabled,
    apiKeyMasked: item.apiKeyMasked,
  };
}

interface TestResult {
  ok: boolean;
  latency?: number;
  error?: string;
  /** 供应商实际服务的模型标识（可能带版本后缀） */
  servedModel?: string | null;
  /** 测试时填写的模型名（用于判断是否需要提示「实际模型」） */
  requestedModel?: string;
}

/** /api/models/list 返回的单个模型条目 */
interface ModelListItem {
  id: string;
  label?: string;
  version?: string;
  ownedBy?: string;
  createdAt?: string;
}

interface Props {
  value: ProviderDraft;
  onChange: (v: ProviderDraft) => void;
  /** 返回 null 表示保存成功，返回字符串表示错误文案 */
  onSave: (v: ProviderDraft) => Promise<string | null>;
  onClose: () => void;
  isNew: boolean;
}

const URL_RE = /^https?:\/\/.+/i;

export default function ProviderDrawer({ value, onChange, onSave, onClose, isNew }: Props) {
  const [showKey, setShowKey] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  /** 读取模型列表：状态 + 结果 + 过滤词 */
  const [listing, setListing] = useState(false);
  const [models, setModels] = useState<ModelListItem[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [listFilter, setListFilter] = useState('');

  const errors = useMemo(
    () => ({
      name: value.name.trim().length >= 2 ? '' : '名称至少 2 个字',
      baseUrl: URL_RE.test(value.baseUrl) ? '' : '需以 http/https 开头',
      modelName: value.modelName.trim() ? '' : '请填写模型名',
      apiKey: isNew
        ? value.apiKey.length >= 8
          ? ''
          : '请填写 API Key（至少 8 位）'
        : value.apiKey === '' || value.apiKey.length >= 8
          ? ''
          : 'API Key 至少 8 位（留空表示不修改）',
    }),
    [value, isNew],
  );
  const valid = !Object.values(errors).some(Boolean);

  /** 按过滤词筛选已读取到的模型 */
  const shown = useMemo(() => {
    if (!models) return [];
    const q = listFilter.trim().toLowerCase();
    if (!q) return models.slice(0, 200);
    return models
      .filter((m) => m.id.toLowerCase().includes(q) || (m.label ?? '').toLowerCase().includes(q))
      .slice(0, 200);
  }, [models, listFilter]);

  /** 读取供应商可用模型列表（服务端代发请求，避免浏览器 CORS 与密钥外泄） */
  async function doList() {
    if (!URL_RE.test(value.baseUrl)) {
      setListError('请先填写正确的 Base URL');
      return;
    }
    if (!value.id && value.apiKey.length < 8) {
      setListError('请先填写 API Key');
      return;
    }
    setListing(true);
    setListError(null);
    setModels(null);
    try {
      const r = await fetch('/api/models/list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: value.id,
          providerType: value.providerType,
          baseUrl: value.baseUrl,
          apiKey: value.apiKey || undefined,
          extraHeaders: value.extraHeaders,
        }),
      });
      if (r.status === 401) {
        setListError('登录已过期，请重新登录');
        return;
      }
      const d = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        models?: ModelListItem[];
        error?: string;
        message?: string;
      };
      if (d.ok && d.models?.length) {
        setModels(d.models);
      } else {
        setListError(d.error || d.message || '未读取到模型列表');
      }
    } catch {
      setListError('网络异常，无法读取模型列表');
    } finally {
      setListing(false);
    }
  }

  function onTypeChange(t: ProviderType) {
    const p = PROVIDER_PRESETS[t];
    onChange({ ...value, providerType: t, baseUrl: p.url || value.baseUrl, modelName: p.model || value.modelName });
    setTestResult(null);
    setModels(null);
    setListError(null);
    setListFilter('');
  }

  async function doTest() {
    if (!URL_RE.test(value.baseUrl) || !value.modelName.trim()) {
      setTestResult({ ok: false, error: '请先填写 Base URL 和模型名' });
      return;
    }
    if (!value.id && value.apiKey.length < 8) {
      setTestResult({ ok: false, error: '请先填写 API Key' });
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const r = await fetch('/api/models/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: value.id,
          providerType: value.providerType,
          baseUrl: value.baseUrl,
          apiKey: value.apiKey || undefined,
          modelName: value.modelName,
          extraHeaders: value.extraHeaders,
        }),
      });
      const d = (await r.json().catch(() => ({}))) as TestResult & { message?: string };
      if (r.status === 401) {
        setTestResult({ ok: false, error: '登录已过期，请重新登录' });
        return;
      }
      setTestResult({
        ok: !!d.ok,
        latency: d.latency,
        error: d.error || d.message,
        servedModel: d.servedModel,
        requestedModel: value.modelName,
      });
    } catch {
      setTestResult({ ok: false, error: '网络异常，无法完成测试' });
    } finally {
      setTesting(false);
    }
  }

  async function doSave() {
    if (!valid || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const err = await onSave(value);
      if (err) setSaveError(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* 遮罩 */}
      <div className="flex-1 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      <aside className="flex h-full w-full max-w-md flex-col border-l border-neon-blue/20 bg-panel shadow-2xl">
        <header className="sticky top-0 z-10 flex items-center justify-between border-b border-white/10 bg-panel/95 px-5 py-4 backdrop-blur">
          <h2 className="font-display text-lg text-neon-blue">
            {isNew ? '新增模型配置' : '编辑模型配置'}
          </h2>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="btn-ghost">
              取消
            </button>
            <button type="button" onClick={doSave} disabled={!valid || saving} className="btn-blue">
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto p-5">
          {saveError && (
            <div className="animate-rise rounded-lg border border-neon-red/40 bg-neon-red/10 px-3 py-2 text-xs text-neon-red">
              {saveError}
            </div>
          )}

          {/* 名称 */}
          <Field label="配置名称" error={errors.name}>
            <input
              value={value.name}
              onChange={(e) => onChange({ ...value, name: e.target.value })}
              placeholder="例如：我的 DeepSeek"
              className="field"
              maxLength={40}
            />
          </Field>

          {/* 供应商类型 */}
          <Field label="供应商类型">
            <select
              value={value.providerType}
              onChange={(e) => onTypeChange(e.target.value as ProviderType)}
              className="field"
            >
              {(Object.entries(PROVIDER_PRESETS) as [ProviderType, { label: string }][]).map(([k, v]) => (
                <option key={k} value={k} className="bg-panel">
                  {v.label}
                </option>
              ))}
            </select>
          </Field>

          {/* Base URL */}
          <Field label="Base URL" error={errors.baseUrl}>
            <input
              value={value.baseUrl}
              onChange={(e) => onChange({ ...value, baseUrl: e.target.value })}
              placeholder="https://api.example.com/v1"
              className="field font-mono text-sm"
            />
            <p className="mt-1 text-[11px] text-fog">
              需兼容 OpenAI 的 /chat/completions 接口；服务端会做 SSRF 校验（默认禁止内网地址）
            </p>
          </Field>

          {/* API Key */}
          <Field label="API Key" error={errors.apiKey}>
            <div className="relative">
              <input
                type={showKey ? 'text' : 'password'}
                value={value.apiKey}
                onChange={(e) => {
                  onChange({ ...value, apiKey: e.target.value });
                  setTestResult(null);
                }}
                placeholder={value.id ? '留空则不修改' : 'sk-...'}
                className="field pr-16 font-mono text-sm"
                autoComplete="off"
              />
              <button
                type="button"
                onClick={() => setShowKey((s) => !s)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-[11px] text-fog hover:text-neon-blue"
              >
                {showKey ? '隐藏' : '显示'}
              </button>
            </div>
            {!isNew && value.apiKeyMasked && (
              <p className="mt-1 font-mono text-[11px] text-fog">已保存：{value.apiKeyMasked}（留空则不修改）</p>
            )}
          </Field>

          {/* 模型名 + 读取列表 */}
          <Field label="模型名称" error={errors.modelName}>
            <div className="flex gap-2">
              <input
                value={value.modelName}
                onChange={(e) => onChange({ ...value, modelName: e.target.value })}
                placeholder="deepseek-chat"
                className="field font-mono text-sm"
              />
              <button
                type="button"
                onClick={doList}
                disabled={listing}
                title="从供应商 GET /models 读取可用模型与版本"
                className="btn-ghost shrink-0 whitespace-nowrap px-3 text-xs"
              >
                {listing ? '读取中…' : '读取列表'}
              </button>
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-fog">
              填好 Base URL 与 API Key 后点「读取列表」，可直接从供应商返回的模型里挑选（含版本号），避免手输写错。
            </p>
          </Field>

          {/* 读取结果 */}
          {listError && (
            <div className="rounded-lg border border-neon-red/40 bg-neon-red/10 px-3 py-2 text-[11px] leading-relaxed text-neon-red">
              ✗ {listError}
            </div>
          )}
          {models && (
            <div className="animate-rise rounded-lg border border-neon-blue/30 bg-black/30 p-2">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-[11px] text-neon-blue">共 {models.length} 个可用模型</span>
                <button
                  type="button"
                  onClick={() => setModels(null)}
                  className="text-[11px] text-fog hover:text-neon-red"
                >
                  收起
                </button>
              </div>
              <input
                value={listFilter}
                onChange={(e) => setListFilter(e.target.value)}
                placeholder="过滤：如 deepseek / gpt / claude"
                className="field mb-2 py-1 text-xs"
              />
              <ul className="max-h-56 space-y-1 overflow-y-auto pr-1">
                {shown.map((m) => (
                  <li key={m.id}>
                    <button
                      type="button"
                      onClick={() => {
                        onChange({ ...value, modelName: m.id });
                        setTestResult(null);
                      }}
                      className={cls(
                        'w-full rounded-md border px-2 py-1.5 text-left transition',
                        value.modelName === m.id
                          ? 'border-ok/50 bg-ok/10 text-ok'
                          : 'border-white/10 bg-black/20 text-[#e6f1ff] hover:border-neon-blue/40',
                      )}
                    >
                      <span className="block truncate font-mono text-[11px]">{m.id}</span>
                      {(m.label || m.version || m.ownedBy) && (
                        <span className="mt-0.5 block truncate text-[10px] text-fog">
                          {[m.label, m.version ? `version ${m.version}` : '', m.ownedBy]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
                {shown.length === 0 && <li className="px-2 py-1 text-[11px] text-fog">没有匹配的模型</li>}
              </ul>
            </div>
          )}

          {/* 测试结果 */}
          {testResult && (
            <div
              className={cls(
                'animate-rise rounded-lg border px-3 py-2 text-xs leading-relaxed',
                testResult.ok
                  ? 'border-ok/40 bg-ok/10 text-ok'
                  : 'border-neon-red/40 bg-neon-red/10 text-neon-red',
              )}
            >
              {testResult.ok
                ? `✓ 连接成功 · 延迟 ${testResult.latency ?? 0}ms` +
                  (testResult.servedModel && testResult.servedModel !== testResult.requestedModel
                    ? ` · 实际模型 ${testResult.servedModel}`
                    : '')
                : `✗ 连接失败：${testResult.error || '未知错误'}`}
            </div>
          )}

          <button type="button" onClick={doTest} disabled={testing} className="btn-ok w-full py-2">
            {testing ? '测试中…' : '测试连接'}
          </button>

          {/* 高级设置 */}
          <div>
            <button
              type="button"
              onClick={() => setAdvanced((a) => !a)}
              className="flex items-center gap-2 text-sm text-fog hover:text-neon-blue"
            >
              <span>{advanced ? '▾' : '▸'}</span> 高级设置
            </button>

            {advanced && (
              <div className="mt-4 space-y-5 pl-1">
                <Field label="额外请求头（JSON）">
                  <JsonEditor<Record<string, string>>
                    key={`headers:${value.id ?? 'new'}:${value.providerType}`}
                    value={value.extraHeaders}
                    onChange={(v) => onChange({ ...value, extraHeaders: v })}
                    placeholder='{ "X-Custom-Header": "value" }'
                  />
                </Field>

                <div className="grid grid-cols-3 gap-3">
                  <Field label="Temperature">
                    <input
                      type="number"
                      min={0}
                      max={2}
                      step={0.1}
                      value={Number(value.params?.temperature ?? 0.7)}
                      onChange={(e) =>
                        onChange({ ...value, params: { ...value.params, temperature: +e.target.value } })
                      }
                      className="field"
                    />
                  </Field>
                  <Field label="Max Tokens">
                    <input
                      type="number"
                      min={1}
                      max={32000}
                      value={Number(value.params?.max_tokens ?? 1024)}
                      onChange={(e) =>
                        onChange({ ...value, params: { ...value.params, max_tokens: +e.target.value } })
                      }
                      className="field"
                    />
                  </Field>
                  <Field label="Top P">
                    <input
                      type="number"
                      min={0}
                      max={1}
                      step={0.05}
                      value={Number(value.params?.top_p ?? 1)}
                      onChange={(e) => onChange({ ...value, params: { ...value.params, top_p: +e.target.value } })}
                      className="field"
                    />
                  </Field>
                </div>
                <p className="text-[11px] text-fog">
                  参数会随每次模型调用下发；不确定就保持默认值即可。
                </p>
              </div>
            )}
          </div>

          {/* 默认 / 启用 */}
          <div className="flex items-center justify-between border-t border-white/10 pt-3">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={!!value.isDefault}
                onChange={(e) => onChange({ ...value, isDefault: e.target.checked })}
                className="accent-neon-blue"
              />
              设为默认（新对局优先使用）
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={value.enabled !== false}
                onChange={(e) => onChange({ ...value, enabled: e.target.checked })}
                className="accent-ok"
              />
              启用
            </label>
          </div>
        </div>
      </aside>
    </div>
  );
}

/** 表单字段外壳：标签 + 内容 + 错误提示 */
function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="label">{label}</label>
      {children}
      {error && <p className="mt-1 text-[11px] text-neon-red">{error}</p>}
    </div>
  );
}