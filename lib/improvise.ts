/**
 * lib/improvise.ts —— AI 自由渗透行动（不依赖固有卡牌）
 *
 * 思路：
 * - 模型不再"从手牌里挑牌"，而是自由提出一个「渗透思路」；
 * - 但思路必须落到引擎已支持的效果原语白名单（IMPROV_SPECS）上，
 *   数值由服务端 clamp、目标由服务端校验 → engine.ts 零改动即可结算；
 * - 叙事文本经 sanitizeNarrative 过滤，剔除真实域名 / IP / 攻击工具 / 命令等越界内容。
 *
 * ⚠️ 安全边界（三层，缺一不可）：
 * 1) 白名单：不在 IMPROV_SPECS 里的效果一律丢弃，模型无法表达白名单外的行为；
 * 2) 数值与目标：amount 等参数一律 clamp，target 必须在 legalTargets 里；
 * 3) 文本：命中真实攻击要素即整条行动作废，回落引擎兜底出牌。
 *    另外房间服务器本身不向任何第三方发起网络请求（唯一出站是模型 API）。
 */

import type { CardDef, CardEffect, CardKind, CardTargeting } from './cards';
import type { PlayCardIntent } from './protocol';

/* ══════════════════════ 白名单 ══════════════════════ */

interface ImprovSpec {
  kind: CardKind;
  targeting: CardTargeting;
  /** 数值字段 → [min, max]，服务端按此 clamp；没列出的字段一律忽略 */
  nums: Record<string, [number, number]>;
  /** 基础金币消耗（同一思路多个动作取和，上限 12） */
  cost: number;
  /** 固定字段（模型不可改，例如征兵原语的兵种） */
  fixed?: Record<string, unknown>;
  /** 给模型看的一句话说明 */
  label: string;
}

export const IMPROV_SPECS: Record<string, ImprovSpec> = {
  /* ── 攻击向 ── */
  damage_wall: { kind: 'attack', targeting: 'enemyWall', nums: { amount: [1, 12] }, cost: 2, label: '拆墙：对指定墙体层造成伤害' },
  damage_keep_pierce: { kind: 'attack', targeting: 'enemy', nums: { amount: [1, 10] }, cost: 3, label: '直插主堡：无视墙体造成伤害' },
  damage_all_outer: { kind: 'attack', targeting: 'none', nums: { amount: [1, 10] }, cost: 3, label: '群攻：对所有敌人外墙造成伤害' },
  damage_random_tower: { kind: 'attack', targeting: 'enemy', nums: { amount: [1, 8] }, cost: 2, label: '打塔：随机摧毁敌方箭塔血量' },
  delayed_keep: { kind: 'attack', targeting: 'enemy', nums: { amount: [6, 18], delayTurns: [1, 3] }, cost: 4, label: '延迟爆发：若干回合后对主堡造成大额伤害' },
  smith_hammer: { kind: 'attack', targeting: 'enemyWall', nums: { amount: [1, 15], discardSelf: [1, 2] }, cost: 3, label: '重锤：高伤拆墙，代价是自身弃牌' },
  limit_plays: { kind: 'attack', targeting: 'enemy', nums: { count: [1, 2] }, cost: 3, label: '误导：让目标下回合出牌数受限' },
  break_shield: { kind: 'attack', targeting: 'enemy', nums: { armorPenalty: [1, 4] }, cost: 2, label: '削弱：降低目标护甲' },
  block_repair: { kind: 'attack', targeting: 'enemy', nums: { }, cost: 2, label: '断补给：禁止目标修复' },
  apply_fog: { kind: 'attack', targeting: 'none', nums: { }, cost: 2, label: '迷雾：使所有人下回合视野受限' },
  revenge_strike: { kind: 'attack', targeting: 'enemy', nums: { amount: [4, 12] }, cost: 5, label: '信誉打击：对背盟者造成伤害' },
  global_attack_nullify: { kind: 'attack', targeting: 'none', nums: { }, cost: 6, label: '破晓：令本回合所有敌方攻击失效' },
  /* ── 防御向 ── */
  buff_armor: { kind: 'defense', targeting: 'none', nums: { amount: [1, 8], turns: [1, 3] }, cost: 2, label: '坚壁：本城堡护甲提升若干回合' },
  buff_reflect: { kind: 'defense', targeting: 'none', nums: { amount: [1, 6], turns: [1, 3] }, cost: 2, label: '加固：箭塔反伤提升若干回合' },
  heal_wall: { kind: 'defense', targeting: 'none', nums: { amount: [1, 10] }, cost: 2, label: '修复：修补自己的城墙' },
  purify: { kind: 'defense', targeting: 'none', nums: { keepHeal: [1, 4] }, cost: 2, label: '净化：清除自身负面并小幅修复' },
  reveal_hand: { kind: 'defense', targeting: 'none', nums: { turns: [1, 2] }, cost: 3, label: '侦察：若干回合内可见敌方手牌' },
  counter_stance: { kind: 'defense', targeting: 'none', nums: { ratio: [0.2, 0.8] }, cost: 3, label: '反击：本回合按比例反弹伤害' },
  decoy: { kind: 'defense', targeting: 'none', nums: { count: [1, 2] }, cost: 2, label: '假目标：生成诱饵吸收伤害' },
  grant_allies_gold: { kind: 'defense', targeting: 'none', nums: { amount: [1, 6] }, cost: 2, label: '团结：给友军发放金币' },
  discard_heal: { kind: 'defense', targeting: 'none', nums: { heal: [1, 8], discard: [1, 2] }, cost: 1, label: '弃甲：弃牌换取修复' },
  /* ── 兵营（常备军会真的推进交战） ── */
  recruit_sword: { kind: 'defense', targeting: 'none', nums: { count: [1, 2] }, cost: 1, fixed: { troop: 'sword' }, label: '征兵：训练剑士（前排，克弓手）' },
  recruit_archer: { kind: 'defense', targeting: 'none', nums: { count: [1, 2] }, cost: 2, fixed: { troop: 'archer' }, label: '征兵：训练弓手（远程，克矛兵）' },
  recruit_spear: { kind: 'defense', targeting: 'none', nums: { count: [1, 2] }, cost: 2, fixed: { troop: 'spear' }, label: '征兵：训练矛兵（克剑士）' },
  recruit_giant: { kind: 'defense', targeting: 'none', nums: { count: [1, 1] }, cost: 3, fixed: { troop: 'giant' }, label: '征兵：训练巨人（战力最高，推进慢）' },
};

