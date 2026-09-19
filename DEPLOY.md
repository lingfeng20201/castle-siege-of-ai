# 《AI攻防战：城堡围攻》部署说明

> 目标：从零把项目跑起来并发布到公网。全程约 30-45 分钟。
> 架构：**Next.js 14（Vercel） + PartyKit（Cloudflare Workers） + Postgres + Redis + QQ 邮箱 SMTP**。

---

## 0. 架构总览

| 组件 | 职责 | 部署位置 |
|---|---|---|
| Next.js（`app/`） | 页面 + 全部 `/api/*`（注册登录、模型配置、用量统计、PartyKit 票据、内部桥接） | Vercel（或 Cloudflare） |
| PartyKit（`party/battle.ts`） | 每场对战 = 一个房间实例（回合流转、结算、AI 托管、结盟背叛） | Cloudflare Workers（`partykit deploy`） |
| Postgres | 用户 / 模型配置（加密）/ 用量 / 对局存档（`sql/schema.sql`） | Supabase / Neon |
| Redis | 验证码、限流、大厅心跳 | Upstash / Redis Cloud |
| QQ SMTP | 注册验证码邮件 | 无需部署（外部服务） |

关键链路：**PartyKit 房间服务器不直连数据库**，所有持久化经 `POST /api/internal/party` 完成，用 `INTERNAL_API_KEY` 做常量时间校验；浏览器连接房间的票据由 `GET /api/party-ticket`（15 分钟有效）签发。

---

## 1. 准备清单

- [ ] Node.js ≥ 18.17 与 npm
- [ ] Postgres 连接串（Neon / Supabase 免费档即可）
- [ ] Redis 连接串（Upstash 免费档即可，**需要 TLS `rediss://`**）
- [ ] QQ 邮箱 + SMTP 授权码（16 位，非登录密码，见第 6 节）
- [ ] GitHub / Vercel / Cloudflare 账号（PartyKit 依赖 Cloudflare）

---

## 2. 本地跑通（5 分钟）

```bash
git clone <你的仓库> && cd castle-siege-of-ai
npm install

cp .env.example .env.local     # 填入第 3 节中的变量
npm run db:migrate             # 等价于：psql "$DATABASE_URL" -f sql/schema.sql

# 终端 A：PartyKit 本地房间服务器（127.0.0.1:1999）
npm run party:dev

# 终端 B：Next.js（localhost:3000）
npm run dev
```

打开 <http://localhost:3000> → 注册（需先配好 QQ SMTP）→ 进入「模型配置」加一条 BYOK → 回大厅建房开战。

> 提示：未配置模型时也能建房/观战，但「AI 托管 / 指挥官决策」不会工作（房间内会保底出牌并提示）。

---

## 3. 环境变量（完整表）

| 变量 | 用途 | 生成方式 | 配在哪侧 |
|---|---|---|---|
| `DATABASE_URL` | Postgres 连接串（建议 `?sslmode=require`） | 服务商控制台复制 | Next |
| `REDIS_URL` | Redis 连接串（Upstash 用 `rediss://`） | 服务商控制台复制 | Next |
| `JWT_SECRET` | 会话 JWT + PartyKit 票据签名（≥32 字符随机串） | `openssl rand -hex 32` | **Next + PartyKit 双端一致** |
| `MODEL_ENC_KEY` | API Key 的 AES-256-GCM 密钥（必须 32 字节 Base64） | `openssl rand -base64 32` | Next |
| `CODE_PEPPER` | 验证码 HMAC 加盐（可选，默认回退 `JWT_SECRET`） | `openssl rand -hex 16` | Next（可选） |
| `ALLOW_LOCAL_MODEL_URL` | 是否允许内网模型地址（Ollama 等），默认 `false` | 保持 `false` 最安全 | Next |
| `DEFAULT_MODEL_BASE_URL`/`DEFAULT_MODEL_KEY`/`DEFAULT_MODEL_NAME` | **可选**系统兜底模型：仅当用户没有任何 BYOK 配置时启用（`DEFAULT_MODEL_KEY` 留空 = 关闭） | 自备 | Next |
| `QQ_SMTP_USER` | 发件邮箱（QQ/Foxmail） | - | Next |
| `QQ_SMTP_CODE` | SMTP 授权码（16 位） | QQ 邮箱设置页获取 | Next |
| `APP_URL` | Next 的公网地址，PartyKit 回调内部桥接用 | 部署后得到，如 `https://xxx.vercel.app` | **PartyKit** |
| `INTERNAL_API_KEY` | Next ↔ PartyKit 内部桥接密钥 | `openssl rand -hex 32` | **双端一致** |
| `NEXT_PUBLIC_PARTYKIT_HOST` | 浏览器连接 PartyKit 的 host（**不含协议**，如 `castle-siege.你的用户名.partykit.dev`；本地 `127.0.0.1:1999`） | 部署输出 | Next（构建时必须可读） |
| `NEXT_PUBLIC_PARTYKIT_PARTY` | Party 名，默认 `main`，一般不用改 | - | Next |

