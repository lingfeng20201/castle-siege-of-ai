'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { BattleEvent, ClientMessage, GameMode, GameReport, RoomSnapshot, ServerMessage } from '../protocol';
import { partyHost, partyPartyName } from './ui';

/**
 * lib/client/socket.ts —— 对战房间 WebSocket 客户端
 *
 * 约定（与服务端 party/battle.ts 对齐）：
 * - 连接地址：ws(s)://<PARTYKIT_HOST>/parties/<party>/<roomId>?ticket=<JWT>&mode=<mode>
 * - ticket 由 `/api/party-ticket` 签发（15 分钟），断线重连时自动重新获取
 * - 服务端权威：客户端只发意图（action:play / player:ready / …）
 */

export interface BattleSocketState {
  snapshot: RoomSnapshot | null;
  me: { id: string; nickname: string } | null;
  connected: boolean;
  connecting: boolean;
  /** 不可恢复错误（如未登录） */
  fatal: string | null;
  /** 短暂错误提示（如人数不足） */
  lastError: string | null;
  /** 本局累计的结算事件（供战场动画消费） */
  events: BattleEvent[];
  report: GameReport | null;
  send: (msg: ClientMessage) => boolean;
  reconnect: () => void;
}
export function useBattleSocket(opts: { roomId: string; mode: GameMode | null }): BattleSocketState {
  const { roomId, mode } = opts;
  /** mode 只影响“首次建连时的房间模式”，因此用 ref 传入，避免其变化触发重连 */
  const modeRef = useRef<GameMode | null>(mode);
  modeRef.current = mode;


  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const [me, setMe] = useState<{ id: string; nickname: string } | null>(null);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(true);
  const [fatal, setFatal] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [events, setEvents] = useState<BattleEvent[]>([]);
  const [report, setReport] = useState<GameReport | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stoppedRef = useRef(false);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearRetry = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const connect = useCallback(async () => {
    if (stoppedRef.current) return;
    if (!roomId) return;
    setConnecting(true);

    // 1) 取票据（会话 Cookie 是 httpOnly，浏览器侧拿不到；且 WS 跨域不带 Cookie）
    let ticket = '';
    try {
      const res = await fetch('/api/party-ticket', { cache: 'no-store' });
      if (res.status === 401) {
        setFatal('请先登录后再进入房间');
        setConnecting(false);
        return;
      }
      if (!res.ok) throw new Error(`ticket ${res.status}`);
      const data = (await res.json()) as { ticket?: string };
      ticket = data.ticket ?? '';
      if (!ticket) throw new Error('empty ticket');
    } catch {
      // 取票失败：稍后重试
      setConnecting(false);
      retryRef.current += 1;
      const wait = Math.min(1000 * 2 ** Math.min(retryRef.current, 4), 15_000);
      clearRetry();
      timerRef.current = setTimeout(() => void connect(), wait);
      return;
    }

    // 2) 建连
    const host = partyHost();
    const proto = host.startsWith('ws') ? '' : window.location.protocol === 'https:' ? 'wss://' : 'ws://';
    const party = partyPartyName();
    const modeQuery = modeRef.current ? `&mode=${encodeURIComponent(modeRef.current)}` : '';
    const url = `${proto}${host}/parties/${party}/${encodeURIComponent(roomId)}?ticket=${encodeURIComponent(ticket)}${modeQuery}`;

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      setConnecting(false);
      return;
    }
    wsRef.current = ws;

    ws.onopen = () => {
      retryRef.current = 0;
      setConnected(true);
      setConnecting(false);
      setFatal(null);
    };

    ws.onmessage = (ev: MessageEvent<string>) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '') as ServerMessage;
      } catch {
        return;
      }

      switch (msg.t) {
        case 'hello':
          setMe(msg.you ? { id: msg.you.id, nickname: msg.you.nickname } : null);
          break;

        case 'room:state':
          setSnapshot(msg.snapshot);
          if (msg.snapshot.status === 'waiting' && msg.snapshot.turn === 0) {
            setEvents([]);
            setReport(null);
          }
          break;

        case 'room:patch':
          setSnapshot((prev) => (prev ? { ...prev, ...msg.delta } : prev));
          break;

        case 'turn:start':
          setSnapshot((prev) =>
            prev
              ? { ...prev, turn: msg.turn, phase: msg.phase, phaseDeadline: msg.deadline, status: 'running' }
              : prev,
          );
          break;

        case 'turn:resolve':
          setEvents((prev) => {
            const next = [...prev, ...msg.events];
            return next.length > 400 ? next.slice(-400) : next;
          });
          break;

        case 'ally:update':
          setSnapshot((prev) => (prev ? { ...prev, alliances: msg.alliances } : prev));
          break;

        case 'game:over':
          setReport(msg.report);
          setSnapshot((prev) => (prev ? { ...prev, status: 'finished', phase: 'finished' } : prev));
          break;

        case 'error':
          setLastError(msg.message);
          if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
          errorTimerRef.current = setTimeout(() => setLastError(null), 3200);
          break;

        default:
          break;
      }
    };

    ws.onclose = () => {
      setConnected(false);
      setConnecting(false);
      wsRef.current = null;
      if (stoppedRef.current) return;
      retryRef.current += 1;
      const wait = Math.min(800 * 2 ** Math.min(retryRef.current, 5), 12_000);
      clearRetry();
      timerRef.current = setTimeout(() => void connect(), wait);
    };

    ws.onerror = () => {
      // 触发 onclose 走重连流程
      try {
        ws.close();
      } catch {
        /* 忽略 */
      }
    };
  }, [clearRetry, roomId]);

  useEffect(() => {
    stoppedRef.current = false;
    void connect();
    return () => {
      stoppedRef.current = true;
      clearRetry();
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws) {
        ws.onclose = null;
        try {
          ws.close(1000, 'leaving');
        } catch {
          /* 忽略 */
        }
      }
    };
  }, [connect, clearRetry]);

  const send = useCallback((msg: ClientMessage): boolean => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }, []);

  const reconnect = useCallback(() => {
    const ws = wsRef.current;
    if (ws) {
      try {
        ws.close(1000, 'manual');
      } catch {
        /* 忽略 */
      }
    }
    retryRef.current = 0;
    void connect();
  }, [connect]);

  return { snapshot, me, connected, connecting, fatal, lastError, events, report, send, reconnect };
}