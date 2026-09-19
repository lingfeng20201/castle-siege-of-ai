import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import LobbyBoard from '@/components/LobbyBoard';

/**
 * app/page.tsx —— 大厅（⑭）
 *
 * 服务端守卫：未登录直接跳转 /login；
 * 大厅交互（创建房间 / 加入房间 / 房间列表轮询）由客户端组件 LobbyBoard 承担。
 */

export const dynamic = 'force-dynamic';

export default async function LobbyPage() {
  const session = await getSession();
  if (!session) redirect('/login');

  return <LobbyBoard user={{ id: session.uid, username: session.username }} />;
}