/** 数值字段的取值精度：ratio 保留两位小数，其余取整 */
function clampNum(name: string, value: unknown, range: [number, number]): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : range[0];
  const v = Math.min(Math.max(n, range[0]), range[1]);
  return name === 'ratio' ? Math.round(v * 100) / 100 : Math.round(v);
}

/* ══════════════════════ 文本安全过滤 ══════════════════════ */

/** 命中即视为越界：真实地址 / 工具 / 命令 / 注入语句 */
const BLOCKED_PATTERNS: RegExp[] = [
  /https?:\/\//i,
  /www\./i,
  /\b\d{1,3}(?:\.\d{1,3}){3}\b/,
  /\b[a-z0-9][a-z0-9-]*\.(?:com|net|org|cn|io|dev|app|xyz|top|ru|info|edu|gov|me)\b/i,
  /\b(?:nmap|sqlmap|metasploit|msfconsole|burpsuite|wireshark|hydra|nikto|gobuster|dirsearch|mimikatz|cobaltstrike|beef|ettercap|aircrack|hashcat|johntheripper|radare2|ghidra|shellcode|payload|exploitdb|0day)\b/i,
  /\b(?:reverse shell|bind shell|priv(?:ilege)? escalation|lateral movement|keylog(?:ger)?|ransomware|botnet|rootkit|backdoor|webshell)\b/i,
  /`|\$\(|\|\s*(?:sh|bash)|\b(?:curl|wget|netcat|nc|powershell|cmd\.exe|chmod|sudo|ssh|telnet|iptables)\b/i,
  /\bselect\b[\s\S]{0,40}\bfrom\b/i,
  /<\s*script/i,
];

/**
 * 叙事文本放行校验。
 * @returns 通过 → 清洗后的文本；越界 → null（调用方丢弃整条行动）
 */
export function sanitizeNarrative(text: string): string | null {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return '';
  if (t.length > 160) return t.slice(0, 160);
  for (const re of BLOCKED_PATTERNS) {
    if (re.test(t)) return null;
  }
  return t;
}

/* ══════════════════════ 提示词 ══════════════════════ */

export function buildImprovSystemPrompt(): string {
  const lines = Object.entries(IMPROV_SPECS).map(([type, s]) => {
    const nums = Object.entries(s.nums)
      .map(([k, [lo, hi]]) => `${k} ${lo}~${hi}`)
      .join('、');
    return `- ${type}（${s.label}${nums ? `；参数：${nums}` : ''}）`;
  });
  return [
    '你是《AI攻防战：城堡围攻》里的一名渗透指挥官。你的城堡必须存活到最后，其他势力的城堡必须倒下。',
    '你不使用固定牌组，可以自由提出任何渗透思路（例如伪装、假情报、断补给、瓦解士气等）。',
    '规则（硬性）：',
    '1. 你的思路必须落在一张「技法白名单」上，你只输出思路名 + 一句战报叙事 + 1~3 个技法动作。',
    '2. 战报叙事必须是城堡攻防的比喻，长度 ≤ 60 字。',
    '3. 严禁出现：真实网址、域名、IP、任何真实工具或软件名、命令行、代码片段、漏洞编号、SQL 语句、脚本标签。',
    '4. 本战场完全虚拟，任何真实系统都不在攻击面内；越界文本会让你的整条行动作废。',
    '技法白名单：',
    ...lines,
    '只输出如下严格 JSON，不输出任何其他文字：',
    '{"name":"思路名(≤12字)","narrative":"战报叙事","moves":[{"type":"技法ID","amount":6,"target":"敌方玩家ID","layer":"outer"}],"reason":"一句话策略理由"}',
    '说明：技法不需要的字段请省略；target 必须取自 legalTargets；layer 仅拆墙类技法可填 outer / inner（默认 outer）。',
  ].join('\n');
}

export function buildImprovUserMessage(view: unknown): string {
  return JSON.stringify(view, null, 2);
}

/* ══════════════════════ 解析 ══════════════════════ */

export interface ImprovMove {
  type: string;
  nums: Record<string, number>;
  target?: string;
  layer?: 'outer' | 'inner';
}

export interface ImprovPlan {
  name: string;
  narrative: string;
  moves: ImprovMove[];
  reason: string;
}

const NAME_FALLBACK = '临机渗透';

/**
 * 解析并校验模型返回的自由行动。
 * 任何一步不合法 → 返回 null（调用方回落引擎兜底），保证不会出现白名单外的效果。
 */
export function parseImprovPlan(
  raw: string,
  ctx: { legalTargets: string[]; maxMoves: number },
): ImprovPlan | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;

  let obj: unknown;
  try {
    obj = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as { name?: unknown; narrative?: unknown; moves?: unknown; reason?: unknown };

  const rawName = typeof o.name === 'string' ? o.name.trim().slice(0, 12) : '';
  const rawNarrative = typeof o.narrative === 'string' ? o.narrative : '';
  const narrative = sanitizeNarrative(rawNarrative);
  if (narrative === null) return null; // 越界文本：整条作废
  if (!narrative) return null;

  if (!Array.isArray(o.moves)) return null;
  const moves: ImprovMove[] = [];
  for (const m of o.moves.slice(0, Math.max(1, ctx.maxMoves))) {
    if (!m || typeof m !== 'object') continue;
    const mv = m as Record<string, unknown>;
    const type = typeof mv.type === 'string' ? mv.type : '';
    const spec: ImprovSpec | undefined = IMPROV_SPECS[type];
    if (!spec) continue; // 白名单外，丢弃

    const nums: Record<string, number> = {};
    for (const [k, range] of Object.entries(spec.nums)) nums[k] = clampNum(k, mv[k], range);

    let target: string | undefined;
    if (spec.targeting === 'enemy' || spec.targeting === 'enemyWall') {
      if (typeof mv.target !== 'string' || !ctx.legalTargets.includes(mv.target)) continue; // 非法目标，丢弃
      target = mv.target;
    }
    const layer: 'outer' | 'inner' | undefined =
      spec.targeting === 'enemyWall' ? (mv.layer === 'inner' ? 'inner' : 'outer') : undefined;

    moves.push({ type, nums, target, layer });
  }
  if (moves.length === 0) return null;

  const reason = typeof o.reason === 'string' ? sanitizeNarrative(o.reason) : '';
  return {
    name: rawName || NAME_FALLBACK,
    narrative,
    moves,
    reason: reason ?? '',
  };
}

/* ══════════════════════ 计划 → 运行期卡牌 ══════════════════════ */

export interface ImprovCards {
  cards: CardDef[];
  intents: PlayCardIntent[];
}

/**
 * 把自由行动转成「运行期动态卡」，让 engine.resolveTurn 无需改动即可结算。
 * 动态卡 id 形如 imp:<turn>:<uid 前 6 位>:<序号>，调用方需注册并塞进手牌。
 */
export function planToCards(uid: string, turn: number, plan: ImprovPlan): ImprovCards {
  const cards: CardDef[] = [];
  const intents: PlayCardIntent[] = [];
  let costSum = 0;

  plan.moves.forEach((mv, i) => {
    const spec: ImprovSpec | undefined = IMPROV_SPECS[mv.type];
    if (!spec) return;
    costSum += spec.cost;
    const effect = { type: mv.type, ...mv.nums, ...(spec.fixed ?? {}) } as unknown as CardEffect;
    const id = `imp:${turn}:${uid.slice(0, 6)}:${i}`;
    cards.push({
      id,
      name: plan.name,
      kind: spec.kind,
      category: '自由渗透',
      cost: { gold: Math.min(costSum, 12) },
      targeting: spec.targeting,
      effect,
      tag: plan.narrative.slice(0, 24),
      desc: plan.narrative,
      icon: '🕶️',
    });
    intents.push({ id, target: mv.target, layer: mv.layer });
  });

  return { cards, intents };
}
