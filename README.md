# 《AI攻防战：城堡围攻》（Castle Siege of AI）

线上多人策略对抗游戏：每位玩家拥有一座中世纪风格「数据城堡」，注册后自带大模型（BYOK），
模型作为指挥官替你思考每回合出牌；通过抽取、打出「攻击牌/防御牌」削弱并摧毁对手城堡，
最后一座屹立的城堡获胜。

> ⚠️ **安全边界（全部实现均遵守）**
> 攻防内容全部为抽象化、游戏化、教育化、演练化标签；胜负只在游戏数值层面结算；
> 项目不包含任何可执行攻击代码、真实漏洞利用步骤、恶意软件、钓鱼模板或绕过安全控制的细节。

---

## 技术栈

| 层 | 选型 |
|---|---|
| 前端 | Next.js 14 (App Router) + TypeScript + Tailwind + PixiJS + ECharts + Framer Motion |
| 实时 | PartyKit（每场战斗 = 一个 Party 实例） |
| 状态 | 服务端权威，客户端只发意图 |
| 持久化 | Postgres（Supabase / Neon）+ Redis |
| 鉴权 | JWT（httpOnly Cookie）+ argon2id |
| 邮件 | Nodemailer + QQ 邮箱 SMTP |
| 部署 | Cloudflare Workers / Vercel |

## 目录结构

```text
castle-siege-of-ai/
├── package.json / tsconfig.json / next.config.mjs / tailwind.config.ts
├── postcss.config.mjs / partykit.json / .env.example / .gitignore
├── sql/
│   └── schema.sql                     # ② 数据库 Schema
├── lib/
│   ├── cards.ts                       # ③ 全部攻击/防御牌定义
│   ├── castle.ts                      # ④ 城堡结构 + 状态类型
│   ├── protocol.ts                    # ⑤ 事件协议（PartyKit）
│   ├── crypto.ts                      # ⑥ AES-256-GCM 加密
│   ├── auth.ts                        # ⑥ JWT + argon2id + 校验
│   ├── logger.ts                      # ⑥ 日志（密钥过滤）
│   ├── db.ts / redis.ts / ssrf.ts     # ⑥ 支撑：Postgres / Redis / SSRF 防护
│   ├── pricing.ts / providers.ts      # ⑥ 支撑：单价表 / 供应商预设
│   ├── llm.ts                         # ⑦ 模型调用 + 用量记录 + 指挥官解析
│   ├── llm-core.ts                    # ⑦+ 纯函数核心（零 Node 依赖，PartyKit 复用）
│   ├── client/ui.ts / socket.ts       # ⑭+ 客户端共享工具 / WebSocket hook
│   └── engine.ts                      # ⑧ 结算引擎（纯函数）
├── app/
│   ├── api/
│   │   ├── auth/send-code/route.ts    # ⑨ 发送验证码
│   │   ├── auth/register/route.ts     # ⑩ 注册
│   │   ├── auth/login/route.ts        # ⑩+ 登录（补充，UI 需要）
│   │   ├── auth/logout/route.ts       # ⑩+ 登出（补充）
│   │   ├── models/route.ts            # ⑪ 模型配置 列表/新增
│   │   ├── models/[id]/route.ts       # ⑪ 模型配置 详情/更新/删除
│   │   ├── models/test/route.ts       # ⑪ 测试连接（并回传「实际模型」）
│   │   ├── models/list/route.ts       # 新增：读取供应商可用模型/版本（GET /models）
│   │   ├── usage/route.ts             # ⑫ 用量统计（含 CSV 导出 / 一键清空）
│   │   ├── party-ticket/route.ts      # ⑬+ PartyKit 连接票据（15 分钟）
│   │   ├── internal/party/route.ts    # ⑬+ 内部桥接（provider.get / usage.add / match.save / lobby.*）
│   │   └── lobby/route.ts             # ⑭+ 大厅房间列表（Redis 心跳）
│   ├── globals.css / layout.tsx       # ⑭+ 全局样式与根布局
│   ├── page.tsx                       # ⑭ 大厅（服务端守卫 + LobbyBoard）
│   ├── room/[roomId]/page.tsx         # ⑮ 对战房间
│   ├── register/page.tsx              # ㉒ 注册
│   ├── login/page.tsx                 # ㉒ 登录
│   └── settings/                      # ㉓㉔ 设置中心（layout 服务端守卫）
│       ├── models/page.tsx            # ㉓ 模型配置中心
│       └── usage/page.tsx             # ㉔ 用量统计
├── party/battle.ts                    # ⑬ PartyKit 房间逻辑
├── components/                        # ⑯-㉑ ㉕㉖
│   ├── Battlefield.tsx / HandCards.tsx / CastleStatus.tsx
│   ├── BattleLog.tsx / AlliancePanel.tsx / ReportModal.tsx / LobbyBoard.tsx
│   └── settings/                      # ㉕㉖
│       ├── ProviderDrawer.tsx / ProviderCard.tsx
│       └── JsonEditor.tsx / UsageChart.tsx
└── DEPLOY.md                          # ㉗ 部署说明（Vercel + PartyKit + QQ SMTP）
└── LOCAL_DEV.md                       # 本地运行指南（Android proot 方案与踩坑）
└── scripts/                           # 本地开发辅助（仅本地使用，不影响线上部署）
    ├── dev-pglite.mjs                 #   WASM Postgres + TCP 桥（替代原生 PostgreSQL）
    ├── dev-battle-server.mjs          #   Node 版同协议房间服务器（替代 workerd）
    ├── dev-local.sh / dev-stop.sh     #   一键启停
    ├── dev-party.sh                   #   标准 PartyKit 启动（注入 .env.local）
    ├── smoke-local.mjs                #   全链路冒烟自检
    └── check-coop-turn-cap.mjs        #   coop 40 回合上限回归（手动跑，约 1–2 分钟）
```

