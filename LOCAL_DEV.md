# 本地运行指南（Android proot Ubuntu）

本文件记录**在手机里把《AI攻防战：城堡围攻》跑起来**的完整方案、踩过的坑与结论。
线上部署请看 [`DEPLOY.md`](./DEPLOY.md)。

---

## 一、最终可用方案（一键启动）

```bash
cd /root/castle-siege-of-ai

# 1) 缓存（Redis 只需启动一次，之后常驻）
redis-server --daemonize yes

# 2) 一键启动：数据库 + 对战房间服务器 + Next.js
npm run dev:local

# 3) 自检（注册 → 取票 → 连房间 → 大厅）
npm run smoke

# 停止
npm run dev:stop
```

启动后：

| 服务 | 地址 | 说明 |
|---|---|---|
| 网站 | **http://127.0.0.1:3000** | 手机浏览器直接打开这个 |
| 对战房间服 | `ws://127.0.0.1:1999/parties/main/<roomId>` | 前端自动连接 |
| 数据库 | `postgres://postgres:postgres@127.0.0.1:5432/postgres` | PGlite（WASM Postgres 16） |
| 缓存 | `redis://127.0.0.1:6379` | 原生 redis-server 7.0.15 |

日志目录：`/tmp/csai/{pglite,battle,next}.log`，PID 文件同目录。

> 首次打开页面需等 Next.js 编译（约 10–15 秒）。

## 二、单人怎么试玩

- 建房时选 **`coop`（联军讨伐）** 模式：`minPlayersFor('coop') === 1`，**一个人就能开局**打 AI BOSS。
- `ffa` 需 ≥2 人、`siege` 需 ≥3 人：可用「手机浏览器 + 另一台设备」或开两个浏览器（其一用无痕）注册两个账号对打。
- 想让 AI 指挥官真正调用大模型：先在 `/settings/models` 添加 BYOK 配置（baseUrl / apiKey / model）。
  没配也能玩——引擎内置 `fallbackPlayIntent()` 兜底出牌，不会卡死。

## 三、环境限制与两个关键替换（重要）

本机是 **aarch64 / Ubuntu 24.04.5 LTS / proot 容器**（无 systemd，不支持部分系统调用），
因此标准方案里有**两个组件无法原生运行**，已分别替换为等价实现：

### 1) PostgreSQL → PGlite（WASM 版 Postgres）

- **现象**：`initdb` 失败，根因 `FATAL: could not create shared memory segment: Function not implemented`，
  系统调用 `shmget(key=..., size=56, 03600)` —— **proot 不提供 System V 共享内存**。
- **已试过且无效**：`-c shared_memory_type=mmap`（bootstrap 阶段仍走 shmget）、
  给 `postgres` 套 wrapper 强制注入参数（干扰 `initdb` 的 `--boot` 参数传递）。
- **替代**：`scripts/dev-pglite.mjs` 用 `@electric-sql/pglite`（纯 WASM Postgres 16）+
  `@electric-sql/pglite-socket` 起一个 TCP 桥监听 `127.0.0.1:5432`，
  项目的 `lib/db.ts`（`pg.Pool`）**零改动**即可连接。
- **细节**：脚本执行 `sql/schema.sql` 时会剔除 `CREATE EXTENSION pgcrypto;`
  （PGlite 无该扩展，而 PG16 的 `gen_random_uuid()` 已内置）；真实 Postgres 上仍需该语句。
- **遗留物**：`/usr/lib/postgresql/16/bin/postgres` 曾被改成 wrapper（原始二进制备份为同目录 `postgres.real`）。
  当前方案不使用原生 PG；若将来换到支持 `shmget` 的环境要用原生 PG，请先还原该文件并 `initdb`。

### 2) PartyKit（workerd）→ Node 版同协议房间服务器

- **现象**：`partykit dev` 能编译通过，但 workerd 启动即崩：
  `tcmalloc: MmapAligned() failed - unable to allocate ... size=1073741824, alignment=1073741824`
  （V8 沙箱需要 1GB 对齐的大块 mmap 预留，被 proot 层拒绝；`ulimit` 均已 unlimited）。
- **替代**：`scripts/dev-battle-server.mjs`。
  关键前提：`party/battle.ts` 的 `BattleServer` 是**鸭子类型**类 —— 只用 `import type` 引用 Party 类型，
  运行时仅依赖 `room.{id,getConnections,env,storage?.setAlarm}` 与连接对象的 `{id,send,close}`。
  该脚本用 esbuild 把 `party/battle.ts` 转译为 Node ESM，再自建 HTTP/WebSocket 端点，
  路径与查询串（`/parties/<party>/<roomId>?ticket=…&mode=…`）与 PartyKit 完全一致。
