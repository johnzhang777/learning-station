import { createHmac } from 'node:crypto';
import { readFile, writeFile, chmod } from 'node:fs/promises';
const config = JSON.parse(await readFile(new URL('../.private/account.json', import.meta.url), 'utf8'));
if (!/^[a-f0-9]{64}$/.test(config.SESSION_SECRET || '')) throw Error('Missing local account configuration');
const code = createHmac('sha256', Buffer.from(config.SESSION_SECRET, 'hex')).update('learning-station:feedback-admin-access:v1\n').digest('hex');
const target = new URL('../.private/feedback-developer-code.txt', import.meta.url);
await writeFile(target, '听听学堂 · 开发者管理码\n仅在留言板内验证开发者身份，不是学习账号的验证码。\n\n' + code + '\n', { mode:0o600 });
await chmod(target, 0o600).catch(()=>{});
console.log('Developer access code saved to ignored .private/feedback-developer-code.txt; no code or credential was printed.');
