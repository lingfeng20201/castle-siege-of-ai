'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import AlliancePanel from '@/components/AlliancePanel';
import BattleLog from '@/components/BattleLog';
import Battlefield from '@/components/Battlefield';
import CastleStatus from '@/components/CastleStatus';
import HandCards from '@/components/HandCards';
import ReportModal from '@/components/ReportModal';
import { MAX_PLAYS_PER_TURN, getCard } from '@/lib/cards';
import { useBattleSocket } from '@/lib/client/socket';
import { MODE_DESC, MODE_LABEL, PHASE_LABEL, cls, modeMinPlayers } from '@/lib/client/ui';
import { CASTLE_CONST } from '@/lib/castle';
import type { GameMode, PlayCardIntent } from '@/lib/protocol';

/**
 * app/room/[roomId]/page.tsx —— 对战房间（⑮）
 *
 * 布局：
 * - 顶部：房号 / 模式 / 回合 / 倒计时 / 连接状态 / AI 托管开关
 * - 中部：战场画布（左） + 玩家状态与结盟面板（右）
 * - 底部：手牌（左） + 战斗日志与聊天（右）
 *
 * 快捷键（需求文档）：空格 出牌确认 · Esc 取消选牌 · A 切换 AI 托管 ·
 * Enter 发送聊天（在聊天输入框内）· 1-9 快速选牌 · Tab 切换目标
 */

const MODES: GameMode[] = ['ffa', 'team', 'siege', 'coop'];

