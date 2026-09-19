import { z } from 'zod';

/**
 * lib/providers.ts —— 模型供应商预设 + 校验 + 脱敏
 */

export const PROVIDER_TYPES = [
  'openai',
  'deepseek',
  'qwen',
  'zhipu',
  'moonshot',
  'anthropic',
  'gemini',
  'ollama',
  'custom',
] as const;

export type ProviderType = (typeof PROVIDER_TYPES)[number];

export const PROVIDER_PRESETS: Record<ProviderType, { label: string; url: string; model: string }> = {
  openai: { label: 'OpenAI', url: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  deepseek: { label: 'DeepSeek', url: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  qwen: { label: '通义千问', url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  zhipu: { label: '智谱 GLM', url: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  moonshot: { label: 'Moonshot', url: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  anthropic: { label: 'Anthropic', url: 'https://api.anthropic.com/v1', model: 'claude-3-5-sonnet-latest' },
  gemini: { label: 'Gemini', url: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-1.5-flash' },
  ollama: { label: 'Ollama 本地', url: 'http://localhost:11434/v1', model: 'llama3.1' },
  custom: { label: '自定义', url: '', model: '' },
};

/* ── zod 校验 ── */

export const providerCreateSchema = z.object({
  name: z.string().trim().min(2, '名称至少 2 个字').max(40),
  providerType: z.enum(PROVIDER_TYPES),
  baseUrl: z
    .string()
    .trim()
    .refine((u) => /^https?:\/\/.+/i.test(u), '需以 http/https 开头'),
  modelName: z.string().trim().min(1, '请填写模型名').max(120),
  apiKey: z.string().trim().min(8, 'API Key 至少 8 位').max(512),
  extraHeaders: z.record(z.string(), z.string()).optional(),
  params: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).optional(),
  isDefault: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

export const providerPatchSchema = providerCreateSchema.partial();

/* ── 脱敏 ── */

export type ProviderRow = {
  id: string;
  user_id: string;
  name: string;
  provider_type: string;
  base_url: string;
  api_key_tail: string | null;
  model_name: string;
  extra_headers: Record<string, string> | null;
  params: Record<string, unknown> | null;
  is_default: boolean;
  enabled: boolean;
  last_tested_at: string | null;
  last_test_ok: boolean | null;
  usage_count: string | number;
  total_tokens: string | number;
  total_cost: string | number;
  created_at: string;
  updated_at: string;
};

/** 数据库行 → 可下发前端的脱敏结构（永不包含密文/明文 key） */
export function toSafeProvider(row: ProviderRow) {
  return {
    id: row.id,
    name: row.name,
    providerType: row.provider_type,
    baseUrl: row.base_url,
    modelName: row.model_name,
    apiKeyMasked: row.api_key_tail ? `sk-****${row.api_key_tail}` : null,
    extraHeaders: row.extra_headers ?? {},
    params: row.params ?? {},
    isDefault: row.is_default,
    enabled: row.enabled,
    lastTestedAt: row.last_tested_at,
    lastTestOk: row.last_test_ok,
    usageCount: Number(row.usage_count ?? 0),
    totalTokens: Number(row.total_tokens ?? 0),
    totalCost: Number(row.total_cost ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type SafeProvider = ReturnType<typeof toSafeProvider>;