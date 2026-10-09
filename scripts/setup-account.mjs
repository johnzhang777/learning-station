import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { passwordHash } from '../server/learning-api.js';
// Hidden JSON input also allows an authorized assistant to configure the account
// without credentials appearing in shell arguments, logs, or tracked files.
console.log('Ready for account JSON on stdin (input is hidden).');
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
  if (/[\r\n]/.test(input)) break;
}
if (process.stdin.isTTY) process.stdin.setRawMode(false);
try {
  const { username, password } = JSON.parse(input.trim());
  if (!/^[a-z]{2,40}$/.test(username) || typeof password !== 'string' || password.length < 6 || password.length > 128) throw Error();
  const salt = randomBytes(16).toString('hex');
  const env = { ACCOUNT_USERNAME: username, ACCOUNT_PASSWORD_SALT: salt, ACCOUNT_PASSWORD_HASH: await passwordHash(password, salt), SESSION_SECRET: randomBytes(32).toString('hex') };
  await mkdir(new URL('../.private/', import.meta.url), { recursive: true });
  await writeFile(new URL('../.private/account.json', import.meta.url), JSON.stringify(env, null, 2) + '\n', { mode: 0o600 });
  await writeFile(new URL('../.private/edgeone.env', import.meta.url), Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { mode: 0o600 });
  console.log('Account verifier and session key saved in ignored .private/; plaintext password was not saved.');
} catch { console.error('Account setup failed. Check the input format.'); process.exitCode = 1; }
process.stdin.destroy();
