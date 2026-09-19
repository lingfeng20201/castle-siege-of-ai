import type { GameMode, RoomPhase, TeamId } from '../protocol';

/**
 * lib/client/ui.ts —— 客户端共享的展示常量与格式化工具
 */

export function cls(...xs: (string | false | null | undefined)[]): string {
  return xs.filter(Boolean).join(' ');
}

export const MODE_LABEL: Record<GameMode, string> = {
  ffa: '混战 FFA',
  team: '组队 2v2 / 3v3',
  siege: '攻城战',
  coop: '演习 Co-op',
};

export const MODE_SHORT: Record<GameMode, string> = {
  ffa: '混战',
  team: '组队',
  siege: '攻城',
  coop: '演习',
};

export const MODE_DESC: Record<GameMode, string> = {
  ffa: '2-6 人 · 人人可攻击任何人，可临时结盟',
  team: '2v2 或 3v3 · 队友共享视野，不能互攻',
  siege: '4 人防守 vs 2 人进攻 · 攻方资源减半但可集火',
  coop: '全体对抗脚本 AI「无名之堡」，练习用',
};

export const PHASE_LABEL: Record<RoomPhase, string> = {
  waiting: '等待集结',
  draw: '抽牌',
  decide: '决策中',
  resolve: '结算中',
  recover: '恢复中',
  finished: '已结束',
};

export const TEAM_LABEL: Record<TeamId, string> = {
  red: '红队',
  blue: '蓝队',
  defense: '防守方',
  attack: '进攻方',
  solo: '独狼',
  boss: '无名之堡',
  spectator: '观众',
};

export const TEAM_COLOR: Record<TeamId, string> = {
  red: '#ff3b5c',
  blue: '#00f0ff',
  defense: '#8b5cf6',
  attack: '#ffb020',
  solo: '#ffd700',
  boss: '#ff3b5c',
  spectator: '#8aa0b8',
};

/** 混战/演习中按座位轮换的调色板（让每位玩家颜色可区分） */
export const PLAYER_PALETTE = ['#ffd700', '#8b5cf6', '#00f0ff', '#39ff14', '#ff3b5c', '#ffb020'];

export function playerColor(team: TeamId, index: number, mode: GameMode): string {
  if (mode === 'team' || mode === 'siege') return TEAM_COLOR[team] ?? '#8aa0b8';
  if (team === 'boss') return TEAM_COLOR.boss;
  return PLAYER_PALETTE[index % PLAYER_PALETTE.length];
}

export function modeMinPlayers(mode: GameMode): number {
  if (mode === 'ffa') return 2;
  if (mode === 'team') return 2;
  if (mode === 'siege') return 3;
  return 1; // coop：单人即可演练
}

export function modeMaxPlayers(_mode: GameMode): number {
  // 与 party/battle.ts 的 maxPlayersFor 保持一致：所有模式统一 20 人
  return 20;
}

export function fmtNum(v: number, digits = 0): string {
  if (!Number.isFinite(v)) return '0';
  return v.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** 费用（美元）显示：小额保留 4 位 */
export function fmtCost(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return '$0.0000';
  if (v < 0.01) return `$${v.toFixed(5)}`;
  return `$${v.toFixed(4)}`;
}

export function fmtTokens(v: number): string {
  if (!Number.isFinite(v)) return '0';
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return String(Math.round(v));
}

export function roleLabel(role: string | null): string {
  switch (role) {
    case 'commander':
      return '指挥官决策';
    case 'judge':
      return '裁判点评';
    case 'report':
      return '战报叙事';
    case 'test':
      return '连通测试';
    default:
      return role ?? '其他';
  }
}

export function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

/** 房间号：大小写不敏感，仅允许字母数字与短横线 */
export function sanitizeRoomCode(input: string): string {
  return input.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 16);
}

export function randomRoomCode(len = 6): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < len; i += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

/** PartyKit 连接地址（浏览器侧） */
export function partyHost(): string {
  return process.env.NEXT_PUBLIC_PARTYKIT_HOST || 'localhost:1999';
}

export function partyPartyName(): string {
  return process.env.NEXT_PUBLIC_PARTYKIT_PARTY || 'main';
}