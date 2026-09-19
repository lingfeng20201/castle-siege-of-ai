/**
 * lib/llm-core.ts —— 模型调用的「纯函数核心」（零 Node 依赖）
 *
 * 可同时被两处复用：
 * 1. lib/llm.ts（Next.js Node 侧：增加用量落库）
 * 2. party/battle.ts（PartyKit / Cloudflare Workers 侧：直接调用）
 *
 * 因此本文件严禁引入 pg / ioredis / node:* 等模块。
 *
 * 支持三类适配器：
 * - OpenAI 兼容（openai / deepseek / qwen / zhipu / moonshot / ollama / custom）
 * - Anthropic Messages API
 * - Google Gemini generateContent
 */

import { estimateTokens } from './pricing';
import type { ResourceBag } from './cards';
import type { CommanderDecision, PlayCardIntent } from './protocol';

export interface LlmProviderConfig {
  providerType: string;
  baseUrl: string;
  modelName: string;
  apiKey: string;
  extraHeaders?: Record<string, string>;
  params?: Record<string, unknown>;
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmCallOptions {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  timeoutMs?: number;
  /** 请求模型返回 JSON（OpenAI: response_format / Gemini: responseMimeType） */
  jsonMode?: boolean;
}

export interface LlmCallResult {
  text: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  latencyMs: number;
  /** 供应商实际服务的模型标识（响应里的 model / modelVersion），用于展示「实际版本」 */
  servedModel?: string;
}

export class LlmError extends Error {
  status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
  }
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** 脱敏（不得引入 logger 模块，Workers 环境下保持一致行为） */
function sanitize(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_\-]{6,}/g, 'sk-***')
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer ***');
}

/* ══════════════════════ 统一调用入口 ══════════════════════ */

export async function callModel(
  cfg: LlmProviderConfig,
  messages: LlmMessage[],
  opts: LlmCallOptions = {},
): Promise<LlmCallResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const result =
      cfg.providerType === 'anthropic'
        ? await callAnthropic(cfg, messages, opts, controller.signal)
        : cfg.providerType === 'gemini'
          ? await callGemini(cfg, messages, opts, controller.signal)
          : await callOpenAiCompatible(cfg, messages, opts, controller.signal);
    return { ...result, latencyMs: Date.now() - started };
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new LlmError(`请求超时（${timeoutMs}ms）`, 504);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

type RawResult = { text: string; usage: LlmCallResult['usage']; servedModel?: string };

async function callOpenAiCompatible(
  cfg: LlmProviderConfig,
  messages: LlmMessage[],
  opts: LlmCallOptions,
  signal: AbortSignal,
): Promise<RawResult> {
  const url = joinUrl(cfg.baseUrl, '/chat/completions');
  const body: Record<string, unknown> = {
    model: cfg.modelName,
    messages,
    temperature: opts.temperature ?? (cfg.params?.temperature as number) ?? 0.7,
    max_tokens: opts.maxTokens ?? (cfg.params?.max_tokens as number) ?? 1024,
  };
  if (opts.jsonMode && cfg.providerType !== 'ollama') {
    body.response_format = { type: 'json_object' };
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
      ...(cfg.extraHeaders ?? {}),
    },
    body: JSON.stringify(body),
    signal,
  });
  const text = await res.text();
  if (!res.ok) throw new LlmError(truncate(sanitize(text), 300), res.status);
  const data = JSON.parse(text) as {
    model?: string;
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };
  const content = data.choices?.[0]?.message?.content ?? '';
  const promptTokens =
    data.usage?.prompt_tokens ?? estimateTokens(messages.map((m) => m.content).join('\n'));
  const completionTokens = data.usage?.completion_tokens ?? estimateTokens(content);
  return {
    text: content,
    servedModel: data.model,
    usage: {
      promptTokens,
      completionTokens,
      totalTokens: data.usage?.total_tokens ?? promptTokens + completionTokens,
    },
  };
}