- **因此**：`lib/client/socket.ts` 与 `party/battle.ts` **均为零改动**，线上部署照旧用 `npm run party:deploy`。
- **能力差异**：本地房间是单进程内存态，没有 Durable Object 的持久化/迁移/休眠；
  对本地联机试玩无影响。

## 四、本地专用的安全降级（生产禁用）

未配置 QQ SMTP 时无法收验证码，注册闭环会断。为本地开发增加了降级：

- `.env.local` 中 `MAIL_DEV_LOG=true`：`/api/auth/send-code` 在
  **未配置 `QQ_SMTP_*` 且 `NODE_ENV !== 'production'`** 时，把验证码写入服务端日志并随响应返回
  （字段 `devCode`），注册页会自动填入并提示。
- 生产环境：二者任一不满足即走真实 SMTP，不会泄露验证码。
- 想改用真实邮箱验证：在 `.env.local` 填 `QQ_SMTP_USER`（QQ 邮箱）与 `QQ_SMTP_CODE`（16 位授权码）即可自动走真实发信。

## 五、踩坑记录（供后续环境复用时参考）

| 问题 | 现象 | 结论 |
|---|---|---|
| Node 自带但没有 npm | `npm: command not found`，`/usr/lib/node_modules` 为空 | 手动装 **npm 10.9.2**（12.x 要求 Node ≥22，与 Node 18 不兼容，**勿升级**） |
| Node 18 缺 `CustomEvent` | `ReferenceError: CustomEvent is not defined`（`@electric-sql/pglite-socket` 内部派发事件） | 脚本内 polyfill（Node 19+ 才内置 `CustomEvent`） |
| 原生 PostgreSQL | `shmget: Function not implemented` | 用 PGlite 顶替（见上） |
| workerd | `MmapAligned() failed` | 用 Node 房间服务器顶替（见上） |
| 项目放 sdcard | 符号链接/权限风险 | 运行副本放 `/root/castle-siege-of-ai`，源码存档在 `/sdcard/Download/castle-siege-of-ai` |

## 六、日常运维与常见问题

**进程被 Android 系统回收（最常见）**：proot 里的 Node 进程在后台待久了会被系统清掉，
表现是浏览器突然打不开、或注册/登录报 500。重新执行一次即可（脚本会跳过仍在跑的、只补缺的）：

```bash
cd /root/castle-siege-of-ai && npm run dev:local
```

`dev-local.sh` 现在会：① 检查 Redis，没跑就自动 `redis-server --daemonize yes`；
② 依次拉起 pglite / battle / next；③ 打印访问地址。

**健康自检三条命令**：

```bash
redis-cli ping                                                  # 期望 PONG
curl http://127.0.0.1:1999/parties/main/health                  # 期望 {"ok":true,...}
curl -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/login   # 期望 200
```

**排查用日志**：`/tmp/csai/{pglite,battle,next}.log`（`tail -f` 实时看）。

**已应用的保活措施**（2026-09-15，需 root/Shizuku，已执行一次即可长期有效）：

```sh
# 1) 加入 Doze 电池白名单（免被省电策略冻结）
cmd deviceidle whitelist +com.ai.assistance.operit
# 2) 后台运行与唤醒锁权限
cmd appops set com.ai.assistance.operit RUN_ANY_IN_BACKGROUND allow
cmd appops set com.ai.assistance.operit RUN_IN_BACKGROUND allow
# 3) 工作桶设为 active（降低被回收优先级）
am set-standby-bucket com.ai.assistance.operit active
# 4) 关键进程 oom_score_adj = -800（低内存杀手不再优先杀它们）
for P in $(ps -A -o PID,ARGS | grep -E 'redis-server|dev-pglite|dev-battle-server|next dev' | awk '{print $1}'); do
  echo -800 > /proc/$P/oom_score_adj
done
```

**注意**：`oom_score_adj` 在进程重启后会重置，如果又掉线，重新执行一遍 `npm run dev:local`
并让 AI（或你自己用 root shell）再跑一次第 4 条即可。
另外**不要把 Operit 从最近任务里划掉**（那是显式强杀，任何保活都挡不住）。

**屏幕/后台建议**：玩的时候把 Operit 留在后台（不要划掉），浏览器与它同设备互访才通。

---

## 七、回到「公网可访问」

本地跑通后要上线，按 `DEPLOY.md` 申请 4 个免费服务（Vercel / Cloudflare Workers / Neon 或 Supabase / Upstash）+ QQ SMTP，
把 `.env.local` 的变量填进对应平台的 Environment Variables 即可。**本地这套替换件（PGlite / Node 房间服务器）都不需要上线。**
