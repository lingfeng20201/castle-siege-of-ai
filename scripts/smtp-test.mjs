/**
 * /tmp/smtp-test.mjs —— 验证 QQ SMTP 配置能否真实发信
 * 读取 /root/castle-siege-of-ai/.env.local 的 QQ_SMTP_USER / QQ_SMTP_CODE
 */
import fs from 'node:fs';
import nodemailer from 'nodemailer';

const raw = fs.readFileSync('/root/castle-siege-of-ai/.env.local', 'utf8');
const env = Object.fromEntries(
  raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i), l.slice(i + 1)];
    }),
);

console.log('user =', env.QQ_SMTP_USER ? env.QQ_SMTP_USER : '(空)');
console.log('code 长度 =', (env.QQ_SMTP_CODE || '').length);

const t = nodemailer.createTransport({
  host: 'smtp.qq.com',
  port: 465,
  secure: true,
  auth: { user: env.QQ_SMTP_USER, pass: env.QQ_SMTP_CODE },
});

try {
  await t.verify();
  console.log('✔ SMTP 登录成功');
} catch (e) {
  console.log('✘ SMTP 登录失败:', e.message);
  process.exit(1);
}

try {
  const r = await t.sendMail({
    from: `"城堡围攻 · 指挥部" <${env.QQ_SMTP_USER}>`,
    to: '3795688539@qq.com',
    subject: '《AI攻防战：城堡围攻》SMTP 连通测试',
    html: '<div style="font-family:sans-serif"><h3>SMTP 已打通</h3><p>看到这封邮件说明 QQ 邮箱授权码配置正确，注册验证码可以真实发送了。</p><p style="color:#888;font-size:12px">测试码：<b>123456</b>（仅测试用）</p></div>',
  });
  console.log('✔ 邮件已发送:', r.messageId);
} catch (e) {
  console.log('✘ 发送失败:', e.message);
  process.exit(1);
}