import { NextRequest, NextResponse } from 'next/server';
import { SignJWT } from 'jose';
import { getSessionFromRequest } from '@/lib/auth';

export const runtime = 'nodejs';

/**
 * GET /api/party-ticket
 * 为 PartyKit WebSocket 连接签发短时效票据（15 分钟）。
 *
 * 原因：会话 Cookie 是 httpOnly 的，客户端 JS 读不到；
 * 且 PartyKit 与 Next 可能不同域，Cookie 不会随 WS 发送。
 * 因此由服务端签发一枚专用 JWT，客户端通过 ?ticket= 传给房间服务器验证。
 */
export async function GET(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ code: 'UNAUTHORIZED', message: '请先登录' }, { status: 401 });
  }

  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 16) {
    return NextResponse.json({ code: 'SERVER_ERROR', message: 'JWT_SECRET 未配置' }, { status: 500 });
  }

  const ticket = await new SignJWT({ uid: session.uid, username: session.username, scope: 'party' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(new TextEncoder().encode(secret));

  return NextResponse.json({
    ticket,
    user: { id: session.uid, username: session.username },
  });
}