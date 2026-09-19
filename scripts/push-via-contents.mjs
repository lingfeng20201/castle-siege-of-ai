#!/usr/bin/env node
/**
 * scripts/push-via-contents.mjs —— 用 Contents API 逐文件上传
 *
 * 为什么需要它：细粒度 PAT（github_pat_…）不支持 Git Data API 的
 * tree / commit / refs 端点（会 403 Resource not accessible），
 * 但 Contents API（PUT /contents/{path}）可用。
 *
 * 用法：GH_TOKEN=xxx node scripts/push-via-contents.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const API = 'https://api.github.com';
const TOKEN = process.env.GH_TOKEN;
const REPO_NAME = process.env.GH_REPO || 'castle-siege-of-ai';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (!TOKEN) {
  console.error('缺少 GH_TOKEN');
  process.exit(1);
}

const HEADERS = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'castle-siege-contents-pusher',
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
      console.log(`  ↻ 网络抖动（${e.cause?.code || e.message}），重试 ${attempt} …`);
      await new Promise((r) => setTimeout(r, 800 * attempt));
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
      await new Promise((r) => setTimeout(r, 800 * attempt));
      return gh(method, apiPath, body, attempt + 1);
    }
    const err = new Error(`${method} ${apiPath} → ${res.status}: ${json?.message || text?.slice(0, 200)}`);
    err.status = res.status;
    err.payload = json;
    throw err;
  }
  return json;
}

/* ───── 排除规则（与 push-to-github.mjs 保持一致） ───── */
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

/* ───── 主流程 ───── */
const me = await gh('GET', '/user');
console.log(`[contents] 认证：${me.login} → ${me.login}/${REPO_NAME}`);

try {
  const repo = await gh('GET', `/repos/${me.login}/${REPO_NAME}`);
  console.log(`[contents] 仓库：${repo.full_name}（${repo.private ? '私有' : '公开'}，分支 ${repo.default_branch}）`);
} catch (e) {
  console.error(`[contents] ❌ 仓库不存在或无权访问：${e.message}`);
  process.exit(2);
}

/* 清理占位文件 */
try {
  const t = await gh('GET', `/repos/${me.login}/${REPO_NAME}/contents/__perm_test.txt`);
  if (t?.sha) {
    await gh('DELETE', `/repos/${me.login}/${REPO_NAME}/contents/__perm_test.txt`, {
      message: 'chore: remove temp file',
      sha: t.sha,
    });
    console.log('[contents] 已删除占位文件 __perm_test.txt');
  }
} catch {
  /* 不存在就算了 */
}

const files = walk(ROOT);
console.log(`[contents] 待上传：${files.length} 个文件\n`);

let done = 0;
let skipped = 0;
const failed = [];

/** 本地文件的 git blob 哈希（可直接与 GitHub Contents API 返回的 sha 对比） */
function gitBlobSha(buf) {
  return createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

async function putFile({ abs, rel }) {
  const buf = fs.readFileSync(abs);
  const localSha = gitBlobSha(buf);
  const b64 = buf.toString('base64');
  const apiPath = `/repos/${me.login}/${REPO_NAME}/contents/${rel
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;

  for (let attempt = 1; attempt <= 5; attempt++) {
    /* 先看远端是否已有一模一样的文件 */
    let remote = null;
    try {
      remote = await gh('GET', apiPath);
    } catch (e) {
      if (e.status !== 404) console.log(`  ? 读取 ${rel} 状态失败：${e.message.slice(0, 90)}`);
      remote = null;
    }
    if (remote && remote.sha === localSha) {
      skipped++;
      return;
    }
    try {
      const body = { message: `chore: sync ${rel}`, content: b64 };
      if (remote?.sha) body.sha = remote.sha;
      await gh('PUT', apiPath, body);
      done++;
      if ((done + skipped) % 10 === 0 || done + skipped === files.length) {
        console.log(`[contents] 进度 ${done + skipped}/${files.length}（写入 ${done}，跳过 ${skipped}）`);
      }
      return;
    } catch (e) {
      if ((e.status === 409 || e.status === 422) && attempt < 5) {
        await new Promise((r) => setTimeout(r, 500 * attempt));
        continue;
      }
      failed.push(`${rel}: ${e.message.slice(0, 160)}`);
      console.log(`  ✗ ${rel} → ${e.message.slice(0, 120)}`);
      return;
    }
  }
}

/* 串行上传：Contents API 对同一分支的并发写会 409 */
for (const f of files) {
  await putFile(f);
}

console.log(`\n[contents] 完成：成功 ${done}/${files.length}，失败 ${failed.length}`);
if (failed.length) {
  console.log('失败清单：');
  for (const f of failed) console.log('  -', f);
  process.exit(1);
}
console.log('PUSH_OK');
