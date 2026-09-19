'use client';

import { useEffect, useRef, useState } from 'react';
import type { LogEntry } from '@/lib/protocol';
import { cls } from '@/lib/client/ui';

/**
 * components/BattleLog.tsx —— 战斗日志（⑲）
 *
 * - 频道着色：battle 战斗 / system 系统 / judge AI 裁判 / chat 聊天
 * - 自动滚动到底部（用户上滚时暂停自动滚动）
 * - 底部聊天输入：Enter 发送（需求文档快捷键）
 */

export interface BattleLogProps {
  logs: LogEntry[];
  onSend: (text: string, channel: 'chat' | 'battle') => void;
  /** 发送失败（未连接）时提示 */
  disabled?: boolean;
}

const CHANNEL_STYLE: Record<LogEntry['channel'], string> = {
  battle: 'text-[#ffb020]',
  system: 'text-fog',
  judge: 'text-neon-blue',
  chat: 'text-[#e6f1ff]',
};

const CHANNEL_TAG: Record<LogEntry['channel'], string> = {
  battle: '战',
  system: '系',
  judge: '判',
  chat: '聊',
};

export default function BattleLog({ logs, onSend, disabled }: BattleLogProps) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [text, setText] = useState('');
  const [channel, setChannel] = useState<'chat' | 'battle'>('chat');

  useEffect(() => {
    if (!autoScroll) return;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs, autoScroll]);

  function handleScroll() {
    const el = listRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    setAutoScroll(atBottom);
  }

  function submit() {
    const clean = text.trim();
    if (!clean) return;
    onSend(clean.slice(0, 200), channel);
    setText('');
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-white/10 px-2 py-1 text-[10px] text-fog">
        <span>战斗日志 / 聊天</span>
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(e) => setAutoScroll(e.target.checked)}
            className="h-3 w-3 accent-[#00f0ff]"
          />
          自动滚动
        </label>
      </div>

      <div
        ref={listRef}
        onScroll={handleScroll}
        className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 py-1 text-[11px] leading-relaxed"
      >
        {logs.length === 0 && <div className="py-4 text-center text-fog/70">暂无记录</div>}
        {logs.map((l) => (
          <div key={l.id} className="flex gap-1.5">
            <span
              className={cls(
                'mt-[1px] flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[9px]',
                l.channel === 'battle'
                  ? 'border-warn/40 text-warn'
                  : l.channel === 'judge'
                    ? 'border-neon-blue/40 text-neon-blue'
                    : l.channel === 'chat'
                      ? 'border-white/20 text-fog'
                      : 'border-white/10 text-fog/70',
              )}
              title={l.channel}
            >
              {CHANNEL_TAG[l.channel]}
            </span>
            <span className={cls('break-words', CHANNEL_STYLE[l.channel] ?? 'text-[#e6f1ff]')}>{l.text}</span>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-1 border-t border-white/10 px-2 py-2">
        <select
          value={channel}
          onChange={(e) => setChannel(e.target.value === 'battle' ? 'battle' : 'chat')}
          className="rounded border border-white/10 bg-black/40 px-1 py-1 text-[10px] text-fog outline-none"
          title="发送频道"
        >
          <option value="chat">聊天</option>
          <option value="battle">战场</option>
        </select>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          maxLength={200}
          placeholder={disabled ? '连接中断…' : '按 Enter 发送'}
          className="min-w-0 flex-1 rounded border border-white/10 bg-black/40 px-2 py-1 text-[11px] outline-none placeholder:text-fog/50 focus:border-neon-blue"
        />
        <button className="btn-ghost px-2 py-1 text-[10px]" onClick={submit} disabled={disabled}>
          发送
        </button>
      </div>
    </div>
  );
}