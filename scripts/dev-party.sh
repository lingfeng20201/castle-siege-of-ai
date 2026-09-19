#!/bin/sh
# scripts/dev-party.sh —— 本地启动 PartyKit 房间服务器（WebSocket 对战）
#
# 为什么需要它：party/battle.ts 通过 this.env(key) 读取 APP_URL / INTERNAL_API_KEY 等
# 变量来回调 Next 的 /api/internal/party 做持久化。PartyKit dev 对 .env.local 的加载
# 不保证，因此这里显式 source .env.local 后再启动，保证两侧配置同源。
#
# 用法：sh scripts/dev-party.sh   （监听 127.0.0.1:1999）
cd "$(dirname "$0")/.." || exit 1

if [ -f ./.env.local ]; then
  set -a
  . ./.env.local
  set +a
fi

echo "[party] APP_URL=$APP_URL  INTERNAL_API_KEY=${INTERNAL_API_KEY:+SET}"
exec ./node_modules/.bin/partykit dev --port 1999
