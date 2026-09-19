import type * as Party from 'partykit/server';
import { jwtVerify } from 'jose';
import { HAND_LIMIT, getCard, registerDynamicCard } from '../lib/cards';
import { CASTLE_CONST, aliveTowerCount, castlePower, createCastle } from '../lib/castle';
import {
  beginTurn,
  checkVictory,
  createEnginePlayer,
  fallbackPlayIntent,
  playLimitFor,
  recoverPhase,
  resolveTurn,
} from '../lib/engine';
import type { BattleState, EnginePlayer } from '../lib/engine';
import {
  buildCommanderSystemPrompt,
  buildCommanderUserMessage,
  buildJudgePrompt,
  buildReportPrompt,
  callModel,
  parseCommanderDecision,
} from '../lib/llm-core';
import type { CommanderView, LlmProviderConfig, LlmMessage } from '../lib/llm-core';
import {
  buildImprovSystemPrompt,
  buildImprovUserMessage,
  parseImprovPlan,
  planToCards,
} from '../lib/improvise';
import { cloneTroops, emptyTroops, totalTroops } from '../lib/troops';
import {
  PROTOCOL_VERSION,
} from '../lib/protocol';
import type {
  BattleEvent,
  ClientMessage,
  GameMode,
  GameReport,
  LogEntry,
  PlayCardIntent,
  PlayIntent,
  PlayerState,
  RoomPhase,
  RoomSnapshot,
  ServerMessage,
  TeamId,
} from '../lib/protocol';

/**
 * party/battle.ts —— 每场战斗 = 一个 Party 实例（服务端权威）
 *
 * - 客户端只发意图（action:play 等），服务端结算后广播快照与事件
 * - AI 托管：action:auto / 掉线自动切换；hybrid 模式在截止时兜底提交
 * - AI 裁判：房主模型每回合生成一句战况点评；结束时生成战报叙事
 * - 持久化：用量与对局通过内部桥接 API（/api/internal/party）写入 Postgres
 *
 * ⚠️ 房间服务器不直接连接数据库；模型 Key 由内部 API 解密后仅经内存转发。
 */

/* ══════════════════════ 工具 ══════════════════════ */

function rid(): string {
  const c = globalThis.crypto as { randomUUID?: () => string } | undefined;
  return c?.randomUUID?.() ?? Math.random().toString(36).slice(2, 10);
}

function maxPlayersFor(mode: GameMode): number {
  return 20;
}

function minPlayersFor(mode: GameMode): number {
  if (mode === 'ffa') return 2;
  if (mode === 'team') return 2; // 正式 2v2 需 4 人；此处放宽便于演练
  if (mode === 'siege') return 3;
  return 1;
}

function assignTeam(mode: GameMode, seats: Seat[]): TeamId {
  if (mode === 'ffa' || mode === 'coop') return 'red'; // ffa 中显示时按 solo 处理，coop 队友共享视野
  if (mode === 'team') {
    const red = seats.filter((s) => s.team === 'red').length;
    const blue = seats.filter((s) => s.team === 'blue').length;
    return red <= blue ? 'red' : 'blue';
  }
  // siege：前 4 人防守，其余进攻
  const def = seats.filter((s) => s.team === 'defense').length;
  return def < 4 ? 'defense' : 'attack';
}

async function verifyTicket(
  secret: string,
  ticket: string,
): Promise<{ uid: string; username: string } | null> {
  try {
    const { payload } = await jwtVerify(ticket, new TextEncoder().encode(secret), {
      algorithms: ['HS256'],
    });
    if (payload.scope !== 'party' || typeof payload.uid !== 'string' || typeof payload.username !== 'string') {
      return null;
    }
    return { uid: payload.uid, username: payload.username };
  } catch {
    return null;
  }
}

/* ══════════════════════ 类型 ══════════════════════ */

interface Seat {
  uid: string;
  nickname: string;
  team: TeamId;
  aiMode: 'manual' | 'auto' | 'hybrid';
  providerId: string | null;
  providerName: string | null;
  modelName: string | null;
  ready: boolean;
  online: boolean;
  isHost: boolean;
}

interface Submission {
  cards: PlayCardIntent[];
  source: 'human' | 'ai' | 'fallback';
}

interface ConnCtxLike {
  request: Request;
}

/* ══════════════════════ 房间服务器 ══════════════════════ */

export default class BattleServer {
  private readonly room: Party.Room;

  private mode: GameMode = 'ffa';
  private status: 'waiting' | 'running' | 'finished' = 'waiting';
  private phase: RoomPhase = 'waiting';
  private phaseDeadline = 0;

  private seats = new Map<string, Seat>();
  private connUid = new Map<string, string | null>();

  private state: BattleState | null = null;
  private submissions = new Map<string, Submission>();
  private hybridSuggestions = new Map<string, PlayCardIntent[]>();
  private pendingAlly = new Map<string, string>(); // targetUid → fromUid

  private logs: LogEntry[] = [];
  private judgeSummary = '';
  private winner: { id: string | null; name: string | null; reason: string } | null = null;

  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(room: Party.Room) {
    this.room = room;
  }

  /* ────────── 环境变量（PartyKit vars / .env） ────────── */

  private env(key: string): string | undefined {
    const fromRoom = (this.room as unknown as { env?: Record<string, string | undefined> }).env;
    if (fromRoom?.[key]) return fromRoom[key];
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
    return proc?.env?.[key];
  }

  /* ────────── 生命周期 ────────── */