> 安全提醒：`MODEL_ENC_KEY` 一旦更换，已存的所有 API Key 将无法解密（需重新录入）；`JWT_SECRET` / `INTERNAL_API_KEY` 更换会导致旧会话/桥接失效，请同时更新两端。

---

## 4. 数据库初始化（Neon / Supabase）

**Neon**：控制台 → SQL Editor → 粘贴 `sql/schema.sql` 全部内容 → Run。
**Supabase**：控制台 → SQL Editor → 同样粘贴执行。
**本地/自建**：

```bash
npm run db:migrate
```

验证：应存在 5 张表（`users`、`email_codes`、`model_providers`、`model_usage`、`matches`）与索引 `uniq_default_per_user`。
`schema.sql` 默认启用 `pgcrypto`（`gen_random_uuid()` 依赖）。

---

## 5. Redis（推荐 Upstash）

1. 新建 Redis 数据库 → 复制 **TLS** 连接串（以 `rediss://` 开头）。
2. 写入 `REDIS_URL`。
3. 说明：代码用到 `rl:*`（限流）、`ecode:*`（验证码，TTL 300s）、`elock:*`（15 分钟锁定）、`csai:lobby`（大厅心跳，TTL 600s）。Upstash 免费档完全够用。

---

## 6. QQ 邮箱 SMTP 配置

1. 登录 QQ 邮箱 → **设置 → 账号** → 「POP3/IMAP/SMTP 服务」。
2. 开启 **SMTP 服务** → 按提示验证密保手机 → 得到 **16 位授权码**。
3. 填入：

```env
QQ_SMTP_USER=你的QQ号@qq.com
QQ_SMTP_CODE=16位授权码
```

代码已内置 `smtp.qq.com:465 (SSL)`，无需再配端口。

**海外节点被限时**（QQ SMTP 有风控/IP 限制，Cloudflare/Vercel 海外节点可能 452 拒发），可仅替换 `app/api/auth/send-code/route.ts` 中的 transporter 为 Resend / SendGrid：

```ts
// 例：Resend 的 SMTP 桥（其余代码不动）
mailer = nodemailer.createTransport({
  host: 'smtp.resend.com',
  port: 465,
  secure: true,
  auth: { user: 'resend', pass: process.env.RESEND_API_KEY },
});
```

---

## 7. 部署 PartyKit（Cloudflare Workers）

```bash
npx partykit login          # 打开浏览器授权 Cloudflare
npx partykit deploy         # 项目名取 partykit.json 的 "castle-siege"

# 输出形如：https://castle-siege.<你的用户名>.partykit.dev
```

为房间服务器配置 3 个变量（**与 Next 端一致/对应**）：

```bash
npx partykit env add JWT_SECRET          # 与 Next 端同一个值
npx partykit env add APP_URL             # 填 Next 部署域名，如 https://xxx.vercel.app
npx partykit env add INTERNAL_API_KEY    # 与 Next 端同一个值
npx partykit env list                    # 复查
```

> 也可在 Cloudflare Dashboard → Workers & Pages → `castle-siege` → Settings → Variables 中配置。
> 本地开发不需要这些（`.env.local` 会通过 PartyKit 的本地运行时注入；读取顺序：Room vars → process.env）。

---

## 8. 部署 Next.js（Vercel）

1. Vercel → **Add New Project** → 导入 Git 仓库（框架自动识别 Next.js）。
2. **Environment Variables**：把第 3 节「Next 侧」的全部变量填进去（注意 `NEXT_PUBLIC_PARTYKIT_HOST` 要在构建前设置好）：

```env
NEXT_PUBLIC_PARTYKIT_HOST=castle-siege.<你的用户名>.partykit.dev
NEXT_PUBLIC_PARTYKIT_PARTY=main
APP_URL=https://<你的项目>.vercel.app
```

3. Deploy → 部署完成后把真实域名回填 `APP_URL`（Vercel 与 PartyKit **两侧都要更新**），并重新部署一次使环境变量生效。
4. 首次自检见第 9 节。