## 快速开始

```bash
# 1. 依赖安装
npm install

# 2. 环境变量
cp .env.example .env.local
# 填写 DATABASE_URL / REDIS_URL / JWT_SECRET / MODEL_ENC_KEY / QQ_SMTP_*

# 3. 数据库建表
psql "$DATABASE_URL" -f sql/schema.sql
# 生成 MODEL_ENC_KEY：openssl rand -base64 32

# 4. 开发（两个终端）
npm run party:dev     # PartyKit 实时服务器（127.0.0.1:1999）
npm run dev           # Next.js（http://localhost:3000）
```

### 在手机上本地跑（Android proot Ubuntu）

受限环境（proot 不支持 `shmget`、workerd 的大块 mmap 被拒）下已备好等价替换件，一条命令启动：

```bash
redis-server --daemonize yes   # 缓存（仅首次）
npm run dev:local              # 数据库(PGlite) + 房间服务器(Node) + Next.js
npm run smoke                  # 全链路自检：注册 → 取票 → 连房间 → 大厅
npm run dev:stop               # 停止
```

浏览器打开 **http://127.0.0.1:3000**。单人试玩请建房时选 `coop` 模式（1 人即可开局）。
细节、踩坑与原理见 **[`LOCAL_DEV.md`](./LOCAL_DEV.md)**。
> 替换件（`scripts/dev-pglite.mjs` / `scripts/dev-battle-server.mjs`）**仅用于本地**，
> 线上部署仍是标准 PostgreSQL + `npm run party:deploy`。

## 修复记录

| 日期 | 问题 | 处理 |
|---|---|---|
| 本轮 | 对战页战场在大片空白、城堡挤在中间且互相压住 | `app/room/[roomId]/page.tsx` 小屏给战场确定高度（`h-[46vh]`）；`components/Battlefield.tsx` 重写 `computeLayout()`：1–2 座沿长边铺开、3–4 座按可用空间椭圆环绕、5–6 座两行网格，并以「两城堡半径 + 间距」为最小间距约束；中心徽记按剩余空间自适应缩放，避免压住城堡 |
| 本轮 | 配置模型时读不到模型/版本 | 新增 `lib/llm-core.ts` 的 `listModels()` 与 `POST /api/models/list`，设置页抽屉加「读取列表」按钮（可过滤、点选即填入）；`/api/models/test` 现会回传供应商响应里的 `servedModel`（实际版本）并显示在成功提示中 |
| 本轮 | `coop` 模式回合数超过上限（如 T42/40）仍在继续 | `party/battle.ts` 的 coop 分支此前完全跳过 `checkVictory`，40 回合封顶失效；现按 `castlePower`（主堡+外墙+内墙）总耐久判定联军是否攻破，平局守方（无名之堡）获胜 |

