#!/usr/bin/env node
/**
 * party/server-node.mjs —— 生产可用的「房间服务器」（Node 版，PartyKit 协议兼容）
 *
 * 背景：
 *   `party/battle.ts` 里的 BattleServer 是**鸭子类型**类：只 `import type` 引用 PartyKit 类型，
 *   运行时只依赖 room 上的 `id` / `getConnections()` / `broadcast()` / `env` / `storage?.setAlarm()`，
 *   以及连接对象上的 `id` / `send()` / `close()`。因此任何 Node 进程都能托管它，
 *   无需 workerd / Cloudflare Workers。
 *
 *   端点与协议与 PartyKit 完全一致：
 *     ws(s)://<host>/parties/<party>/<roomId>?ticket=<JWT>&mode=<ffa|siege|coop|team>
 *     GET    /parties/<party>/<roomId>          → 房间 HTML 信息 / 健康探针
 *     GET    /health                            → 进程健康检查（Render 等平台探针）
 *
 * 环境变量：
 *   PORT / BATTLE_PORT        监听端口（默认 1999）
 *   HOST / BATTLE_HOST        监听地址（默认 0.0.0.0，云平台需要）
 *   APP_URL                   Next.js 站点地址（房间服务器回调用，如 https://xxx.vercel.app）
 *   INTERNAL_API_KEY          Next ↔ 房间服务器内部桥接密钥（与 Next 端一致）
 *   JWT_SECRET                票据验签密钥（与 Next 端一致）
 *   其余（DEFAULT_MODEL_* 等）可选，透传给房间逻辑
 *
 * 本地开发入口见 scripts/dev-battle-server.mjs（会以 127.0.0.1:1999 + .env.local 启动本文件）。
 */
import { createServer } from 'node:http';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';
import { WebSocketServer } from 'ws';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const HOST = process.env.BATTLE_HOST || process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.BATTLE_PORT || process.env.PORT || 1999);

/** 房间空闲多久后回收（毫秒），防止长期运行内存膨胀 */
const ROOM_IDLE_TTL = Number(process.env.ROOM_IDLE_TTL_MS || 30 * 60 * 1000);

/* ─────────────── 1. 环境变量：若存在 .env.local 则覆盖（本地开发用） ─────────────── */
function loadEnv() {
  const env = { ...process.env };
  const file = path.join(ROOT, '.env.local');
  if (!existsSync(file)) return env;
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i === -1) continue;
    env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return env;
}
const ENV = loadEnv();

/* ─────────────── 2. esbuild 转译 party/battle.ts（TS → Node ESM） ─────────────── */
const CACHE_DIR = path.join(ROOT, 'node_modules', '.cache');
mkdirSync(CACHE_DIR, { recursive: true });
const OUTFILE = path.join(CACHE_DIR, 'battle-server.mjs');

