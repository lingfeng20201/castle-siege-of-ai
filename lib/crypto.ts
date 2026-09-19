import crypto from 'node:crypto';

/**
 * lib/crypto.ts —— API Key 加密（AES-256-GCM）
 *
 * - 密钥来自 MODEL_ENC_KEY（openssl rand -base64 32）
 * - 每条记录独立随机 IV
 * - 前端永远拿不到明文，回显 sk-****tail
 */

export interface EncryptedSecret {
  enc: string;
  iv: string;
  tag: string;
  tail: string;
}

function encKey(): Buffer {
  const raw = process.env.MODEL_ENC_KEY;
  if (!raw) throw new Error('MODEL_ENC_KEY 未配置（openssl rand -base64 32 生成）');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('MODEL_ENC_KEY 必须是 32 字节的 Base64');
  return key;
}

export function encryptSecret(plain: string): EncryptedSecret {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    enc: enc.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    tail: plain.slice(-4),
  };
}

export function decryptSecret(s: { enc: string; iv: string; tag: string }): string {
  const decipher = crypto.createDecipheriv('aes-256-gcm', encKey(), Buffer.from(s.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(s.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(s.enc, 'base64')), decipher.final()]).toString('utf8');
}

/** sk-****3f9a */
export function maskKey(tail: string | null | undefined): string | null {
  return tail ? `sk-****${tail}` : null;
}