export default function RoomPage() {
  const params = useParams<{ roomId: string }>();
  const roomId = typeof params?.roomId === 'string' ? params.roomId : '';

  /* ── 模式：从 URL 读取（避免 useSearchParams 的静态化限制） ── */
  const [mode, setMode] = useState<GameMode | null>(null);
  useEffect(() => {
    const m = new URLSearchParams(window.location.search).get('mode');
    if (m && (MODES as string[]).includes(m)) setMode(m as GameMode);
  }, []);

  const { snapshot, me, connected, connecting, fatal, lastError, events, report, send, reconnect } =
    useBattleSocket({ roomId, mode });

  /* ── 本地交互状态 ── */
  const [selection, setSelection] = useState<PlayCardIntent[]>([]);
  const [awaitTargetAt, setAwaitTargetAt] = useState<number | null>(null);
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null);
  const [pendingSubmit, setPendingSubmit] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const turnRef = useRef(0);
  const reportRef = useRef(false);

  /* ── 派生数据 ── */
  const players = snapshot?.players ?? [];
  const myPlayer = useMemo(() => players.find((p) => p.id === me?.id) ?? null, [players, me?.id]);
  const hand = myPlayer?.hand ?? [];
  const turn = snapshot?.turn ?? 0;
  const running = snapshot?.status === 'running';
  const phase = snapshot?.phase ?? 'waiting';
  const isHost = !!snapshot?.hostId && snapshot.hostId === me?.id;
  const enemies = useMemo(() => {
    const myTeam = myPlayer?.team;
    return players.filter((p) => {
      if (p.id === me?.id || p.castle.eliminated) return false;
      if (!myTeam || myTeam === 'solo') return true;
      if (p.team === 'boss') return true;
      return p.team !== myTeam;
    });
  }, [players, me?.id, myPlayer?.team]);

  const fog = !!myPlayer && myPlayer.status.fogUntilTurn >= turn;
  const playLimit =
    myPlayer?.status.playLimit && myPlayer.status.playLimit.forTurn === turn
      ? myPlayer.status.playLimit.count
      : MAX_PLAYS_PER_TURN;
  const maxSelect = Math.min(MAX_PLAYS_PER_TURN, playLimit);
  const submitted = !!myPlayer?.submission || pendingSubmit;
  const canAct = running && phase === 'decide' && !!myPlayer && !myPlayer.castle.eliminated && !submitted;
  const allReady = players.length > 0 && players.every((p) => p.ready);
  const minPlayers = modeMinPlayers(mode ?? 'ffa');

  const secondsLeft =
    snapshot?.phaseDeadline && running ? Math.max(0, Math.ceil((snapshot.phaseDeadline - now) / 1000)) : 0;

  /* ── 回合切换 / 战报 ── */
  useEffect(() => {
    if (!snapshot) return;
    if (snapshot.turn !== turnRef.current) {
      turnRef.current = snapshot.turn;
      setSelection([]);
      setAwaitTargetAt(null);
      setPendingSubmit(false);
    }
  }, [snapshot]);

  useEffect(() => {
    if (report && !reportRef.current) {
      reportRef.current = true;
      setShowReport(true);
    }
    if (!report) reportRef.current = false;
  }, [report]);

  /* ── 倒计时 ticker ── */
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [running]);

  /* ── 提示 ── */
  const flash = useCallback((text: string) => {
    setToast(text);
    setTimeout(() => setToast((t) => (t === text ? null : t)), 2400);
  }, []);

  /* ── 选牌 / 目标 / 出牌 ── */
  const toggleCard = useCallback(
    (cardId: string) => {
      if (!canAct) return;
      const card = getCard(cardId);
      const idx = selection.findIndex((s) => s.id === cardId);

      if (idx >= 0) {
        setSelection(selection.filter((_, i) => i !== idx));
        setAwaitTargetAt((a) => (a === null ? null : a > idx ? a - 1 : a === idx ? null : a));
        return;
      }
      if (selection.length >= maxSelect) {
        flash(`本回合最多出 ${maxSelect} 张`);
        return;
      }

      const needsTarget = !!card && (card.targeting === 'enemy' || card.targeting === 'enemyWall');
      const item: PlayCardIntent = { id: cardId };
      if (needsTarget) {
        if (card!.targeting === 'enemyWall') item.layer = 'outer';
        if (enemies.length === 1) item.target = enemies[0].id;
      }
      const next = [...selection, item];
      setSelection(next);
      setAwaitTargetAt(needsTarget && !item.target ? next.length - 1 : null);
    },
    [canAct, enemies, flash, maxSelect, selection],
  );

  const assignTarget = useCallback(
    (targetId: string) => {
      setSelectedTargetId(targetId);
      if (awaitTargetAt === null || !selection[awaitTargetAt]) return;
      setSelection(selection.map((s, i) => (i === awaitTargetAt ? { ...s, target: targetId } : s)));
      setAwaitTargetAt(null);
    },
    [awaitTargetAt, selection],
  );

  const cycleTarget = useCallback(() => {
    if (enemies.length === 0) return;
    const idx = enemies.findIndex((e) => e.id === selectedTargetId);
    const next = enemies[(idx + 1) % enemies.length];
    assignTarget(next.id);
  }, [assignTarget, enemies, selectedTargetId]);

  const submitPlay = useCallback(() => {
    if (!canAct || selection.length === 0) {
      if (canAct && selection.length === 0) flash('请先选择要打出的卡牌');
      return;
    }
    const missing = selection.findIndex((s) => {
      const card = getCard(s.id);
      return !!card && (card.targeting === 'enemy' || card.targeting === 'enemyWall') && !s.target;
    });
    if (missing >= 0) {
      setAwaitTargetAt(missing);
      flash('还有卡牌未选择目标：点击敌方城堡或按 Tab 切换');
      return;
    }
    if (!send({ t: 'action:play', cards: selection })) {
      flash('连接已中断，正在重连…');
      return;
    }
    setPendingSubmit(true);
  }, [canAct, flash, selection, send]);

  const toggleAuto = useCallback(() => {
    const isAuto = myPlayer?.aiMode === 'auto';
    if (!myPlayer) return;
    send({ t: 'action:auto', enabled: !isAuto });
    flash(isAuto ? '已关闭 AI 托管' : '已开启 AI 托管');
  }, [flash, myPlayer, send]);

  /* ── 快捷键 ── */
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;

      if (e.key === ' ') {
        e.preventDefault();
        submitPlay();
      } else if (e.key === 'Escape') {
        setSelection([]);
        setAwaitTargetAt(null);
        setSelectedTargetId(null);
      } else if (e.key === 'a' || e.key === 'A') {
        toggleAuto();
      } else if (e.key === 'Tab') {
        e.preventDefault();
        cycleTarget();
      } else if (/^[1-9]$/.test(e.key)) {
        const id = hand[Number(e.key) - 1];
        if (id) toggleCard(id);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cycleTarget, hand, submitPlay, toggleAuto, toggleCard]);

  /* ── 复制房号 ── */
  const copyCode = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(roomId.toUpperCase());
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      flash('复制失败，请手动选择房号');
    }
  }, [flash, roomId]);

  const currentMode = snapshot?.mode ?? mode ?? 'ffa';

  /* ── 未登录 / 致命错误 ── */
  if (fatal) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
        <div className="text-4xl">🔒</div>
        <p className="text-sm text-warn">{fatal}</p>
        <div className="flex gap-2">
          <Link className="btn-blue" href="/login">
            去登录
          </Link>
          <Link className="btn-ghost" href="/">
            返回大厅
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col lg:h-screen">
      {/* ══════════ 顶栏 ══════════ */}
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-white/10 bg-black/40 px-3 py-2">
        <div className="flex items-center gap-2">
          <Link className="btn-ghost px-2 py-1 text-xs" href="/">
            ← 大厅
          </Link>
          <button
            className="flex items-center gap-1 rounded-lg border border-gold/40 bg-gold/5 px-2 py-1 font-mono text-xs text-gold"
            onClick={copyCode}
            title="点击复制房号"
          >
            #{roomId.toUpperCase()} {copied ? '✓ 已复制' : '⧉'}
          </button>
          <span className="chip border-neon-blue/40 text-neon-blue">{MODE_LABEL[currentMode]}</span>
          {running && (
            <span className="chip border-white/15 text-fog">
              第 {turn}/{CASTLE_CONST.maxTurns} 回合 · {PHASE_LABEL[phase]}
            </span>
          )}
          {running && phase === 'decide' && (
            <span
              className={cls(
                'chip font-mono',
                secondsLeft <= 8 ? 'border-neon-red/60 text-neon-red' : 'border-warn/50 text-warn',
              )}
            >
              ⏱ {secondsLeft}s
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 text-xs">
          <span className={cls('chip', connected ? 'border-ok/50 text-ok' : 'border-warn/50 text-warn')}>
            <span className={cls('mr-1 inline-block h-1.5 w-1.5 rounded-full', connected ? 'bg-ok' : 'bg-warn animate-csai-pulse')} />
            {connected ? '已连接' : connecting ? '连接中…' : '已断开'}
          </span>

          {snapshot && snapshot.spectatorCount > 0 && (
            <span className="chip border-white/15 text-fog">👁 观众 {snapshot.spectatorCount}</span>
          )}

          {myPlayer && (
            <button
              className={cls('text-xs', myPlayer.aiMode === 'auto' ? 'btn-ok' : 'btn-ghost')}
              onClick={toggleAuto}
              title="快捷键 A"
            >
              {myPlayer.aiMode === 'auto' ? '🤖 AI 托管中' : '🤖 开启 AI 托管'}
            </button>
          )}

          {!connected && (
            <button className="btn-blue text-xs" onClick={reconnect}>
              ↻ 重连
            </button>
          )}
        </div>
      </header>

      {/* ══════════ 主区 ══════════ */}
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* 战场 */}
        <main className="relative h-[46vh] min-h-[260px] shrink-0 lg:h-auto lg:min-h-0 lg:flex-1">
          {/* 说明：小屏给战场一个确定高度（46vh）；若只写 flex-1 + min-h，
              canvas 的百分比高度在「高度不确定」的弹性盒里会退化成 auto，
              导致战场被压扁、下方留下大片空白。大屏（lg）仍由 flex 撑满。 */}
          <Battlefield
            players={players}
            mode={currentMode}
            meId={me?.id ?? null}
            turn={turn}
            maxTurns={CASTLE_CONST.maxTurns}
            phase={phase}
            fog={fog}
            events={events}
            selectedTargetId={selectedTargetId}
            onSelectTarget={assignTarget}
          />

          {/* 目标选择提示 */}
          {awaitTargetAt !== null && (
            <div className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-lg border border-gold/50 bg-black/80 px-3 py-1.5 text-[11px] text-gold shadow-glow-gold">
              请点击敌方城堡选择目标（Tab 切换）· 第 {awaitTargetAt + 1} 张牌
            </div>
          )}

          {/* 迷雾提示 */}
          {fog && (
            <div className="pointer-events-none absolute bottom-3 right-3 rounded-lg border border-fog/40 bg-black/80 px-3 py-1.5 text-[11px] text-fog">
              🌫 你被迷雾笼罩：本回合看不到对手明细
            </div>
          )}

          {/* 等待集结覆盖层 */}
          {snapshot && snapshot.status === 'waiting' && (
            <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
              <div className="panel-neon w-full max-w-lg p-5">
                <h2 className="font-display text-lg text-gold">🏯 等待集结</h2>
                <p className="mt-1 text-[11px] text-fog">{MODE_DESC[currentMode]}</p>
                <p className="mt-2 text-[11px] text-fog">
                  房号 <span className="font-mono text-gold">#{roomId.toUpperCase()}</span>
                  <button className="btn-ghost ml-2 px-2 py-0.5 text-[10px]" onClick={copyCode}>
                    {copied ? '已复制' : '复制邀请'}
                  </button>
                </p>

                <ul className="mt-4 space-y-1.5">
                  {players.map((p, i) => (
                    <li
                      key={p.id}
                      className="flex items-center justify-between rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-xs"
                    >
                      <span className="flex items-center gap-2">
                        <span className="text-fog">{i + 1}.</span>
                        <span className="text-[#e6f1ff]">{p.nickname}</span>
                        {p.isHost && <span className="chip border-gold/50 text-gold">房主</span>}
                        {p.id === me?.id && <span className="chip border-ok/40 text-ok">你</span>}
                        {!p.online && <span className="chip border-warn/50 text-warn">掉线</span>}
                      </span>
                      <span className={p.ready ? 'text-ok' : 'text-fog'}>{p.ready ? '✓ 已准备' : '未准备'}</span>
                    </li>
                  ))}
                  {players.length === 0 && <li className="text-xs text-fog">尚无玩家，等待连接…</li>}
                </ul>

                <div className="mt-4 flex flex-wrap items-center gap-2">
                  {myPlayer && (
                    <button
                      className={myPlayer.ready ? 'btn-ghost' : 'btn-ok'}
                      onClick={() => send({ t: 'player:ready', ready: !myPlayer.ready })}
                    >
                      {myPlayer.ready ? '取消准备' : '✓ 我已准备'}
                    </button>
                  )}

                  {isHost && (
                    <button
                      className="btn-gold"
                      onClick={() => send({ t: 'cmd:start' })}
                      disabled={!allReady || players.length < minPlayers}
                      title={
                        players.length < minPlayers
                          ? `至少需要 ${minPlayers} 名玩家`
                          : allReady
                            ? '开始对局'
                            : '仍有玩家未准备'
                      }
                    >
                      ⚔ 开始对局（{players.length}/{minPlayers}+）
                    </button>
                  )}

                  {isHost && (
                    <button className="btn-ghost" onClick={() => send({ t: 'cmd:reset' })}>
                      ↻ 重置房间
                    </button>
                  )}
                </div>

                <p className="mt-3 text-[10px] leading-relaxed text-fog/80">
                  提示：模型配置在「模型配置」页；开启 AI 托管后由你的模型担任指挥官自动出牌；
                  未配置模型仍可手动参战或作为观众观战。
                </p>
              </div>
            </div>
          )}

          {/* 已结束覆盖层 */}
          {snapshot && snapshot.status === 'finished' && !showReport && (
            <div className="absolute inset-x-0 bottom-0 z-20 flex items-center justify-between gap-2 border-t border-gold/30 bg-black/70 px-3 py-2 text-xs backdrop-blur">
              <span className="text-gold">
                🏆 本局结束：{snapshot.winnerName ?? '平局'}
                {snapshot.winner === me?.id ? '（你赢了！）' : ''}
              </span>
              <span className="flex gap-2">
                <button className="btn-ghost px-2 py-1 text-[11px]" onClick={() => setShowReport(true)}>
                  查看战报
                </button>
                {isHost && (
                  <button className="btn-blue px-2 py-1 text-[11px]" onClick={() => send({ t: 'cmd:reset' })}>
                    再来一局
                  </button>
                )}
              </span>
            </div>
          )}
        </main>

        {/* 侧栏 */}
        <aside className="flex w-full shrink-0 flex-col gap-2 overflow-y-auto border-t border-white/10 p-2 lg:w-[330px] lg:border-l lg:border-t-0">
          {!myPlayer && snapshot && (
            <div className="panel border-warn/30 bg-warn/5 p-3 text-[11px] text-warn">
              你正在以<span className="font-bold">观众</span>身份观战（席位已满或未加入）。
              {snapshot.status === 'waiting' && ' 等待下一局空位。'}
            </div>
          )}

          {myPlayer && (
            <CastleStatus
              player={myPlayer}
              isMe
              index={players.findIndex((p) => p.id === myPlayer.id)}
              turn={turn}
              mode={currentMode}
              obscured={fog}
            />
          )}

          <AlliancePanel
            players={players}
            meId={me?.id ?? null}
            alliances={snapshot?.alliances ?? []}
            turn={turn}
            running={running}
            onRequest={(id) => send({ t: 'ally:request', targetUserId: id })}
            onAccept={(id) => send({ t: 'ally:accept', fromUserId: id })}
            onBetray={() => send({ t: 'ally:betray' })}
          />

          <div className="flex flex-col gap-2">
            {players
              .filter((p) => p.id !== me?.id)
              .map((p, i) => (
                <CastleStatus
                  key={p.id}
                  player={p}
                  isMe={false}
                  index={players.findIndex((q) => q.id === p.id) >= 0 ? players.findIndex((q) => q.id === p.id) : i}
                  turn={turn}
                  mode={currentMode}
                  selected={selectedTargetId === p.id}
                  onSelect={assignTarget}
                  obscured={fog}
                />
              ))}
          </div>
        </aside>
      </div>

      {/* ══════════ 底部：手牌 + 日志 ══════════ */}
      <footer className="grid shrink-0 gap-2 border-t border-white/10 bg-black/30 p-2 lg:grid-cols-[1fr_380px]">
        <HandCards
          hand={hand}
          resources={myPlayer?.resources ?? { gold: 0, wood: 0, intel: 0 }}
          selection={selection}
          maxSelect={maxSelect}
          disabled={!canAct}
          submitted={submitted}
          onSubmit={submitPlay}
          onClear={() => {
            setSelection([]);
            setAwaitTargetAt(null);
          }}
          onToggle={(id) => toggleCard(id)}
        />

        <div className="h-[200px] rounded-xl border border-white/10 bg-black/30 lg:h-[190px]">
          <BattleLog
            logs={snapshot?.logs ?? []}
            onSend={(text, channel) => {
              if (!send({ t: 'chat:send', channel, text })) flash('连接中断，消息未发送');
            }}
            disabled={!connected}
          />
        </div>
      </footer>

      {/* 提示 */}
      {(toast || lastError) && (
        <div className="fixed bottom-24 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-neon-blue/40 bg-panel px-4 py-2 text-xs text-neon-blue shadow-glow">
          {toast || lastError}
        </div>
      )}

      {/* 战报 */}
      {showReport && <ReportModal report={report} meId={me?.id ?? null} onClose={() => setShowReport(false)} />}
    </div>
  );
}