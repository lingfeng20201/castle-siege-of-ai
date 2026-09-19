import { isIP } from 'node:net';

/**
 * lib/ssrf.ts —— Base URL SSRF 防护
 *
 * 禁止指向内网 / 本机 / 保留地址；
 * 本地地址（如 Ollama http://localhost:11434）需 ALLOW_LOCAL_MODEL_URL=true。
 */

const BLOCKED_NAMES = new Set(['localhost', 'metadata.google.internal', 'metadata', 'instance-data']);

export function isPrivateAddress(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (BLOCKED_NAMES.has(h)) return true;
  if (h.endsWith('.local') || h.endsWith('.internal')) return true;

  const v = isIP(h);
  if (v === 4 || /^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
    const parts = h.split('.').map(Number);
    if (parts.length === 4 && parts.every((n) => n >= 0 && n <= 255)) {
      const [a, b] = parts;
      if (a === 0 || a === 10 || a === 127) return true;
      if (a === 169 && b === 254) return true; // link-local / 云元数据
      if (a === 172 && b >= 16 && b <= 31) return true;
      if (a === 192 && b === 168) return true;
      if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
      if (a >= 224) return true; // 组播 / 保留
    }
    return false;
  }

  if (v === 6) {
    if (h === '::1') return true;
    if (/^f[cd]/.test(h)) return true; // fc00::/7
    if (h.startsWith('fe80')) return true; // fe80::/10
    const mapped = h.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (mapped) return isPrivateAddress(mapped[1]);
  }
  return false;
}

export function assertSafeBaseUrl(raw: string, opts: { allowLocal?: boolean } = {}): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Base URL 不合法');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Base URL 仅支持 http/https');
  }
  if (!opts.allowLocal && isPrivateAddress(url.hostname)) {
    throw new Error('该地址不被允许（内网/本机地址已屏蔽）');
  }
  return url;
}