async function callAnthropic(
  cfg: LlmProviderConfig,
  messages: LlmMessage[],
  opts: LlmCallOptions,
  signal: AbortSignal,
): Promise<RawResult> {
  const url = joinUrl(cfg.baseUrl, '/messages');
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n');
  const convo = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
      ...(cfg.extraHeaders ?? {}),
    },
    body: JSON.stringify({
      model: cfg.modelName,
      max_tokens: opts.maxTokens ?? (cfg.params?.max_tokens as number) ?? 1024,
      temperature: opts.temperature ?? (cfg.params?.temperature as number) ?? 0.7,
      system: system || undefined,
      messages: convo,
    }),
    signal,
  });
  const text = await res.text();
  if (!res.ok) throw new LlmError(truncate(sanitize(text), 300), res.status);
  const data = JSON.parse(text) as {
    model?: string;
    content?: Array<{ type: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const out = (data.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('');
  const promptTokens =
    data.usage?.input_tokens ?? estimateTokens(messages.map((m) => m.content).join('\n'));
  const completionTokens = data.usage?.output_tokens ?? estimateTokens(out);
  return { text: out, servedModel: data.model, usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens } };
}

async function callGemini(
  cfg: LlmProviderConfig,
  messages: LlmMessage[],
  opts: LlmCallOptions,
  signal: AbortSignal,
): Promise<RawResult> {
  const model = cfg.modelName.replace(/^models\//, '');
  const url =
    `${joinUrl(cfg.baseUrl, `/models/${encodeURIComponent(model)}:generateContent`)}` +
    `?key=${encodeURIComponent(cfg.apiKey)}`;
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n');
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cfg.extraHeaders ?? {}) },
    body: JSON.stringify({
      contents,
      systemInstruction: system ? { parts: [{ text: system }] } : undefined,
      generationConfig: {
        temperature: opts.temperature ?? (cfg.params?.temperature as number) ?? 0.7,
        maxOutputTokens: opts.maxTokens ?? (cfg.params?.max_tokens as number) ?? 1024,
        ...(opts.jsonMode ? { responseMimeType: 'application/json' } : {}),
      },
    }),
    signal,
  });
  const text = await res.text();
  if (!res.ok) throw new LlmError(truncate(sanitize(text), 300), res.status);
  const data = JSON.parse(text) as {
    modelVersion?: string;
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
  };
  const out = (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
  const promptTokens =
    data.usageMetadata?.promptTokenCount ?? estimateTokens(messages.map((m) => m.content).join('\n'));
  const completionTokens = data.usageMetadata?.candidatesTokenCount ?? estimateTokens(out);
  return {
    text: out,
    servedModel: data.modelVersion ?? cfg.modelName,
    usage: {
      promptTokens,
      completionTokens,
      totalTokens: data.usageMetadata?.totalTokenCount ?? promptTokens + completionTokens,
    },
  };
}

/* ══════════════════════ 模型列表（读取供应商可用模型 / 版本） ══════════════════════ */

export interface LlmModelInfo {
  /** 提交给 API 的 model 标识 */
  id: string;
  /** 展示名（Anthropic display_name / Gemini displayName） */
  label?: string;
  /** 版本号（Gemini 的 version 字段；OpenAI 兼容供应商一般无此字段） */
  version?: string;
  /** 归属方（OpenAI 兼容的 owned_by） */
  ownedBy?: string;
  /** 创建时间（原始值转字符串） */
  createdAt?: string;
}

type ListCfg = Pick<LlmProviderConfig, 'providerType' | 'baseUrl' | 'apiKey' | 'extraHeaders'>;

/**
 * 读取供应商的可用模型列表（用于「读取模型列表」按钮，避免手输模型名写错）。
 *
 * - OpenAI 兼容 / Ollama：GET {base}/models → { data: [{ id, owned_by, created }] }
 * - Anthropic：GET {base}/models → { data: [{ id, display_name, created_at }] }
 * - Gemini：GET {base}/models?key=… → { models: [{ name, displayName, version }] }
 * 额外兼容裸数组 / { models: [] } / { data: { models: [] } } 等变体。
 */
export async function listModels(cfg: ListCfg, opts: { timeoutMs?: number } = {}): Promise<LlmModelInfo[]> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const headers: Record<string, string> = { ...(cfg.extraHeaders ?? {}) };
  let url: string;
  if (cfg.providerType === 'gemini') {
    url = `${joinUrl(cfg.baseUrl, '/models')}?key=${encodeURIComponent(cfg.apiKey)}`;
  } else if (cfg.providerType === 'anthropic') {
    url = joinUrl(cfg.baseUrl, '/models');
    headers['x-api-key'] = cfg.apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else {
    url = joinUrl(cfg.baseUrl, '/models');
    headers.Authorization = `Bearer ${cfg.apiKey}`;
  }

  try {
    const res = await fetch(url, { method: 'GET', headers, signal: controller.signal });
    const text = await res.text();
    if (!res.ok) throw new LlmError(truncate(sanitize(text), 300), res.status);

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new LlmError('返回内容不是合法 JSON（该供应商可能不支持 /models 接口）', 502);
    }

    const out: LlmModelInfo[] = [];
    const seen = new Set<string>();
    for (const item of extractModelArray(parsed)) {
      const info = normalizeModel(item, cfg.providerType);
      if (!info || seen.has(info.id)) continue;
      seen.add(info.id);
      out.push(info);
    }
    out.sort((a, b) => a.id.localeCompare(b.id));
    return out.slice(0, 300);
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new LlmError(`请求超时（${timeoutMs}ms）`, 504);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** 从各种返回结构里取出模型数组 */
function extractModelArray(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') {
    const o = parsed as Record<string, unknown>;
    for (const key of ['data', 'models', 'model_list', 'items']) {
      const v = o[key];
      if (Array.isArray(v)) return v;
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const inner = (v as Record<string, unknown>).models;
        if (Array.isArray(inner)) return inner;
      }
    }
  }
  return [];
}