await build({
  entryPoints: [path.join(ROOT, 'party', 'battle.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node18',
  outfile: OUTFILE,
  logLevel: 'warning',
});
const BattleServer = (await import(pathToFileURL(OUTFILE).href)).default;
console.log('[battle] party/battle.ts transpiled →', path.relative(ROOT, OUTFILE));

/* ─────────────── 3. 房间表（≈ Durable Object 实例） ─────────────── */
const rooms = new Map();

function getRoom(roomId) {
  const cached = rooms.get(roomId);
  if (cached) {
    cached.lastActive = Date.now();
    return cached;
  }

  const conns = new Map(); // conn → ws
  const room = {
    id: roomId,
    env: ENV,
    getConnections: () => [...conns.keys()],
    broadcast: (msg, without) => {
      for (const c of conns.keys()) {
        if (c === without) continue;
        try {
          c.send(msg);
        } catch {
          /* 忽略单连接发送失败 */
        }
      }
    },
    storage: {
      setAlarm: (ts) => {
        if (rec.alarmTimer) clearTimeout(rec.alarmTimer);
        const delay = Math.max(0, Number(ts) - Date.now());
        rec.alarmTimer = setTimeout(() => void rec.server.onAlarm?.(), delay);
      },
      getAlarm: async () => null,
      deleteAlarm: async () => {
        if (rec.alarmTimer) clearTimeout(rec.alarmTimer);
        rec.alarmTimer = null;
      },
    },
  };

  const rec = {
    room,
    server: new BattleServer(room),
    conns,
    started: false,
    alarmTimer: null,
    createdAt: Date.now(),
    lastActive: Date.now(),
  };
  rooms.set(roomId, rec);
  console.log(`[battle] room "${roomId}" created (共 ${rooms.size} 间)`);
  return rec;
}

/** 空闲房间回收：无连接且超过 TTL 未活动 */
setInterval(() => {
  const now = Date.now();
  for (const [id, rec] of rooms) {
    if (rec.conns.size === 0 && now - rec.lastActive > ROOM_IDLE_TTL) {
      if (rec.alarmTimer) clearTimeout(rec.alarmTimer);
      rooms.delete(id);
      console.log(`[battle] room "${id}" 空闲回收（剩 ${rooms.size} 间）`);
    }
  }
}, 60_000).unref();

/* ─────────────── 4. HTTP + WebSocket 端点 ─────────────── */
const wss = new WebSocketServer({ noServer: true });
const ROOM_PATH = /^\/parties\/([^/]+)\/([^/]+)\/?$/;

const http = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);

  // 健康检查（云平台探针 / 排障）
  if (url.pathname === '/health' || url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        service: 'castle-siege-party',
        rooms: rooms.size,
        connections: [...rooms.values()].reduce((n, r) => n + r.conns.size, 0),
        uptimeSec: Math.round(process.uptime()),
      }),
    );
    return;
  }

  const m = url.pathname.match(ROOM_PATH);
  if (!m) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, message: 'not found' }));
    return;
  }
  const rec = getRoom(decodeURIComponent(m[2]));
  try {
    const out = await rec.server.onRequest?.();
    const body = out ? await out.text() : '';
    res.writeHead(out?.status ?? 200, Object.fromEntries(out?.headers ?? [['Content-Type', 'application/json']]));
    res.end(body);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, message: String(e?.message || e) }));
  }
});

http.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
  const m = url.pathname.match(ROOM_PATH);
  if (!m) {
    socket.destroy();
    return;
  }
  const roomId = decodeURIComponent(m[2]);
  wss.handleUpgrade(req, socket, head, (ws) => void onConnection(ws, req, roomId));
});

async function onConnection(ws, req, roomId) {
  const rec = getRoom(roomId);
  const connId = randomUUID();
  const conn = {
    id: connId,
    uri: req.url,
    get readyState() {
      return ws.readyState;
    },
    send: (data) => {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(typeof data === 'string' ? data : Buffer.from(data));
    },
    close: (code = 1000, reason = '') => ws.close(code, reason),
  };
  rec.conns.set(conn, ws);
  rec.lastActive = Date.now();

  ws.on('message', (data, isBinary) => {
    const raw = isBinary ? new Uint8Array(data).buffer : data.toString();
    rec.lastActive = Date.now();
    Promise.resolve(rec.server.onMessage?.(raw, conn)).catch((e) =>
      console.error('[battle] onMessage error:', e),
    );
  });
  ws.on('close', () => {
    rec.conns.delete(conn);
    rec.lastActive = Date.now();
    Promise.resolve(rec.server.onClose?.(conn)).catch((e) => console.error('[battle] onClose error:', e));
  });
  ws.on('error', () => {
    try {
      ws.close();
    } catch {
      /* 忽略 */
    }
  });

  try {
    if (!rec.started) {
      rec.started = true;
      await rec.server.onStart?.();
    }
    await rec.server.onConnect?.(conn, { request: new Request(`http://${HOST}:${PORT}${req.url || '/'}`, { headers: req.headers }) });
  } catch (e) {
    console.error('[battle] onConnect error:', e);
    try {
      ws.close(1011, 'server error');
    } catch {
      /* 忽略 */
    }
  }
}

http.listen(PORT, HOST, () => {
  console.log(`[battle] listening on http://${HOST}:${PORT}/parties/<party>/<roomId>?ticket=…&mode=…`);
  console.log(`[battle] health: http://${HOST}:${PORT}/health`);
  console.log(`[battle] APP_URL=${ENV.APP_URL || '(未设置)'}  INTERNAL_API_KEY=${ENV.INTERNAL_API_KEY ? 'SET' : 'MISSING'}  JWT_SECRET=${ENV.JWT_SECRET ? 'SET' : 'MISSING'}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`[battle] ${sig} received, shutting down…`);
    http.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 800).unref();
  });
}