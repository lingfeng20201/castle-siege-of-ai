#!/usr/bin/env node
/**
 * scripts/push-to-github.mjs —— 用 GitHub REST API 把当前目录推送到仓库
 * （本机没有 git 命令，且 Android proot 里装 git 成本高，故走 API）
 *
 * 用法：
 *   GH_TOKEN=ghp_xxx node scripts/push-to-github.mjs                # 私有仓库 castle-siege-of-ai
 *   GH_TOKEN=ghp_xxx GH_REPO=my-repo GH_PRIVATE=false node scripts/push-to-github.mjs
 *
 * 需要的 PAT 权限（classic）：repo（完整控制私有仓库）
 * 流程：确保仓库存在 → 上传全部文件为 blob → 建 tree → 建 commit → 更新 ref(main)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'https://api.github.com';
const TOKEN = process.env.GH_TOKEN;
const REPO_NAME = process.env.GH_REPO || 'castle-siege-of-ai';
const PRIVATE = (process.env.GH_PRIVATE || 'true') !== 'false';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (!TOKEN) {
  console.error('缺少 GH_TOKEN（GitHub Personal Access Token）');
  process.exit(1);
}

const HEADERS = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'castle-siege-deployer',
  'X-GitHub-Api-Version': '2022-11-28',
};

async function gh(method, apiPath, body, attempt = 1) {
  let res;
  try {
    res = await fetch(`${API}${apiPath}`, {
      method,
      headers: { ...HEADERS, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    if (attempt < 4) {
      console.log(`[push] ↻ 网络抖动（${e.cause?.code || e.message}），第 ${attempt} 次重试 ${method} ${apiPath}`);
      await new Promise((r) => setTimeout(r, 700 * attempt));
      return gh(method, apiPath, body, attempt + 1);
    }
    throw e;
  }
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    if (res.status >= 500 && attempt < 4) {
      console.log(`[push] ↻ 服务端 ${res.status}，重试 ${method} ${apiPath}`);
      await new Promise((r) => setTimeout(r, 700 * attempt));
      return gh(method, apiPath, body, attempt + 1);
    }
    const err = new Error(`${method} ${apiPath} → ${res.status}: ${json?.message || text?.slice(0, 200)}`);
    err.status = res.status;
    err.payload = json;
    throw err;
  }
  return json;
}

/* ───────── 1. 排除规则：与部署无关的文件不上传 ───────── */
const EXCLUDE_DIRS = new Set(['node_modules', '.next', '.git', '.cache', 'dist', 'out']);
const EXCLUDE_FILES = new Set([
  '.env.local',
  '.env.prod',
  '.env.local.bak',
  'tsconfig.tsbuildinfo',
  '.DS_Store',
  'package-lock.json.bak',
  'dump.rdb',
  'appendonly.aof',
]);
const EXCLUDE_PATTERNS = [/\.log$/, /\.tmp$/, /~$/, /^\.env\.local\./];

function walk(dir, out = [], rel = '') {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const r = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      walk(abs, out, r);
    } else if (entry.isFile()) {
      if (EXCLUDE_FILES.has(entry.name) || EXCLUDE_PATTERNS.some((p) => p.test(entry.name))) continue;
      out.push({ abs, rel: r });
    }
  }
  return out;
}

/* ───────── 2. 主流程 ───────── */
const me = await gh('GET', '/user');
console.log(`[push] 已认证：${me.login}`);

let repo;
try {
  repo = await gh('GET', `/repos/${me.login}/${REPO_NAME}`);
  console.log(`[push] 仓库已存在：${repo.full_name}（默认分支 ${repo.default_branch}）`);
} catch (e) {
  if (e.status !== 404) throw e;
  try {
    repo = await gh('POST', '/user/repos', {
      name: REPO_NAME,
      private: PRIVATE,
      description: '《AI攻防战：城堡围攻》— 联机版（Next.js + Node 房间服务器）',
      has_issues: true,
      has_wiki: false,
      auto_init: false,
    });
    console.log(`[push] 已创建仓库：${repo.full_name}（${PRIVATE ? '私有' : '公开'}）`);
  } catch (ce) {
    if (ce.status === 403 || /not accessible|not permitted/i.test(String(ce.message ?? ''))) {
      console.error(
        `[push] ❌ 当前令牌无权创建仓库。\n` +
          `[push]    请用浏览器打开 https://github.com/new\n` +
          `[push]    Repository name 填 ${REPO_NAME}，选 Public，不要勾选 README / .gitignore\n` +
          `[push]    点 Create repository 后重新运行本脚本即可（脚本会自动跳过创建、直接推送）。`,
      );
      process.exit(3);
    }
    throw ce;
  }
}

const branch = repo.default_branch || 'main';
const files = walk(ROOT);
console.log(`[push] 待上传文件：${files.length} 个`);

/* 先取现有 HEAD 作为父提交 */
let parents = [];
try {
  const ref = await gh('GET', `/repos/${me.login}/${REPO_NAME}/git/ref/heads/${branch}`);
  parents = [ref.object.sha];
  console.log(`[push] 现有 ${branch} 头指针：${ref.object.sha.slice(0, 7)}`);
} catch (e) {
  if (e.status !== 404 && e.status !== 409) throw e;
  console.log(`[push] ${branch} 尚不存在（空仓库）→ 用 Contents API 初始化第一个提交…`);
  await gh('PUT', `/repos/${me.login}/${REPO_NAME}/contents/README.md`, {
    message: 'chore: initialize repository',
    content: Buffer.from(
      '# castle-siege-of-ai\n\n《AI攻防战：城堡围攻》联机版\n',
    ).toString('base64'),
  });
  const ref = await gh('GET', `/repos/${me.login}/${REPO_NAME}/git/ref/heads/${branch}`);
  parents = [ref.object.sha];
  console.log(`[push] 初始化完成，基点 ${ref.object.sha.slice(0, 7)}`);
}

/* 并发上传 blob */
const CONCURRENCY = 3;
const tree = [];
let idx = 0;
let done = 0;
async function worker() {
  while (idx < files.length) {
    const i = idx++;
    const f = files[i];
    const content = fs.readFileSync(f.abs);
    const blob = await gh('POST', `/repos/${me.login}/${REPO_NAME}/git/blobs`, {
      content: content.toString('base64'),
      encoding: 'base64',
    });
    tree.push({ path: f.rel, mode: '100644', type: 'blob', sha: blob.sha });
    done += 1;
    if (done % 15 === 0 || done === files.length) console.log(`[push]   已上传 ${done}/${files.length}`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

/* 建 tree → commit → 更新 ref */
const newTree = await gh('POST', `/repos/${me.login}/${REPO_NAME}/git/trees`, { tree });
const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16);
const commit = await gh('POST', `/repos/${me.login}/${REPO_NAME}/git/commits`, {
  message: `deploy: ${stamp} 云端部署版（Next.js + Node 房间服务器 + 远程建表脚本）`,
  tree: newTree.sha,
  parents,
});

if (parents.length === 0) {
  await gh('POST', `/repos/${me.login}/${REPO_NAME}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha });
} else {
  await gh('PATCH', `/repos/${me.login}/${REPO_NAME}/git/refs/heads/${branch}`, { sha: commit.sha, force: true });
}

console.log(`[push] ✅ 完成：https://github.com/${me.login}/${REPO_NAME}/tree/${branch}`);
console.log(`[push] 提交：${commit.sha.slice(0, 7)} · 文件：${files.length}`);
console.log(`[push] 仓库地址（Render 部署时选择它）：https://github.com/${me.login}/${REPO_NAME}`);