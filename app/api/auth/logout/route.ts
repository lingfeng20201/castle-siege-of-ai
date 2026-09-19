import { NextResponse } from 'next/server';
import { SESSION_COOKIE } from '@/lib/auth';

export const runtime = 'nodejs';

/**
 * POST /api/auth/logout
 * 清除会话 Cookie。
 */
export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set({ name: SESSION_COOKIE, value: '', path: '/', maxAge: 0 });
  return res;
}