## 输出批次进度（对应需求文档《输出顺序》）

| # | 内容 | 状态 |
|---|---|---|
| 1-2 | 目录结构 + 依赖安装 + `sql/schema.sql` | ✅ 已生成 |
| 3-5 | `cards.ts` / `castle.ts` / `protocol.ts` | ✅ 已生成 |
| 6 | `crypto.ts` + `auth.ts` + `logger.ts`（含 db/redis/ssrf/pricing/providers 支撑） | ✅ 已生成 |
| 7 | `llm.ts`（模型调用 + 用量记录） | ✅ 已生成 |
| 8 | `engine.ts`（结算引擎） | ✅ 已生成 |
| 9-10 | `send-code` / `register`（含 login/logout 补充） | ✅ 已生成 |
| 11 | `models` 三个路由 | ✅ 已生成 |
| 12 | `usage/route.ts`（用量统计 + CSV 导出 + 一键清空） | ✅ 已生成 |
| 13 | `party/battle.ts`（PartyKit 房间逻辑，1168 行） | ✅ 已生成 |
| 14-15 | `app/page.tsx` 大厅 + `app/room/[roomId]/page.tsx` 对战房间 | ✅ 已生成 |
| 16-21 | Battlefield / HandCards / CastleStatus / BattleLog / AlliancePanel / ReportModal | ✅ 已生成 |
| 22 | `register/page.tsx` + `login/page.tsx`（60s 倒计时、6 位分格验证码、加冕动画） | ✅ 已生成 |
| 23-24 | `settings/models`（模型配置中心） + `settings/usage`（用量统计） | ✅ 已生成 |
| 25-26 | ProviderDrawer + ProviderCard + JsonEditor + UsageChart | ✅ 已生成 |
| 27 | 部署说明 → 见 [`DEPLOY.md`](./DEPLOY.md) | ✅ 已生成 |

> **全部 27 项已交付完成。** 部署请从 [`DEPLOY.md`](./DEPLOY.md) 开始；本地开发见上一节「快速开始」。

### 为可运行性补充的基础设施（需求文档未单列）
- `lib/llm-core.ts`：零 Node 依赖的模型调用核心，供 PartyKit（Workers 环境）复用
- `app/api/party-ticket`、`app/api/internal/party`、`app/api/lobby`：连接票据 / 内部桥接 / 大厅心跳
- `app/globals.css`、`app/layout.tsx`、`lib/client/ui.ts`、`lib/client/socket.ts`：全局样式、根布局、客户端工具与 WebSocket hook
- `components/LobbyBoard.tsx`、`app/settings/layout.tsx`：大厅客户端主体、设置中心服务端会话守卫

## 安全设计速览

- 验证码：HMAC-SHA256 哈希存 Redis（TTL 300s）+ 双写 DB 兜底；错误 5 次作废、邮箱 15 分钟锁定
- 限流：同邮箱 60s 1 次、每小时 ≤5；同 IP 每小时 ≤10；Redis 计数，超限 429
- 密码：argon2id，绝不明文/写日志；邮箱枚举防护（注册失败统一模糊提示）
- API Key：AES-256-GCM 加密（独立随机 IV），前端永远拿不到明文，回显 `sk-****3f9a`
- SSRF：Base URL 禁止 10./172.16-31./192.168./127./169.254. 等内网地址（可开关）
- CSRF：基于 Origin / Sec-Fetch-Site 的同源校验 + 全接口 JWT 校验