/**
 * lib/protocol.ts —— 事件协议（客户端 ⇄ 服务端）
 *
 * PartyKit：每场战斗 = 一个 Party 实例。
 * 服务端权威：客户端只发意图，服务端返回快照 / 事件。
 */

import type { ResourceBag } from './cards';
import type { CastleState, PlayerStatus } from './castle';
import type { TroopBag, TroopKind } from './troops';

export const PROTOCOL_VERSION = 1;

export type GameMode = 'ffa' | 'team' | 'siege' | 'coop';
/** ffa → 'solo'；组队 → 'red'/'blue'；攻城 → 'defense'/'attack'；演习 → 玩家 + 'boss' */
export type TeamId = 'red' | 'blue' | 'defense' | 'attack' | 'solo' | 'boss' | 'spectator';
export type AiMode = 'manual' | 'auto' | 'hybrid';
export type RoomPhase = 'waiting' | 'draw' | 'decide' | 'resolve' | 'recover' | 'finished';

/* ────────────────────── 出牌意图 ────────────────────── */

export interface PlayCardIntent {
  id: string;
  target?: string;
  /** 仅「裂墙 / 铁匠之锤」等需要指定墙体层的卡牌 */
  layer?: 'outer' | 'inner';
  /** 仅「弃甲」需要指定弃置的卡牌 */
  sacrifice?: string;
}

export interface PlayIntent {
  playerId: string;
  cards: PlayCardIntent[];
}

/** 模型指挥官返回的决策 */
export interface CommanderDecision {
  cards: PlayCardIntent[];
  reason: string;
}

/* ────────────────────── 日志 / 联盟 / 事件 ────────────────────── */

export interface LogEntry {
  id: string;
  ts: number;
  channel: 'battle' | 'system' | 'judge' | 'chat';
  text: string;
}

export interface AllianceLink {
  a: string;
  b: string;
  untilTurn: number;
}

export type RandomEventKind = 'disaster' | 'harvest' | 'blackswan' | 'smith' | 'fog';

export type BattleEvent =
  | { type: 'card:played'; playerId: string; cardId: string; targets: string[] }
  | { type: 'card:drawn'; playerId: string; cards: string[] }
  | { type: 'castle:hit'; playerId: string; layer: string; damage: number; hpLeft: number }
  | { type: 'castle:destroyed'; playerId: string; layer: string }
  | { type: 'decoy:absorbed'; playerId: string }
  | { type: 'lurk:planted'; playerId: string; turn: number }
  | { type: 'lurk:exploded'; playerId: string; damage: number }
  | { type: 'troop:recruited'; playerId: string; troop: TroopKind; count: number; total: number }
  | {
      type: 'troop:clash';
      attackerId: string;
      defenderId: string;
      attackerLoss: number;
      defenderLoss: number;
      damage: number;
      attackerRemain: number;
      defenderRemain: number;
    }
  | { type: 'player:eliminated'; playerId: string }
  | { type: 'random:event'; kind: RandomEventKind; text: string }
  | { type: 'game:over'; winner: string | null; reason: string };

/* ────────────────────── 房间快照 ────────────────────── */

export interface PlayerState {
  id: string;
  nickname: string;
  team: TeamId;
  isAI: boolean;
  aiMode: AiMode;
  providerId: string | null;
  providerName: string | null;
  modelName: string | null;
  resources: ResourceBag;
  /** 常备军编制（小兵）：会真的推进、交战、拆墙，见 lib/troops.ts */
  troops: TroopBag;
  /** 手牌（对他人按可见性过滤后下发） */
  hand: string[];
  handCount: number;
  castle: CastleState;
  status: PlayerStatus;
  online: boolean;
  ready: boolean;
  /** 是否房主 */
  isHost: boolean;
  /** 本回合已提交的出牌 */
  submission: { cards: PlayCardIntent[]; reason?: string; source: 'human' | 'ai' | 'fallback' } | null;
}

export interface RoomSnapshot {
  id: string;
  code: string;
  mode: GameMode;
  status: 'waiting' | 'running' | 'finished';
  turn: number;
  phase: RoomPhase;
  /** 毫秒时间戳 */
  phaseDeadline: number;
  players: PlayerState[];
  alliances: AllianceLink[];
  logs: LogEntry[];
  winner: string | null;
  winnerName: string | null;
  campaignId: string | null;
  spectatorCount: number;
  /** 房主 uid */
  hostId: string | null;
}

export interface LobbyRoom {
  id: string;
  code: string;
  mode: GameMode;
  status: RoomSnapshot['status'];
  playerCount: number;
  maxPlayers: number;
  turn: number;
  hostName: string;
}

export interface GameReport {
  roomId: string;
  mode: GameMode;
  winner: string | null;
  winnerName: string | null;
  reason: string;
  turns: number;
  ranking: { id: string; name: string; power: number }[];
  narrative?: string;
  judgeSummary?: string;
  finishedAt: number;
  usage?: { totalTokens: number; cost: number };
}

/* ────────────────────── 客户端 → 服务端 ────────────────────── */

export type ClientMessage =
  | { t: 'lobby:list' }
  | { t: 'room:create'; mode: GameMode; campaignId?: string }
  | { t: 'room:join'; roomId: string; team?: TeamId }
  | { t: 'room:leave' }
  | { t: 'player:ready'; ready: boolean }
  | { t: 'action:play'; cards: PlayCardIntent[] }
  | { t: 'action:auto'; enabled: boolean }
  | { t: 'ally:request'; targetUserId: string }
  | { t: 'ally:accept'; fromUserId: string }
  | { t: 'ally:betray' }
  | { t: 'chat:send'; channel: 'chat' | 'battle'; text: string }
  | { t: 'cmd:start' }
  | { t: 'cmd:pause' }
  | { t: 'cmd:reset' };

/* ────────────────────── 服务端 → 客户端 ────────────────────── */

export type ServerMessage =
  | { t: 'hello'; you: { id: string; nickname: string } | null; protocolVersion: number }
  | { t: 'lobby:update'; rooms: LobbyRoom[] }
  | { t: 'room:state'; snapshot: RoomSnapshot }
  | { t: 'room:patch'; delta: Partial<RoomSnapshot> }
  | { t: 'turn:start'; turn: number; deadline: number; phase: RoomPhase }
  | { t: 'turn:resolve'; events: BattleEvent[]; logs: LogEntry[] }
  | { t: 'card:drawn'; playerId: string; cards: string[] }
  | { t: 'castle:hit'; playerId: string; layer: string; damage: number; hpLeft: number }
  | { t: 'castle:destroyed'; playerId: string; layer: string }
  | { t: 'player:eliminated'; playerId: string }
  | { t: 'ally:update'; alliances: AllianceLink[] }
  | { t: 'chat:message'; from: string; fromId: string; channel: string; text: string; ts: number }
  | { t: 'game:over'; report: GameReport }
  | { t: 'error'; code: string; message: string };