  async onStart(): Promise<void> {
    await this.pushLobby();
  }

  async onConnect(conn: Party.Connection, ctx: ConnCtxLike): Promise<void> {
    const url = new URL(ctx.request.url);
    const ticket = url.searchParams.get('ticket') ?? '';
    const modeParam = url.searchParams.get('mode') as GameMode | null;
    const secret = this.env('JWT_SECRET');
    const user = ticket && secret ? await verifyTicket(secret, ticket) : null;

    if (modeParam && ['ffa', 'team', 'siege', 'coop'].includes(modeParam) && this.status === 'waiting') {
      this.mode = modeParam;
    }

    if (user) {
      let seat = this.seats.get(user.uid);
      if (!seat && this.status !== 'finished' && this.seats.size < maxPlayersFor(this.mode)) {
        seat = {
          uid: user.uid,
          nickname: user.username,
          team: assignTeam(this.mode, [...this.seats.values()]),
          aiMode: 'manual',
          providerId: null,
          providerName: null,
          modelName: null,
          ready: false,
          online: true,
          isHost: this.seats.size === 0,
        };
        this.seats.set(user.uid, seat);
        if (this.state) {
          // 中途加入：立刻建城堡入战，本回合待机，下一回合开始正常出手
          const S0 = this.state;
          const lateTeam = this.mode === 'ffa' ? 'solo' : this.mode === 'coop' ? 'red' : seat.team;
          const latePlayer = createEnginePlayer({ id: user.uid, nickname: user.username, team: lateTeam });
          // ponytail: 起始手牌固定 3 张，与 beginTurn 的抽牌数保持一致；改抽牌规则时同步这里
          latePlayer.hand.push(...latePlayer.deck.splice(0, 3));
          S0.players[user.uid] = latePlayer;
          this.submissions.set(user.uid, { cards: [], source: 'fallback' });
          this.appendLogs([
            { id: rid(), ts: Date.now(), channel: 'system', text: `⚔️ ${user.username} 中途杀入战场（第 ${S0.turn} 回合待机）` },
          ]);
        } else {
          this.appendLogs([
            { id: rid(), ts: Date.now(), channel: 'system', text: `🏰 ${user.username} 加入了城堡` },
          ]);
        }
      } else if (seat) {
        seat.online = true;
      }
      this.connUid.set(conn.id, user.uid);
      conn.send(
        JSON.stringify({
          t: 'hello',
          you: { id: user.uid, nickname: user.username },
          protocolVersion: PROTOCOL_VERSION,
        } satisfies ServerMessage),
      );
    } else {
      this.connUid.set(conn.id, null); // 观众
      conn.send(
        JSON.stringify({
          t: 'hello',
          you: null,
          protocolVersion: PROTOCOL_VERSION,
        } satisfies ServerMessage),
      );
    }

    this.sendSnapshot(conn);
    await this.pushLobby();
  }

  async onMessage(raw: string | ArrayBuffer, sender: Party.Connection): Promise<void> {
    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    let msg: ClientMessage;
    try {
      msg = JSON.parse(text) as ClientMessage;
    } catch {
      return;
    }
    const uid = this.connUid.get(sender.id) ?? null;

    switch (msg.t) {
      case 'lobby:list':
        sender.send(JSON.stringify({ t: 'lobby:update', rooms: [] } satisfies ServerMessage));
        return; // 大厅列表统一走 HTTP /api/lobby
      case 'room:create':
        if (uid && this.status === 'waiting' && msg.mode) this.mode = msg.mode;
        break;
      case 'player:ready':
        if (uid) await this.handleReady(uid, !!msg.ready);
        break;
      case 'cmd:start':
        if (uid) await this.handleStart(uid);
        break;
      case 'cmd:reset':
        if (uid) await this.handleReset(uid);
        break;
      case 'action:play':
        if (uid) this.handlePlay(uid, msg.cards);
        break;
      case 'action:auto':
        if (uid) await this.handleAuto(uid, !!msg.enabled);
        break;
      case 'chat:send':
        this.handleChat(uid, msg.channel, String(msg.text ?? '').slice(0, 300));
        break;
      case 'ally:request':
        if (uid) this.handleAllyRequest(uid, String(msg.targetUserId ?? ''));
        break;
      case 'ally:accept':
        if (uid) this.handleAllyAccept(uid, String(msg.fromUserId ?? ''));
        break;
      case 'ally:betray':
        if (uid) this.handleBetray(uid);
        break;
      case 'room:leave':
        if (uid) await this.removeOrOffline(uid);
        break;
      default:
        break;
    }
    this.sendSnapshot(sender);
  }

  async onClose(conn: Party.Connection): Promise<void> {
    const uid = this.connUid.get(conn.id) ?? null;
    this.connUid.delete(conn.id);
    if (!uid) return;
    const stillConnected = [...this.connUid.values()].some((u) => u === uid);
    if (!stillConnected) await this.removeOrOffline(uid);
    await this.pushLobby();
  }

  async onAlarm(): Promise<void> {
    await this.onDeadline();
  }