/** 把不同供应商的模型条目归一化为 { id, label, version, ownedBy, createdAt } */
function normalizeModel(item: unknown, providerType: string): LlmModelInfo | null {
  if (typeof item === 'string') return { id: item };
  if (!item || typeof item !== 'object') return null;
  const o = item as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

  let id = str(o.id) ?? str(o.model) ?? str(o.name);
  if (!id) return null;
  if (providerType === 'gemini' || id.startsWith('models/')) id = id.replace(/^models\//, '');

  const created = o.created ?? o.created_at ?? o.createdAt;
  return {
    id,
    label: str(o.display_name) ?? str(o.displayName) ?? str(o.friendly_name),
    version: str(o.version) ?? str(o.modelVersion),
    ownedBy: str(o.owned_by) ?? str(o.ownedBy),
    createdAt: typeof created === 'number' || typeof created === 'string' ? String(created) : undefined,
  };
}

/* ══════════════════════ 模型角色 ══════════════════════ */

export const MODEL_ROLES = ['commander', 'judge', 'report', 'test'] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

/* ══════════════════════ 指挥官（模型决策） ══════════════════════ */

/** 发送给模型的战场视图（只包含该玩家应当知道的信息） */
export interface CommanderView {
  turn: number;
  maxTurns: number;
  resources: ResourceBag;
  self: {
    id: string;
    nickname: string;
    keepHp: number;
    shield: number;
    outerWallHp: number;
    innerWallHp: number;
    towers: number;
    /** 常备军编制（各兵种数量） */
    troops: Record<string, number>;
    troopsTotal: number;
  };
  hand: Array<{
    id: string;
    name: string;
    kind: string;
    cost: Record<string, number>;
    targeting: string;
    desc: string;
    tag: string;
  }>;
  enemies: Array<{
    id: string;
    nickname: string;
    keepHp: number;
    outerWallHp: number;
    innerWallHp: number;
    towers: number;
    troopsTotal: number;
    threat: number;
  }>;
  allies: Array<{ id: string; nickname: string; keepHp: number }>;
  legalTargets: string[];
  recentEvents: string[];
}

export function buildCommanderSystemPrompt(): string {
  return [
    '你是《AI攻防战：城堡围攻》的指挥官。目标是让你的城堡存活，并摧毁所有敌人的城堡。',
    '你会收到当前战场态势（JSON）。请从手牌中挑选 0-3 张牌并指定合法目标，做出本回合最有利的决策。',
    '只输出如下严格 JSON，不输出任何其他文字：',
    '{"cards":[{"id":"卡牌ID","target":"目标玩家ID"}],"reason":"一句话理由"}',
    '无需目标的牌（targeting=none）省略 target；裂墙 / 铁匠之锤可加 "layer":"outer" 或 "inner"。',
  ].join('\n');
}

export function buildCommanderUserMessage(view: CommanderView): string {
  return JSON.stringify(view, null, 2);
}

/**
 * 解析模型返回的指挥官决策。
 * - 严格校验 cardId 是否在手牌中、target 是否合法
 * - 非法返回 → 返回 null（调用方使用「弃甲」保底）
 */
export function parseCommanderDecision(
  raw: string,
  ctx: { hand: string[]; legalTargets: string[] },
): CommanderDecision | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;

  let obj: unknown;
  try {
    obj = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;

  const o = obj as { cards?: unknown; reason?: unknown };
  if (!Array.isArray(o.cards)) return null;

  const cards: PlayCardIntent[] = [];
  for (const c of o.cards.slice(0, 3)) {
    if (!c || typeof c !== 'object') continue;
    const e = c as { id?: unknown; target?: unknown; layer?: unknown; sacrifice?: unknown };
    if (typeof e.id !== 'string' || !ctx.hand.includes(e.id)) continue;

    let target: string | undefined;
    if (typeof e.target === 'string' && ctx.legalTargets.includes(e.target)) target = e.target;

    const layer = e.layer === 'inner' ? 'inner' : e.layer === 'outer' ? 'outer' : undefined;
    const sacrifice = typeof e.sacrifice === 'string' ? e.sacrifice : undefined;
    cards.push({ id: e.id, target, layer, sacrifice });
  }

  if (cards.length === 0) return null;
  return { cards, reason: typeof o.reason === 'string' ? o.reason.slice(0, 200) : '' };
}

/* ══════════════════════ AI 裁判 / 战报 ══════════════════════ */

/** 每回合结束后的 50 字内战况点评 */
export function buildJudgePrompt(summary: string): LlmMessage[] {
  return [
    {
      role: 'system',
      content:
        '你是《AI攻防战：城堡围攻》的 AI 裁判。用不超过 50 字的一句中文，点评刚结束的回合战况，风格像严肃的战场播报。只输出点评本身。',
    },
    { role: 'user', content: summary },
  ];
}

/** 战斗结束后的战报叙事 */
export function buildReportPrompt(summary: string): LlmMessage[] {
  return [
    {
      role: 'system',
      content:
        '你是《AI攻防战：城堡围攻》的战报官。根据对局记录，写一段 150-250 字的史诗战报叙事（中文），包含关键转折与最终胜负。只输出战报本身。',
    },
    { role: 'user', content: summary },
  ];
}