> 想把 Next 也放到 Cloudflare？可用 `@opennextjs/cloudflare` 适配，但注意 `argon2`（原生模块）、`pg`、`ioredis`、`nodemailer` 需要 Node 兼容运行时（`nodejs_compat`）。**建议 Next 用 Vercel、PartyKit 用 Cloudflare**，这是踩坑最少的组合。

---

## 9. 上线自检清单

- [ ] `/register` 能收到验证码邮件（检查垃圾箱；连点会触发 60s 冷却/小时限流——属正常防护）
- [ ] 注册成功出现「骑士加冕」动画并进入大厅
- [ ] `/settings/models` 能新增配置；点「测试」返回「连接成功 · 延迟 xx ms」
- [ ] 开两个浏览器（或隐身窗口）登录两个账号：A 建房 → B 看见房间 → 加入 → 全员「准备」→ 房主「开始」
- [ ] 回合内开启「AI 托管」，日志出现指挥官的出牌理由；超时/掉线自动保底
- [ ] `/settings/usage` 出现调用记录；「导出 CSV」用 Excel 打开中文不乱码
- [ ] 一局打完：战报弹窗、`matches` 表有存档、Telemetry 卡片显示本场消耗

---

## 10. 常见问题（FAQ）

| 现象 | 排查 |
|---|---|
| 连接房间一直「重连中」 | 1) `NEXT_PUBLIC_PARTYKIT_HOST` 是否**不带协议**（写 `xxx.partykit.dev` 即可，代码自动选 `wss://`） 2) 页面是 https 而 host 写错域名 3) `npx partykit tail` 看房间日志 |
| 401 / 「票据无效」 | `JWT_SECRET` 两端不一致（PartyKit env vs Vercel env）；票据 15 分钟过期，刷新页面会自动重取 |
| 房间 AI 决策不工作，提示「指挥官失联」 | 该玩家未配置模型且未开启系统兜底；或模型 Base URL 被 SSRF 拦截；或 Key 失效（到「模型配置」重测） |
| 内部桥接 403 | `INTERNAL_API_KEY` 两端不一致或 PartyKit 侧未配置 |
| Postgres 连接报 SSL 错 | 连接串加 `?sslmode=require`（Neon 默认需要 SSL） |
| Redis 连接超时 | Upstash 必须用 `rediss://`（TLS） |
| Vercel 构建报 `argon2` 相关错误 | 本地正常、CI 报错时检查 Node 版本 ≥ 18.17；Vercel 需选 Node Serverless 运行时（默认即是） |
| 邮件发送 502 `SMTP_FAILED` | 授权码错误 / 未开 SMTP / 海外节点被 QQ 风控（换 Resend，见第 6 节） |
| 大厅看不到房间 | 大厅靠 PartyKit 心跳写 Redis（`csai:lobby`）；确认房间实例仍在（空房约 90s 后从前端列表剔除属正常） |

---

## 11. 安全清单（公开上线前过一遍）

- [ ] 所有密钥均为随机强值，`.env.local` 未提交（`.gitignore` 已含）
- [ ] `ALLOW_LOCAL_MODEL_URL=false`
- [ ] 确认限流生效：发码 60s/1h≤5、注册错 5 次锁 15 分钟、登录 IP 15min≤30
- [ ] `DEFAULT_MODEL_KEY` 若开启系统兜底，理解其会消耗部署者额度（面向小范围演示使用）
- [ ] 定期轮换 `INTERNAL_API_KEY`；轮换 `MODEL_ENC_KEY` 前先通知用户重新录入 Key
- [ ] 生产环境确认无示例账号、无调试后门

---

## 12. 常用命令速查

```bash
npm run dev          # 本地 Next.js
npm run party:dev    # 本地 PartyKit（127.0.0.1:1999）
npm run party:deploy # 部署 PartyKit 到 Cloudflare
npm run db:migrate   # 执行 sql/schema.sql
npm run build        # 生产构建（Vercel 会自动执行）
npx partykit tail    # 查看线上房间日志（排障神器）
npx partykit env list
```

---

## 附：安全边界声明（保留于所有部署）

本项目所有「攻击牌」均为安全概念的**抽象化、游戏化、教育化标签**（如「洪水术≈DDoS」「毒箭≈注入」仅作概念对标），胜负只在游戏数值层面结算，**不包含任何可执行攻击代码、真实漏洞利用步骤、恶意软件或绕过安全控制的细节**。请勿将游戏内文案用于任何真实攻击场景。
