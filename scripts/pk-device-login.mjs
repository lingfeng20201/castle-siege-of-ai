#!/usr/bin/env node
/**
 * 手工完成 PartyKit 的 GitHub 设备码登录（绕开 partykit CLI 里 undici 卡住的问题）
 *
 * 用法：
 *   node scripts/pk-device-login.mjs <device_code> [interval秒]
 *
 * 成功后会写入 ~/.partykit/config.json（type=github），之后 partykit deploy 就能直接跑。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CLIENT_ID = '670a9f76d6be706f5209'; // PartyKit 官方 GitHub App
const deviceCode = process.argv[2];
if (!deviceCode) {
  console.error('用法: node scripts/pk-device-login.mjs <device_code> [interval秒]');
  process.exit(1);
}
const intervalMs = Number(process.argv[3] || 5) * 1000;
const deadline = Date.now() + 900_000;
const ts = () => new Date().toISOString().slice(11, 19);
let round = 0;

while (Date.now() < deadline) {
  round += 1;
  try {
    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });
    const data = await res.json();

    if (data.access_token) {
      const uRes = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${data.access_token}`, 'User-Agent': 'partykit/0.0.111' },
      });
      const u = await uRes.json();
      const dir = path.join(os.homedir(), '.partykit');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'config.json'),
        JSON.stringify({ type: 'github', access_token: data.access_token, login: u.login }, null, 2),
      );
      console.log(`[${ts()}] LOGIN_OK github用户=${u.login} 凭证已写入 ~/.partykit/config.json`);
      process.exit(0);
    }

    if (data.error === 'authorization_pending') {
      if (round % 6 === 1) console.log(`[${ts()}] 等待你在浏览器里授权…（第${round}次轮询）`);
    } else if (data.error === 'slow_down') {
      console.log(`[${ts()}] slow_down，放慢轮询`);
    } else {
      console.log(`[${ts()}] 异常返回: ${JSON.stringify(data)}`);
    }
  } catch (e) {
    console.log(`[${ts()}] 网络错误: ${e.message}`);
  }
  await new Promise((r) => setTimeout(r, intervalMs));
}
console.log('TIMEOUT 设备码已过期，需要重新发起');
process.exit(2);
