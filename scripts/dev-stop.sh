#!/bin/sh
# scripts/dev-stop.sh —— 停止本地开发进程（数据库 / 房间服务器 / Next.js）
# 注意：不会动 Redis（可能被你其他项目共用）
cd "$(dirname "$0")/.." || exit 1
DIR=/tmp/csai

for name in pglite battle next; do
  pidfile="$DIR/$name.pid"
  if [ -f "$pidfile" ]; then
    pid=$(cat "$pidfile")
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null
      sleep 1
      kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null
      echo "[dev] $name 已停止 (pid $pid)"
    fi
    rm -f "$pidfile"
  fi
done

# 兜底：清理没有 pidfile 的残留进程（用方括号避免匹配到本脚本自身）
pkill -f 'dev-pglite[.]mjs' 2>/dev/null
pkill -f 'dev-battle-server[.]mjs' 2>/dev/null
pkill -f 'next-server' 2>/dev/null

echo "[dev] 完成。Redis 未受影响；需要的话执行： redis-cli shutdown nosave"