  async onRequest(): Promise<Response> {
    return new Response(JSON.stringify({ ok: true, room: this.room.id, status: this.status }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /* ────────── 内部桥接 API ────────── */

  private async internal(action: string, payload: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const appUrl = this.env('APP_URL');
    const key = this.env('INTERNAL_API_KEY');
    if (!appUrl || !key) return null;
    try {
      const res = await fetch(`${appUrl.replace(/\/+$/, '')}/api/internal/party`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({ action, payload }),
      });
      if (!res.ok) return null;
      return (await res.json()) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  private async pushLobby(): Promise<void> {
    const host = [...this.seats.values()].find((s) => s.isHost) ?? [...this.seats.values()][0];
    await this.internal('lobby.upsert', {
      room: {
        id: this.room.id,
        code: this.room.id.toUpperCase(),
        mode: this.mode,
        status: this.status,
        playerCount: this.seats.size,
        maxPlayers: maxPlayersFor(this.mode),
        turn: this.state?.turn ?? 0,
        hostName: host?.nickname ?? '—',
      },
    });
  }

  private async fetchProvider(uid: string): Promise<(LlmProviderConfig & { providerId: string | null }) | null> {
    const seat = this.seats.get(uid);
    if (!seat) return null;
    const data = await this.internal('provider.get', {
      userId: uid,
      providerId: seat.providerId ?? undefined,
    });
    const pv = data?.provider as
      | {
          id: string;
          providerType: string;
          baseUrl: string;
          modelName: string;
          apiKey: string;
          extraHeaders?: Record<string, string>;
          params?: Record<string, unknown>;
        }
      | null
      | undefined;
    if (!pv) return null;
    seat.providerName = seat.providerName ?? 'BYOK';
    seat.modelName = pv.modelName;
    return {
      providerType: pv.providerType,
      baseUrl: pv.baseUrl,
      modelName: pv.modelName,
      apiKey: pv.apiKey,
      extraHeaders: pv.extraHeaders,
      params: pv.params,
      providerId: pv.id,
    };
  }

  private reportUsage(
    uid: string,
    providerId: string | null,
    modelName: string,
    role: string,
    usage: { promptTokens: number; completionTokens: number },
    latencyMs: number,
    success: boolean,
    errorMsg?: string,
  ): void {
    void this.internal('usage.add', {
      records: [
        {
          userId: uid,
          providerId,
          roomId: this.room.id,
          role,
          modelName,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          latencyMs,
          success,
          errorMsg: success ? null : (errorMsg ?? '').slice(0, 400),
        },
      ],
    });
  }

  /* ────────── 快照与广播 ────────── */

  private appendLogs(entries: LogEntry[]): void {
    this.logs.push(...entries);
    if (this.logs.length > 300) this.logs = this.logs.slice(-300);
  }

  private broadcast(msg: ServerMessage): void {
    const text = JSON.stringify(msg);
    for (const conn of this.room.getConnections()) {
      try {
        conn.send(text);
      } catch {
        // 单连接失败不影响其他连接
      }
    }
  }

  private broadcastSnapshot(): void {
    for (const conn of this.room.getConnections()) {
      const uid = this.connUid.get(conn.id) ?? null;
      try {
        conn.send(JSON.stringify({ t: 'room:state', snapshot: this.buildSnapshot(uid) } satisfies ServerMessage));
      } catch {
        // ignore
      }
    }
  }

  private sendSnapshot(conn: Party.Connection): void {
    const uid = this.connUid.get(conn.id) ?? null;
    conn.send(JSON.stringify({ t: 'room:state', snapshot: this.buildSnapshot(uid) } satisfies ServerMessage));
  }

  private buildSnapshot(viewer: string | null): RoomSnapshot {
    const S = this.state;
    const turn = S?.turn ?? 0;
    const viewerP = viewer && S ? S.players[viewer] : undefined;
    const viewerReveal = !!viewerP && viewerP.status.revealUntilTurn >= turn;
    const viewerFog = !!viewerP && viewerP.status.fogUntilTurn >= turn;

    const players: PlayerState[] = [];
    for (const seat of this.seats.values()) {
      players.push(this.buildPlayerState(seat, viewer, viewerReveal, viewerFog));
    }
    // coop：无名之堡
    if (S?.players['boss'] && !this.seats.has('boss')) {
      players.push(this.buildBossState(S.players['boss']));
    }

    const spectatorCount =
      [...this.connUid.values()].filter((u) => u === null || (u !== null && !this.seats.has(u))).length;

    return {
      id: this.room.id,
      code: this.room.id.toUpperCase(),
      mode: this.mode,
      status: this.status,
      turn,
      phase: this.phase,
      phaseDeadline: this.phaseDeadline,
      players,
      alliances: S?.alliances ?? [],
      logs: this.logs.slice(-120),
      winner: this.winner?.id ?? null,
      winnerName: this.winner?.name ?? null,
      campaignId: null,
      spectatorCount,
      hostId: [...this.seats.values()].find((s) => s.isHost)?.uid ?? null,
    };
  }

  private buildPlayerState(
    seat: Seat,
    viewer: string | null,
    viewerReveal: boolean,
    viewerFog: boolean,
  ): PlayerState {
    const S = this.state;
    const p = S?.players[seat.uid];
    const isSelf = viewer === seat.uid;
    const fogged = viewerFog && !isSelf;

    const hand = p ? (isSelf || viewerReveal ? p.hand : []) : [];
    const submission = this.submissions.get(seat.uid);
    const mySubmission = isSelf && submission ? { cards: submission.cards, source: submission.source } : null;
    const othersSubmitted = !isSelf && submission ? { cards: [], source: submission.source } : null;

    return {
      id: seat.uid,
      nickname: seat.nickname,
      team: seat.team,
      isAI: seat.aiMode !== 'manual' || !seat.online,
      aiMode: seat.aiMode,
      providerId: seat.providerId,
      providerName: seat.providerName,
      modelName: seat.modelName,
      resources: p?.resources ?? { gold: CASTLE_CONST.startGold, wood: CASTLE_CONST.startWood, intel: CASTLE_CONST.startIntel },
      troops: cloneTroops(p?.troops),
      hand,
      handCount: p?.hand.length ?? 0,
      castle: p?.castle ?? createCastle(() => 0.5),
      status: p?.status ?? { armorBuff: null, reflectBuff: null, armorPenalty: null, counterStance: null, decoys: 0, playLimit: null, repairBlockedTurns: [], attackNullTurns: [], fogUntilTurn: -1, revealUntilTurn: -1 },
      online: seat.online,
      ready: seat.ready,
      isHost: seat.isHost,
      submission: fogged ? othersSubmitted : (mySubmission ?? othersSubmitted),
    };
  }

  private buildBossState(boss: EnginePlayer): PlayerState {
    return {
      id: boss.id,
      nickname: boss.nickname,
      team: 'boss',
      isAI: true,
      aiMode: 'auto',
      providerId: null,
      providerName: null,
      modelName: 'scripted',
      resources: boss.resources,
      troops: cloneTroops(boss.troops),
      hand: [],
      handCount: boss.hand.length,
      castle: boss.castle,
      status: boss.status,
      online: true,
      ready: true,
      isHost: false,
      submission: this.submissions.get(boss.id) ? { cards: [], source: 'ai' } : null,
    };
  }

  /* ────────── 准备 / 开局 ────────── */

  private async handleReady(uid: string, ready: boolean): Promise<void> {
    const seat = this.seats.get(uid);
    if (!seat || this.status !== 'waiting') return;
    seat.ready = ready;
    this.appendLogs([
      { id: rid(), ts: Date.now(), channel: 'system', text: `${seat.nickname} ${ready ? '已准备' : '取消准备'}` },
    ]);
    this.broadcastSnapshot();
  }

  private async handleStart(uid: string): Promise<void> {
    const seat = this.seats.get(uid);
    if (!seat?.isHost || this.status !== 'waiting') return;
    if (this.seats.size < minPlayersFor(this.mode)) {
      this.sendError(uid, 'NOT_ENOUGH_PLAYERS', `至少需要 ${minPlayersFor(this.mode)} 名玩家才能开始`);
      return;
    }
    if (![...this.seats.values()].every((s) => s.ready)) {
      this.sendError(uid, 'NOT_READY', '仍有玩家未准备');
      return;
    }

    // 分配阵营 + 构建战场
    const seatList = [...this.seats.values()];
    for (const s of seatList) s.team = assignTeam(this.mode, seatList);

    const players: Record<string, EnginePlayer> = {};
    for (const s of seatList) {
      const team = this.mode === 'ffa' ? 'solo' : this.mode === 'coop' ? 'red' : s.team;
      players[s.uid] = createEnginePlayer({ id: s.uid, nickname: s.nickname, team });
    }
    if (this.mode === 'coop') {
      players['boss'] = createEnginePlayer({ id: 'boss', nickname: '无名之堡', team: 'boss' });
    }

    this.state = { mode: this.mode, turn: 0, players, alliances: [], lurkers: [] };
    this.status = 'running';
    this.submissions.clear();
    this.hybridSuggestions.clear();
    this.pendingAlly.clear();
    this.winner = null;
    this.appendLogs([
      { id: rid(), ts: Date.now(), channel: 'system', text: `⚔️ 战斗开始！（${this.mode} 模式）` },
    ]);

    this.broadcastSnapshot();
    await this.startTurn();
    await this.pushLobby();
  }

  /* ────────── 回合流转 ────────── */

  private async startTurn(): Promise<void> {
    const S = this.state;
    if (!S) return;

    // 过期联盟清理
    S.alliances = S.alliances.filter((a) => a.untilTurn >= S.turn);

    const out = beginTurn(S, Math.random);
    this.state = out.state;
    this.appendLogs(out.logs);
    this.phase = 'decide';
    this.phaseDeadline = Date.now() + CASTLE_CONST.decideSeconds * 1000;

    this.broadcast({
      t: 'turn:start',
      turn: this.state.turn,
      deadline: this.phaseDeadline,
      phase: 'decide',
    });
    this.broadcastSnapshot();
    this.scheduleTurnTimer(CASTLE_CONST.decideSeconds * 1000 + 300);

    void this.runAiDecisions();
    await this.pushLobby();
  }

  private scheduleTurnTimer(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.onDeadline();
    }, ms);
    // 云端：追加 alarm（休眠也能唤醒）
    try {
      const storage = (this.room as unknown as { storage?: { setAlarm?: (t: number) => Promise<void> } }).storage;
      void storage?.setAlarm?.(Date.now() + ms);
    } catch {
      // 忽略：dev 环境仅依赖 setTimeout
    }
  }

  private async onDeadline(): Promise<void> {
    if (this.status !== 'running' || this.phase !== 'decide') return;
    await this.maybeResolve();
  }

  private handlePlay(uid: string, cards: PlayCardIntent[]): void {
    if (this.status !== 'running' || this.phase !== 'decide') return;
    const S = this.state;
    if (!S) return;
    const p = S.players[uid];
    if (!p || p.eliminated) return;
    if (this.submissions.has(uid)) return;

    const limit = playLimitFor(p, S.turn);
    const cleaned = (Array.isArray(cards) ? cards : [])
      .slice(0, limit)
      .filter((c) => c && typeof c.id === 'string')
      .map((c) => ({ id: c.id, target: c.target, layer: c.layer, sacrifice: c.sacrifice }));

    this.submissions.set(uid, { cards: cleaned, source: 'human' });
    const seat = this.seats.get(uid);
    if (seat) {
      this.appendLogs([{ id: rid(), ts: Date.now(), channel: 'system', text: `📜 ${seat.nickname} 已提交出牌` }]);
    }
    this.broadcastSnapshot();
    void this.maybeResolve();
  }

  private async maybeResolve(): Promise<void> {
    if (!this.state || this.status !== 'running' || this.phase !== 'decide') return;
    const alive = Object.values(this.state.players).filter((p) => !p.eliminated);
    const allIn = alive.every((p) => this.submissions.has(p.id));
    const timeUp = Date.now() >= this.phaseDeadline - 250;
    if (!allIn && !timeUp) return;
    await this.resolveNow();
  }

  private async resolveNow(): Promise<void> {
    const S = this.state;
    if (!S) return;
    this.phase = 'resolve';
    this.broadcastSnapshot();

    // 收集出牌：hybrid 兜底 / 掉线兜底 / 手动放弃
    const plays: PlayIntent[] = [];
    for (const p of Object.values(S.players)) {
      if (p.eliminated) continue;
      const sub = this.submissions.get(p.id);
      if (sub) {
        plays.push({ playerId: p.id, cards: sub.cards });
        continue;
      }
      const hybrid = this.hybridSuggestions.get(p.id);
      if (hybrid) {
        plays.push({ playerId: p.id, cards: hybrid });
        continue;
      }
      const seat = this.seats.get(p.id);
      if (p.id === 'boss' || !seat || !seat.online || seat.aiMode === 'auto') {
        plays.push(fallbackPlayIntent(p));
      } else {
        plays.push({ playerId: p.id, cards: [] });
      }
    }
    this.submissions.clear();
    this.hybridSuggestions.clear();

    const out = resolveTurn(S, plays, Math.random);
    this.state = out.state;
    this.appendLogs(out.logs);
    this.broadcast({ t: 'turn:resolve', events: out.events, logs: out.logs });

    const rec = recoverPhase(this.state, Math.random);
    this.state = rec.state;
    this.appendLogs(rec.logs);
    if (rec.events.length > 0) this.broadcast({ t: 'turn:resolve', events: rec.events, logs: [] });
    this.broadcastSnapshot();

    // AI 裁判点评（异步，不阻塞回合）
    void this.judgeTurn(out.logs);

    // coop：特殊胜负
    if (this.mode === 'coop' && this.state) {
      const boss = this.state.players['boss'];
      const humans = Object.values(this.state.players).filter((p) => p.id !== 'boss' && !p.eliminated);
      if (boss?.eliminated) {
        await this.finish({ id: humans[0]?.id ?? null, name: '联军', reason: '无名之堡陷落' });
        return;
      }
      if (humans.length === 0) {
        await this.finish({ id: 'boss', name: '无名之堡', reason: '联军全灭' });
        return;
      }
      // 回合上限：coop 不走 checkVictory（其胜负是「陷落 / 全灭」），但 40 回合封顶仍需生效，
      // 否则会出现 T42/40 一直打下去的情况。到期按「主堡+城墙+箭塔」总耐久判定联军是否攻破。
      if (this.state.turn >= CASTLE_CONST.maxTurns) {
        const bossPower = castlePower(boss.castle);
        const allyPower = humans.reduce((sum, p) => sum + castlePower(p.castle), 0);
        if (allyPower > bossPower) {
          await this.finish({
            id: humans[0]?.id ?? null,
            name: '联军',
            reason: `${CASTLE_CONST.maxTurns} 回合到期：联军总耐久 ${allyPower} 高于无名之堡 ${bossPower}`,
          });
        } else {
          await this.finish({
            id: 'boss',
            name: '无名之堡',
            reason: `${CASTLE_CONST.maxTurns} 回合到期：无名之堡 ${bossPower} 守住联军 ${allyPower}`,
          });
        }
        return;
      }
    } else {
      const v = checkVictory(this.state);
      if (v.over) {
        await this.finish({ id: v.winner, name: v.winnerName, reason: v.reason });
        return;
      }
    }

    await this.startTurn();
  }

  /* ────────── AI 托管 ────────── */

  private async handleAuto(uid: string, enabled: boolean): Promise<void> {
    const seat = this.seats.get(uid);
    if (!seat) return;
    seat.aiMode = enabled ? 'auto' : 'manual';
    this.appendLogs([
      {
        id: rid(),
        ts: Date.now(),
        channel: 'system',
        text: `🤖 ${seat.nickname} ${enabled ? '开启' : '关闭'}了 AI 托管`,
      },
    ]);
    this.broadcastSnapshot();
    if (enabled && this.status === 'running' && this.phase === 'decide' && !this.submissions.has(uid)) {
      void this.aiDecide(uid, 'auto', this.state?.turn ?? 0);
    }
  }

  private async runAiDecisions(): Promise<void> {
    const S = this.state;
    if (!S) return;
    const turn = S.turn;
    const tasks: Promise<void>[] = [];
    for (const p of Object.values(S.players)) {
      if (p.eliminated || p.id === 'boss') continue;
      const seat = this.seats.get(p.id);
      if (!seat) continue;
      if (this.submissions.has(p.id)) continue;
      const needAi = seat.aiMode === 'auto' || !seat.online;
      const hybrid = seat.aiMode === 'hybrid';
      if (!needAi && !hybrid) continue;
      tasks.push(this.aiDecide(p.id, needAi ? 'auto' : 'hybrid', turn));
    }
    if (this.mode === 'coop' && S.players['boss'] && !S.players['boss'].eliminated) {
      tasks.push(this.bossDecide(turn));
    }
    await Promise.allSettled(tasks);
    await this.maybeResolve();
  }

  private async aiDecide(uid: string, kind: 'auto' | 'hybrid', turn: number): Promise<void> {
    const S = this.state;
    if (!S || S.turn !== turn) return;
    const p = S.players[uid];
    if (!p || p.eliminated) return;

    let intent: PlayIntent | null = null;
    const cfg = await this.fetchProvider(uid);
    if (cfg) {
      try {
        const view = this.buildCommanderView(p);
        // AI 不使用固有手牌：清空手牌视图，只给态势
        view.hand = [];
        const messages: LlmMessage[] = [
          { role: 'system', content: buildImprovSystemPrompt() },
          { role: 'user', content: buildImprovUserMessage(view) },
        ];
        const res = await callModel(cfg, messages, {
          jsonMode: true,
          maxTokens: 400,
          temperature: 0.6,
          timeoutMs: 20_000,
        });
        this.reportUsage(uid, cfg.providerId, cfg.modelName, 'commander', res.usage, res.latencyMs, true);
        const plan = parseImprovPlan(res.text, { legalTargets: view.legalTargets, maxMoves: 3 });
        if (plan) {
          const built = planToCards(uid, turn, plan);
          if (built.intents.length > 0) {
            // 动态卡要同时进「运行期注册表」与手牌，才能通过 resolveTurn 的手牌校验
            for (const c of built.cards) {
              registerDynamicCard(c);
              if (!p.hand.includes(c.id)) p.hand.push(c.id);
            }
            intent = { playerId: uid, cards: built.intents };
            this.appendLogs([
              { id: rid(), ts: Date.now(), channel: 'system', text: `🕶️ ${p.nickname} 的自由渗透【${plan.name}】：${plan.narrative}` },
            ]);
            if (plan.reason) {
              this.appendLogs([
                { id: rid(), ts: Date.now(), channel: 'system', text: `🤖 ${p.nickname} 的指挥官：${plan.reason}` },
              ]);
            }
          }
        }
      } catch (e) {
        this.reportUsage(
          uid,
          cfg.providerId,
          cfg.modelName,
          'commander',
          { promptTokens: 0, completionTokens: 0 },
          0,
          false,
          (e as Error).message,
        );
      }
    }
    if (!intent) {
      intent = fallbackPlayIntent(p);
      this.appendLogs([
        { id: rid(), ts: Date.now(), channel: 'system', text: `🤖 ${p.nickname}的指挥官失联，使用保底出牌` },
      ]);
    }

    if (this.state?.turn !== turn || this.submissions.has(uid)) return;
    if (kind === 'auto') {
      this.submissions.set(uid, { cards: intent.cards, source: 'ai' });
      this.broadcastSnapshot();
    } else {
      // hybrid：先存建议，截止时若未手动提交则兜底
      this.hybridSuggestions.set(uid, intent.cards);
    }
    await this.maybeResolve();
  }

  private async bossDecide(turn: number): Promise<void> {
    const S = this.state;
    if (!S || S.turn !== turn) return;
    const boss = S.players['boss'];
    if (!boss || boss.eliminated) return;

    const targets = Object.values(S.players).filter((p) => p.id !== 'boss' && !p.eliminated);
    let cards: PlayCardIntent[] = [];
    const attacks = boss.hand.map((id) => getCard(id)).filter((c) => c && c.kind === 'attack');
    if (targets.length > 0 && attacks.length > 0) {
      const card = attacks[Math.floor(Math.random() * attacks.length)]!;
      const target = targets[Math.floor(Math.random() * targets.length)]!;
      cards = [{ id: card.id, target: target.id, layer: card.targeting === 'enemyWall' ? 'outer' : undefined }];
    } else {
      cards = fallbackPlayIntent(boss).cards;
    }
    this.submissions.set('boss', { cards, source: 'ai' });
  }

  private buildCommanderView(p: EnginePlayer): CommanderView {
    const S = this.state!;
    const others = Object.values(S.players).filter(
      (q) => q.id !== p.id && !q.eliminated && q.team !== 'spectator',
    );
    const enemies = others.filter((q) => !(q.team === p.team && p.team !== 'solo'));
    const allies = others.filter((q) => q.team === p.team && p.team !== 'solo');

    return {
      turn: S.turn,
      maxTurns: CASTLE_CONST.maxTurns,
      resources: p.resources,
      self: {
        id: p.id,
        nickname: p.nickname,
        keepHp: p.castle.keep.hp,
        shield: p.castle.keep.shield,
        outerWallHp: p.castle.outerWall.hp,
        innerWallHp: p.castle.innerWall.hp,
        towers: aliveTowerCount(p.castle),
        troops: { ...cloneTroops(p.troops) },
        troopsTotal: totalTroops(p.troops),
      },
      hand: p.hand.map((id) => {
        const c = getCard(id)!;
        return {
          id,
          name: c?.name ?? id,
          kind: c?.kind ?? 'attack',
          cost: { ...(c?.cost ?? {}) } as Record<string, number>,
          targeting: c?.targeting ?? 'none',
          desc: c?.desc ?? '',
          tag: c?.tag ?? '',
        };
      }),
      enemies: enemies.map((q) => ({
        id: q.id,
        nickname: q.nickname,
        keepHp: q.castle.keep.hp,
        outerWallHp: q.castle.outerWall.hp,
        innerWallHp: q.castle.innerWall.hp,
        towers: aliveTowerCount(q.castle),
        troopsTotal: totalTroops(q.troops),
        threat: q.hand.length * 3 + Math.round(q.resources.gold / 3) + totalTroops(q.troops) * 2,
      })),
      allies: allies.map((q) => ({ id: q.id, nickname: q.nickname, keepHp: q.castle.keep.hp })),
      legalTargets: enemies.map((e) => e.id),
      recentEvents: this.logs.slice(-8).map((l) => l.text),
    };
  }

  /* ────────── AI 裁判 / 战报 ────────── */

  private async judgeTurn(turnLogs: LogEntry[]): Promise<void> {
    const seats = [...this.seats.values()];
    const host = seats.find((s) => s.isHost) ?? seats[0];
    if (!host) return;
    const cfg = await this.fetchProvider(host.uid);
    if (!cfg) return;

    const summary = turnLogs
      .filter((l) => l.channel === 'battle' || l.channel === 'system')
      .slice(-20)
      .map((l) => l.text)
      .join('\n');
    if (!summary.trim()) return;

    try {
      const res = await callModel(cfg, buildJudgePrompt(`第 ${this.state?.turn ?? 0} 回合：\n${summary}`), {
        maxTokens: 80,
        temperature: 0.6,
        timeoutMs: 12_000,
      });
      const text = res.text.trim().slice(0, 90);
      this.reportUsage(host.uid, cfg.providerId, cfg.modelName, 'judge', res.usage, res.latencyMs, true);
      if (text) {
        this.judgeSummary = text;
        this.appendLogs([{ id: rid(), ts: Date.now(), channel: 'judge', text: `⚖️ ${text}` }]);
        this.broadcastSnapshot();
      }
    } catch (e) {
      this.reportUsage(
        host.uid,
        cfg.providerId,
        cfg.modelName,
        'judge',
        { promptTokens: 0, completionTokens: 0 },
        0,
        false,
        (e as Error).message,
      );
    }
  }

  private async finish(w: { id: string | null; name: string | null; reason: string }): Promise<void> {
    this.status = 'finished';
    this.phase = 'finished';
    this.winner = w;

    const S = this.state;
    const ranking = S
      ? Object.values(S.players)
          .filter((p) => p.team !== 'spectator')
          .map((p) => ({
            id: p.id,
            name: p.nickname,
            power: p.castle.keep.hp + p.castle.outerWall.hp + p.castle.innerWall.hp,
          }))
          .sort((a, b) => b.power - a.power)
      : [];

    const report: GameReport = {
      roomId: this.room.id,
      mode: this.mode,
      winner: w.id,
      winnerName: w.name,
      reason: w.reason,
      turns: S?.turn ?? 0,
      ranking,
      judgeSummary: this.judgeSummary,
      finishedAt: Date.now(),
    };

    // 战报叙事（best-effort，8 秒超时）
    const seats = [...this.seats.values()];
    const host = seats.find((s) => s.isHost) ?? seats[0];
    if (host) {
      const cfg = await this.fetchProvider(host.uid);
      if (cfg) {
        try {
          const summary = [
            `模式：${this.mode}；回合数：${report.turns}；胜者：${w.name ?? '平局'}（${w.reason}）`,
            '排名：',
            ...ranking.map((r, i) => `${i + 1}. ${r.name} —— 城堡战力 ${r.power}`),
            '关键记录：',
            ...this.logs.slice(-30).map((l) => l.text),
          ].join('\n');
          const res = await callModel(cfg, buildReportPrompt(summary), {
            maxTokens: 450,
            temperature: 0.8,
            timeoutMs: 8_000,
          });
          this.reportUsage(host.uid, cfg.providerId, cfg.modelName, 'report', res.usage, res.latencyMs, true);
          report.narrative = res.text.trim().slice(0, 800);
        } catch (e) {
          this.reportUsage(
            host.uid,
            cfg.providerId,
            cfg.modelName,
            'report',
            { promptTokens: 0, completionTokens: 0 },
            0,
            false,
            (e as Error).message,
          );
        }
      }
    }

    this.appendLogs([
      {
        id: rid(),
        ts: Date.now(),
        channel: 'system',
        text: `🏆 战斗结束：${w.name ?? '平局'} 获胜（${w.reason}）`,
      },
    ]);

    await this.internal('match.save', {
      roomId: this.room.id,
      mode: this.mode,
      winnerId: null,
      turns: report.turns,
      players: ranking,
      report: report.narrative ?? null,
    });

    this.broadcast({ t: 'game:over', report });
    this.broadcastSnapshot();
    await this.pushLobby();
  }

  /* ────────── 聊天 / 结盟 / 离开 ────────── */

  private handleChat(uid: string | null, channel: 'chat' | 'battle', text: string): void {
    const name = uid ? (this.seats.get(uid)?.nickname ?? '观众') : '观众';
    const clean = text.trim().slice(0, 200);
    if (!clean) return;
    const entry: LogEntry = {
      id: rid(),
      ts: Date.now(),
      channel: channel === 'battle' ? 'battle' : 'chat',
      text: `💬 ${name}：${clean}`,
    };
    this.appendLogs([entry]);
    this.broadcast({ t: 'chat:message', from: name, fromId: uid ?? '', channel, text: clean, ts: entry.ts });
    this.broadcastSnapshot();
  }

  private handleAllyRequest(uid: string, targetUid: string): void {
    const S = this.state;
    if (!S || this.status !== 'running') return;
    const me = this.seats.get(uid);
    const target = this.seats.get(targetUid);
    if (!me || !target || uid === targetUid) return;
    if (S.alliances.some((a) => (a.a === uid && a.b === targetUid) || (a.a === targetUid && a.b === uid))) return;

    this.pendingAlly.set(targetUid, uid);
    this.appendLogs([
      { id: rid(), ts: Date.now(), channel: 'system', text: `🤝 ${me.nickname} 向 ${target.nickname} 发出结盟请求` },
    ]);
    this.sendToUid(targetUid, {
      t: 'chat:message',
      from: '系统',
      fromId: '',
      channel: 'system',
      text: `${me.nickname} 向你请求结盟，可在结盟面板接受`,
      ts: Date.now(),
    });
    this.broadcastSnapshot();
  }

  private handleAllyAccept(uid: string, fromUid: string): void {
    const S = this.state;
    if (!S || this.status !== 'running') return;
    if (this.pendingAlly.get(uid) !== fromUid) return;
    this.pendingAlly.delete(uid);

    S.alliances.push({ a: fromUid, b: uid, untilTurn: S.turn + 3 });
    const a = this.seats.get(fromUid)?.nickname ?? fromUid;
    const b = this.seats.get(uid)?.nickname ?? uid;
    this.appendLogs([
      { id: rid(), ts: Date.now(), channel: 'system', text: `🤝 ${a} 与 ${b} 结为同盟（3 回合内不可互攻）` },
    ]);
    this.broadcast({ t: 'ally:update', alliances: S.alliances });
    this.broadcastSnapshot();
  }

  private handleBetray(uid: string): void {
    const S = this.state;
    if (!S || this.status !== 'running') return;
    const idx = S.alliances.findIndex((al) => al.a === uid || al.b === uid);
    if (idx === -1) return;

    const al = S.alliances[idx];
    const other = al.a === uid ? al.b : al.a;
    S.alliances.splice(idx, 1);

    // 信誉惩罚：背叛方资源 -5；被背叛方获得「复仇」牌
    const betrayer = S.players[uid];
    const victim = S.players[other];
    if (betrayer) betrayer.resources.gold = Math.max(0, betrayer.resources.gold - 5);
    if (victim && victim.hand.length < HAND_LIMIT + 2) victim.hand.push('revenge');

    const a = this.seats.get(uid)?.nickname ?? uid;
    const b = this.seats.get(other)?.nickname ?? other;
    this.appendLogs([
      { id: rid(), ts: Date.now(), channel: 'battle', text: `🗡️ ${a} 背叛了 ${b}！信誉惩罚：-5 金；${b} 获得【复仇】` },
    ]);
    this.broadcast({ t: 'ally:update', alliances: S.alliances });
    this.broadcastSnapshot();
  }

  private sendToUid(uid: string, msg: ServerMessage): void {
    const text = JSON.stringify(msg);
    for (const conn of this.room.getConnections()) {
      if (this.connUid.get(conn.id) === uid) {
        try {
          conn.send(text);
        } catch {
          // ignore
        }
      }
    }
  }

  private sendError(uid: string, code: string, message: string): void {
    this.sendToUid(uid, { t: 'error', code, message });
  }

  private async removeOrOffline(uid: string): Promise<void> {
    const seat = this.seats.get(uid);
    if (!seat) return;
    if (this.status === 'waiting') {
      this.seats.delete(uid);
      this.appendLogs([{ id: rid(), ts: Date.now(), channel: 'system', text: `${seat.nickname} 离开了房间` }]);
      if (seat.isHost) {
        const next = [...this.seats.values()][0];
        if (next) next.isHost = true;
      }
      if (this.seats.size === 0) {
        await this.internal('lobby.remove', { roomId: this.room.id });
      }
    } else {
      seat.online = false;
      this.appendLogs([
        { id: rid(), ts: Date.now(), channel: 'system', text: `📡 ${seat.nickname} 掉线，已切换为 AI 托管` },
      ]);
      const p = this.state?.players[uid];
      if (p && !p.eliminated && this.phase === 'decide' && !this.submissions.has(uid)) {
        void this.aiDecide(uid, 'auto', this.state?.turn ?? 0);
      }
    }
    this.broadcastSnapshot();
    await this.pushLobby();
  }

  /* ────────── 重置 ────────── */

  private async handleReset(uid: string): Promise<void> {
    const seat = this.seats.get(uid);
    if (!seat?.isHost || this.status === 'running') return;
    this.state = null;
    this.status = 'waiting';
    this.phase = 'waiting';
    this.phaseDeadline = 0;
    this.winner = null;
    this.submissions.clear();
    this.hybridSuggestions.clear();
    this.pendingAlly.clear();
    this.judgeSummary = '';
    for (const s of this.seats.values()) s.ready = false;
    this.appendLogs([{ id: rid(), ts: Date.now(), channel: 'system', text: '🔄 房间已重置，等待新房主开局' }]);
    this.broadcastSnapshot();
    await this.pushLobby();
  }
}