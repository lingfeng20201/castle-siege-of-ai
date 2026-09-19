'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { GameMode, LobbyRoom } from '@/lib/protocol';
import {
  MODE_DESC,
  MODE_LABEL,
  MODE_SHORT,
  TEAM_COLOR,
  cls,
  modeMaxPlayers,
  modeMinPlayers,
  randomRoomCode,
  sanitizeRoomCode,
  timeAgo,
} from '@/lib/client/ui';

/**
 * components/LobbyBoard.tsx —— 大厅面板（⑭ 的客户端部分）
 *
 * 功能：
 * - 选择模式 → 创建房间（随机房号，可自定义）
 * - 输入房号加入 / 从房间列表一键加入
 * - 房间列表来自 HTTP `/api/lobby`（Redis 心跳，90 秒无心跳自动剔除）
 * - 未配置模型时给出提示（未配置模型只能作为观众观战）
 */

export interface LobbyBoardProps {
  user: { id: string; username: string };
}

interface LobbyApiRoom extends LobbyRoom {
  updatedAt?: number;
}

const MODES: GameMode[] = ['ffa', 'team', 'siege', 'coop'];

export default function LobbyBoard({ user }: LobbyBoardProps) {
  const router = useRouter();
  const [mode, setMode] = useState<GameMode>('ffa');
  const [customCode, setCustomCode] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [rooms, setRooms] = useState<LobbyApiRoom[]>([]);
  const [loadingRooms, setLoadingRooms] = useState(false);
  const [modelCount, setModelCount] = useState<number | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  /* ── 房间列表轮询 ── */
  const loadRooms = useCallback(async () => {
    setLoadingRooms(true);
    try {
      const res = await fetch('/api/lobby', { cache: 'no-store' });
      if (res.ok) {
        const data = (await res.json()) as { rooms?: LobbyApiRoom[] };
        setRooms(Array.isArray(data.rooms) ? data.rooms : []);
      }
    } catch {
      /* 网络抖动忽略，下一轮继续 */
    } finally {
      setLoadingRooms(false);
    }
  }, []);

  useEffect(() => {
    void loadRooms();
    const timer = setInterval(() => void loadRooms(), 4000);
    return () => clearInterval(timer);
  }, [loadRooms]);

  /* ── 是否已配置模型（BYOK 参战前提） ── */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/models', { cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as { items?: unknown[] };
        if (!cancelled) setModelCount(Array.isArray(data.items) ? data.items.length : 0);
      } catch {
        /* 忽略 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  const liveRooms = useMemo(
    () => rooms.filter((r) => r.playerCount < r.maxPlayers || r.status === 'running'),
    [rooms],
  );

  function createRoom() {
    const code = sanitizeRoomCode(customCode) || randomRoomCode(6);
    router.push(`/room/${code}?mode=${mode}`);
  }

  function joinRoom(code: string) {
    const clean = sanitizeRoomCode(code);
    if (clean.length < 3) {
      setToast('房号至少 3 位');
      return;
    }
    router.push(`/room/${clean}`);
  }

  async function logout() {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {
      /* 忽略 */
    }
    router.replace('/login');
  }

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-6 p-4 sm:p-6">
      {/* ── 顶栏 ── */}
      <header className="panel flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-center gap-3">
          <span className="text-2xl">🏰</span>
          <div>
            <h1 className="font-display text-lg text-gold sm:text-xl">AI攻防战 · 城堡围攻</h1>
            <p className="text-[11px] text-fog">Castle Siege of AI · 全抽象化安全演练棋盘</p>
          </div>
        </div>

        <nav className="flex flex-wrap items-center gap-2 text-xs">
          <span className="chip border-ok/40 text-ok">⛨ {user.username}</span>
          <a className="btn-ghost" href="/settings/models">
            ⚙ 模型配置
          </a>
          <a className="btn-ghost" href="/settings/usage">
            📊 用量统计
          </a>
          <button className="btn-ghost" onClick={logout}>
            ⇤ 退出
          </button>
        </nav>
      </header>

      {/* ── 未配置模型提示 ── */}
      {modelCount === 0 && (
        <div className="panel border-warn/40 bg-warn/5 px-4 py-3 text-sm text-warn">
          ⚠ 你还没有配置大模型：可以进入房间观战，但「AI 托管 / 指挥官决策」不会工作。
          <a className="ml-2 underline" href="/settings/models">
            立即配置 →
          </a>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[400px_1fr]">
        {/* ── 创建房间 ── */}
        <section className="panel-neon flex flex-col gap-4 p-5">
          <h2 className="font-display text-base text-neon-blue">⚔ 创建对局</h2>

          <div className="grid grid-cols-2 gap-2">
            {MODES.map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={cls(
                  'rounded-lg border px-3 py-2 text-left text-xs transition-colors',
                  mode === m
                    ? 'border-neon-blue/60 bg-neon-blue/10 text-neon-blue'
                    : 'border-white/10 text-fog hover:bg-white/5',
                )}
              >
                <div className="text-sm">{MODE_LABEL[m]}</div>
                <div className="mt-1 text-[10px] leading-snug text-fog/80">{MODE_DESC[m]}</div>
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2 text-xs text-fog">
            <span className="chip border-white/15">人数 {modeMinPlayers(mode)}–{modeMaxPlayers(mode)}</span>
            <span className="chip border-white/15">40 回合上限</span>
            <span className="chip border-white/15">每回合 30 秒</span>
          </div>

          <div>
            <label className="label">自定义房号（可留空自动生成）</label>
            <input
              className="field font-mono uppercase"
              placeholder={randomRoomCode(6)}
              value={customCode}
              maxLength={16}
              onChange={(e) => setCustomCode(sanitizeRoomCode(e.target.value))}
            />
          </div>

          <button className="btn-gold" onClick={createRoom}>
            🚩 创建并进入房间
          </button>

          <div className="border-t border-white/10 pt-4">
            <label className="label">输入房号加入</label>
            <div className="flex gap-2">
              <input
                className="field font-mono uppercase"
                placeholder="例如 A7K2M9"
                value={joinCode}
                maxLength={16}
                onChange={(e) => setJoinCode(sanitizeRoomCode(e.target.value))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') joinRoom(joinCode);
                }}
              />
              <button className="btn-blue shrink-0" onClick={() => joinRoom(joinCode)}>
                加入
              </button>
            </div>
          </div>

          <p className="rounded-lg border border-white/10 bg-black/30 p-3 text-[11px] leading-relaxed text-fog">
            ⚠️ 安全边界：本游戏中的「攻击牌」只是对安全概念的<b>游戏化抽象标签</b>（如洪水术 ≈ 流量洪泛概念），
            胜负只在游戏数值层面结算，<b>不映射任何真实技术细节</b>，也不包含任何可执行攻击内容。
          </p>
        </section>

        {/* ── 房间列表 ── */}
        <section className="panel flex min-h-[360px] flex-col p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-display text-base text-gold">🏯 战局列表</h2>
            <button className="btn-ghost text-xs" onClick={() => void loadRooms()} disabled={loadingRooms}>
              {loadingRooms ? '刷新中…' : '↻ 刷新'}
            </button>
          </div>

          {liveRooms.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 text-fog">
              <div className="text-3xl opacity-60">🕯</div>
              <p className="text-sm">暂无进行中的战局</p>
              <p className="text-[11px]">创建一间新房，把房号发给你的对手吧</p>
            </div>
          ) : (
            <ul className="flex flex-col gap-3">
              {liveRooms.map((room) => {
                const full = room.playerCount >= room.maxPlayers;
                return (
                  <li
                    key={room.id}
                    className="animate-rise flex flex-wrap items-center justify-between gap-3 rounded-lg border border-white/10 bg-black/30 px-4 py-3"
                  >
                    <div className="flex items-center gap-3">
                      <span
                        className="flex h-9 w-9 items-center justify-center rounded-lg border text-xs"
                        style={{
                          borderColor: `${TEAM_COLOR.red}55`,
                          color: TEAM_COLOR.red,
                          background: 'rgba(255,59,92,0.06)',
                        }}
                      >
                        {MODE_SHORT[room.mode as GameMode] ?? '?'}
                      </span>
                      <div>
                        <div className="font-mono text-sm text-[#e6f1ff]">#{room.code}</div>
                        <div className="text-[11px] text-fog">
                          房主 {room.hostName} · 第 {room.turn} 回合 ·{' '}
                          {room.status === 'running' ? '进行中' : room.status === 'finished' ? '已结束' : '等待中'}
                          {typeof room.updatedAt === 'number' ? ` · ${timeAgo(room.updatedAt)}` : ''}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-3">
                      <span className="chip border-white/15 text-fog">
                        席位 {room.playerCount}/{room.maxPlayers}
                      </span>
                      <button
                        className={full ? 'btn-ghost' : 'btn-blue'}
                        onClick={() => joinRoom(room.id)}
                        title={full ? '席位已满，将以观众身份进入' : '加入对战'}
                      >
                        {full ? '观战' : '加入'}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      {toast && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-neon-blue/40 bg-panel px-4 py-2 text-sm text-neon-blue shadow-glow">
          {toast}
        </div>
      )}
    </div>
  );
}