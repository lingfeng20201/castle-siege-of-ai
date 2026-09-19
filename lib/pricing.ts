/**
 * lib/pricing.ts —— 模型单价表 + 费用 / token 估算
 * 单价单位：美元 / 1K tokens
 */

export const PRICE_PER_1K: Record<string, { in: number; out: number }> = {
  'gpt-4o-mini': { in: 0.00015, out: 0.0006 },
  'deepseek-chat': { in: 0.00014, out: 0.00028 },
  'qwen-plus': { in: 0.0004, out: 0.0012 },
  'glm-4-flash': { in: 0.0001, out: 0.0001 },
  'moonshot-v1-8k': { in: 0.012, out: 0.012 },
  'claude-3-5-sonnet': { in: 0.003, out: 0.015 },
  'gemini-1.5-flash': { in: 0.000075, out: 0.0003 },
  default: { in: 0.001, out: 0.002 },
};

export function priceFor(modelName: string): { in: number; out: number } {
  const m = (modelName || '').toLowerCase();
  if (PRICE_PER_1K[m]) return PRICE_PER_1K[m];
  for (const key of Object.keys(PRICE_PER_1K)) {
    if (key !== 'default' && m.includes(key)) return PRICE_PER_1K[key];
  }
  return PRICE_PER_1K.default;
}

export function estimateCost(modelName: string, promptTokens: number, completionTokens: number): number {
  const p = priceFor(modelName);
  return (promptTokens / 1000) * p.in + (completionTokens / 1000) * p.out;
}

/**
 * 无 usage 时的 token 估算（启发式，零依赖；如需精确值可替换为 tiktoken）。
 * 中文 ≈ 1.5 字/token；其他 ≈ 4 字符/token。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  for (const ch of text) {
    if (/[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/.test(ch)) cjk += 1;
  }
  const others = text.length - cjk;
  return Math.max(1, Math.ceil(cjk / 1.5 + others / 4));
}