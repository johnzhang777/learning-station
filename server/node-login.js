import { createHmac, timingSafeEqual as loginTimingSafeEqual } from 'node:crypto';
import { verifyCredentials } from './node-password-verifier.js';

const LOGIN_LIMIT = 2048;
const loginEncoder = new TextEncoder();
const loginUuid = /^[a-f0-9]{32}$/;
const loginHeaders = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'private, no-store',
  Vary: 'Origin',
  'X-Content-Type-Options': 'nosniff'
};
const loginJson = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: loginHeaders });
const loginPublicFailure = Symbol('loginPublicFailure');
const loginReject = (message, status) => { throw Object.assign(new Error(message), { status, [loginPublicFailure]: true }); };
const loginFailure = code => { throw Object.assign(new Error('Login unavailable'), { code }); };
const loginCodes = new Set(['NODE_LOGIN_CONFIG', 'NODE_LOGIN_PASSWORD', 'NODE_LOGIN_INTERNAL']);
const loginEqual = (a, b) => a.byteLength === b.byteLength && loginTimingSafeEqual(a, b);

function validateLoginConfig(env) {
  if (!/^[a-z]{2,40}$/.test(env?.ACCOUNT_USERNAME || '') || !/^[a-f0-9]{32}$/.test(env.ACCOUNT_PASSWORD_SALT || '') || !/^[a-f0-9]{64}$/.test(env.ACCOUNT_PASSWORD_HASH || '') || !/^[a-f0-9]{64}$/.test(env.SESSION_SECRET || '')) loginFailure('NODE_LOGIN_CONFIG');
}

function loginOrigin(request) {
  const url = new URL(request.url);
  const local = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!local && url.protocol !== 'https:') loginReject('请使用 HTTPS 打开学习站。', 400);
  if (request.headers.get('origin') !== url.origin || request.headers.get('sec-fetch-site') === 'cross-site') loginReject('请求来源无效。', 403);
}

async function readLoginInput(request) {
  if ((request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() !== 'application/json') loginReject('请求格式无效。', 415);
  if (Number(request.headers.get('content-length')) > LOGIN_LIMIT) loginReject('请求过大。', 413);
  let input;
  try {
    // The Cloud Functions request body is parsed with its documented API.
    input = await request.json();
  } catch {
    loginReject('请求格式无效。', 400);
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) loginReject('请求格式无效。', 400);
  if (loginEncoder.encode(JSON.stringify(input)).byteLength > LOGIN_LIMIT) loginReject('请求过大。', 413);
  if (typeof input.username !== 'string' || input.username.length > 40 || typeof input.password !== 'string' || input.password.length > 128) loginReject('姓名拼音或验证码不正确。', 401);
  if (typeof input.ticket !== 'string' || input.ticket.length > 512) loginReject('登录请求已失效，请重新登录。', 403);
  return { username: input.username.trim().toLowerCase(), password: input.password, ticket: input.ticket };
}

function checkLoginTicket(ticket, input, env, now) {
  const invalid = () => loginReject('登录请求已失效，请重新登录。', 403);
  const parts = ticket.split('.');
  if (parts.length !== 2 || !/^[A-Za-z0-9+/]+={0,2}$/.test(parts[0]) || !/^[a-f0-9]{64}$/.test(parts[1])) invalid();
  const bytes = Buffer.from(parts[0], 'base64');
  if (bytes.toString('base64') !== parts[0]) invalid();
  let payload;
  try { payload = JSON.parse(bytes.toString('utf8')); }
  catch { invalid(); }
  const nowSeconds = Math.floor(now / 1000);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length !== 2 || !loginUuid.test(payload.nonce) || !Number.isSafeInteger(payload.exp) || payload.exp <= nowSeconds || payload.exp > nowSeconds + 65) invalid();
  // Bind a rate-limited ticket to exactly one password attempt. Replaying it
  // cannot turn one reserved attempt into many different password guesses.
  const signed = 'learning-station:login-ticket:v1\n' + parts[0] + '\n' + JSON.stringify([input.username, input.password]);
  const expected = createHmac('sha256', Buffer.from(env.SESSION_SECRET, 'hex')).update(signed, 'utf8').digest();
  if (!loginEqual(expected, Buffer.from(parts[1], 'hex'))) invalid();
  return payload;
}

export async function handleLogin(request, env, { now = Date.now(), verifyCredentials: verify = verifyCredentials } = {}) {
  try {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/auth/login') return loginJson({ error: '接口不存在。' }, 404);
    loginOrigin(request);
    validateLoginConfig(env);
    const input = await readLoginInput(request);
    const ticket = checkLoginTicket(input.ticket, input, env, now);
    let valid;
    try { valid = await verify({ username: input.username, password: input.password }, env); }
    catch { loginFailure('NODE_LOGIN_PASSWORD'); }
    if (typeof valid !== 'boolean') loginFailure('NODE_LOGIN_PASSWORD');
    if (!valid) loginReject('姓名拼音或验证码不正确。', 401);
    const payload = Buffer.from(JSON.stringify({ sub: env.ACCOUNT_USERNAME, nonce: ticket.nonce, exp: ticket.exp }), 'utf8').toString('base64');
    const signature = createHmac('sha256', Buffer.from(env.SESSION_SECRET, 'hex')).update('learning-station:login-proof:v1\n' + payload, 'utf8').digest('hex');
    // Edge completes login and issues the existing session cookie. This route
    // only returns a short-lived proof and never accesses learning storage.
    return loginJson({ proof: payload + '.' + signature });
  } catch (error) {
    if (error?.[loginPublicFailure]) return loginJson({ error: error.message }, error.status);
    const code = loginCodes.has(error?.code) ? error.code : 'NODE_LOGIN_INTERNAL';
    console.error(JSON.stringify({ event: 'learning_node_login_failure', code }));
    return loginJson({ error: '云端暂时无法连接，请稍后重试。', code }, 503);
  }
}
