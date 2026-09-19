#!/usr/bin/env node
/**
 * scripts/dev-battle-server.mjs —— 本地开发入口（薄封装）
 *
 * 真正的实现在 **party/server-node.mjs**（与线上 Render 部署的是同一份代码）。
 * 本文件只做一件事：把默认监听地址改成 127.0.0.1:1999，然后加载实现。
 *
 * 为什么需要 Node 版替身（而不是直接跑 workerd）：
 *   proot 环境里 workerd 启动时会做 1GB 对齐的大块 mmap 预留，被内核/PTRACE 层拒绝
 *   （tcmalloc: MmapAligned() failed / Out of memory），无法启动。
 *   而 party/battle.ts 是鸭子类型类，不依赖 workerd，因此用 Node 进程托管即可。
 *
 * 用法：
 *   node scripts/dev-battle-server.mjs     # 等价于 npm run party:dev:node
 *   # 可用 BATTLE_HOST / BATTLE_PORT 覆盖
 */
process.env.BATTLE_HOST ||= '127.0.0.1';
process.env.BATTLE_PORT ||= '1999';
await import('../party/server-node.mjs');