/**
 * lib/logger.ts —— 结构化日志 + 密钥过滤
 *
 * 日志中永远不出现 sk- / Bearer / api_key / password 明文。
 */

const PATTERNS: Array<[RegExp, string]> = [
  [/sk-[A-Za-z0-9_\-]{6,}/g, 'sk-***'],
  [/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer ***'],
  [/((?:api[_-]?key|apikey|password|secret|token)["'\s:=]+)[^\s"',;}]+/gi, '$1***'],
  [/\b\d{6}\b/g, '******'], // 六位验证码
];

export function redact(input: unknown): string {
  let s: string;
  if (typeof input === 'string') {
    s = input;
  } else {
    try {
      s = JSON.stringify(input);
    } catch {
      s = String(input);
    }
  }
  for (const [re, rep] of PATTERNS) s = s.replace(re, rep);
  return s;
}

type Level = 'debug' | 'info' | 'warn' | 'error';

function emit(level: Level, msg: string, meta?: unknown): void {
  if (level === 'debug' && process.env.NODE_ENV === 'production') return;
  const line = `[csai:${level}] ${msg}` + (meta === undefined ? '' : ` ${redact(meta)}`);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (msg: string, meta?: unknown) => emit('debug', msg, meta),
  info: (msg: string, meta?: unknown) => emit('info', msg, meta),
  warn: (msg: string, meta?: unknown) => emit('warn', msg, meta),
  error: (msg: string, meta?: unknown) => emit('error', msg, meta),
};