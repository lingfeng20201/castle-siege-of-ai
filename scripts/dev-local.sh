#!/bin/sh
# scripts/dev-local.sh —— 本地一键启动（数据库 + 对战房间服务器 + Next.js）
#
# 三个进程：
#   1) pglite   : scripts/dev-pglite.mjs        数据库（WASM Postgres + TCP 桥 127.0.0.1:5432）
#   2) battle   : scripts/dev-battle-server.mjs 对战房间服务器（WebSocket 127.0.0.1:1999）
#   3) next     : next dev                      网站本体（http://127.0.0.1:3000）
#
# 前置：已安装 Redis 并运行（redis-server --daemonize yes），且 npm install 完成。
# 日志：/tmp/csai/<name>.log    停止：sh scripts/dev-stop.sh
cd "$(dirname "$0")/.." || exit 1

DIR=/tmp/csai
mkdir -p "$DIR"

start() {
  name=$1
  shift
  pidfile="$DIR/$name.pid"
  if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    echo "[dev] $name 已在运行 (pid $(cat "$pidfile"))"
    return 0
  fi
  nohup "$@" > "$DIR/$name.log" 2>&1 &
  echo $! > "$pidfile"
  echo "[dev] $name 已启动 (pid $!) → $DIR/$name.log"
}

# Redis：没跑就自动拉起（不杀已有实例），它是限流/验证码/大厅心跳的依赖
if command -v redis-cli >/dev/null 2>&1; then
  if redis-cli ping 2>/dev/null | grep -q PONG; then
    echo "[dev] Redis 正常 (PONG)"
  else
    echo "[dev] Redis 未响应 → 尝试启动 redis-server"
    redis-server --daemonize yes >/dev/null 2>&1
    sleep 1
    if redis-cli ping 2>/dev/null | grep -q PONG; then
      echo "[dev] Redis 已启动 (PONG)"
    else
      echo "[dev] ⚠️ Redis 启动失败，注册/登录会报 500，请手动排查：redis-server --daemonize yes"
    fi
  fi
fi

start pglite node scripts/dev-pglite.mjs
sleep 4
start battle node scripts/dev-battle-server.mjs
start next ./node_modules/.bin/next dev

sleep 6
echo ""
echo "──────────── 本地服务 ────────────"
echo "数据库 : postgres://postgres:postgres@127.0.0.1:5432/postgres"
echo "房间服 : ws://127.0.0.1:1999/parties/main/<roomId>"
echo "网站   : http://127.0.0.1:3000   ← 手机浏览器打开这个"
echo "─────────────────────────────────"
echo "自检： node scripts/smoke-local.mjs"
echo "日志： tail -f $DIR/next.log"
echo "停止： sh scripts/dev-stop.sh"
echo ""
echo "首次打开页面需等 Next.js 编译（约 10-15 秒），之后会很快。"