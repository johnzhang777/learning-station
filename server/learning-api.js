// Web-standard APIs only: runs in EdgeOne Edge Functions, not Node Functions.
const encoder = new TextEncoder();
const AGE = 30 * 24 * 3600;
const ITERATIONS = 120000;
const uuid = /^[a-f0-9]{32}$/;
const noCache = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', 'Vary': 'Cookie', 'X-Content-Type-Options': 'nosniff' };
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { ...noCache, ...headers } });
const publicFailure = Symbol('publicFailure');
const fail = (message, status) => { throw Object.assign(new Error(message), { status, [publicFailure]: true }); };
const diagnosticCodes = new Set(['CRYPTO_PASSWORD_IMPORT', 'CRYPTO_PASSWORD_DERIVE', 'CRYPTO_SESSION_IMPORT', 'CRYPTO_SESSION_SIGN', 'CRYPTO_DIGEST', 'SESSION_RANDOM', 'LOGIN_RATE_READ', 'LOGIN_RATE_WRITE', 'LOGIN_RATE_PARSE', 'PROGRESS_LIST', 'PROGRESS_READ', 'PROGRESS_PARSE', 'PROGRESS_WRITE']);
const errorKinds = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'NotSupportedError', 'OperationError', 'DataError', 'InvalidAccessError', 'InvalidStateError', 'QuotaExceededError', 'SecurityError', 'AbortError']);
const errorReasons = new Set(['RUNTIME_ERROR', 'ITERATION_LIMIT', 'UNSUPPORTED_ALGORITHM']);
function cryptoFailureReason(code, error) {
  if (!['CRYPTO_PASSWORD_IMPORT', 'CRYPTO_PASSWORD_DERIVE'].includes(code)) return 'RUNTIME_ERROR';
  // Classify a native error without returning its message, inputs or numbers.
  const message = typeof error?.message === 'string' ? error.message : '';
  if (/iteration/i.test(message) && /limit|max|<=|too (?:large|high|many)|above|greater than|exceed|at most/i.test(message)) return 'ITERATION_LIMIT';
  if (/not supported|unsupported|unrecognized|not recognized/i.test(message)) return 'UNSUPPORTED_ALGORITHM';
  return 'RUNTIME_ERROR';
}
async function cloudOperation(code, action) {
  try { return await action(); }
  catch (error) {
    // Vendor exceptions can include keys or credentials: keep fixed labels only.
    throw Object.assign(new Error('Cloud operation failed'), { diagnosticCode: code, kind: errorKinds.has(error?.name) ? error.name : 'Error', reason: cryptoFailureReason(code, error) });
  }
}
const hex = bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
const unhex = s => Uint8Array.from(s.match(/../g), b => parseInt(b, 16));
function constantEqual(a, b) { let diff = a.length ^ b.length; for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0); return diff === 0; }
async function digest(text) { return hex(await cloudOperation('CRYPTO_DIGEST', () => crypto.subtle.digest('SHA-256', encoder.encode(text)))); }
export async function passwordHash(password, salt) {
  const key = await cloudOperation('CRYPTO_PASSWORD_IMPORT', () => crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']));
  return hex(await cloudOperation('CRYPTO_PASSWORD_DERIVE', () => crypto.subtle.deriveBits({ name: 'PBKDF2', salt: unhex(salt), iterations: ITERATIONS, hash: 'SHA-256' }, key, 256)));
}
function config(env, kv) {
  if (!/^[a-z]{2,40}$/.test(env.ACCOUNT_USERNAME || '') || !/^[a-f0-9]{32}$/.test(env.ACCOUNT_PASSWORD_SALT || '') || !/^[a-f0-9]{64}$/.test(env.ACCOUNT_PASSWORD_HASH || '') || !/^[a-f0-9]{64}$/.test(env.SESSION_SECRET || '') || !kv?.get || !kv?.put || !kv?.list) fail('登录服务尚未完成配置，请联系家长。', 503);
}
function local(request) { const u = new URL(request.url); return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname); }
function cookieName(request) { return local(request) ? 'learning_session' : '__Host-learning_session'; }
function cookie(request, value, age = AGE) { return `${cookieName(request)}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${local(request) ? '' : '; Secure'}`; }
async function sign(value, secret) {
  const key = await cloudOperation('CRYPTO_SESSION_IMPORT', () => crypto.subtle.importKey('raw', unhex(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']));
  return hex(await cloudOperation('CRYPTO_SESSION_SIGN', () => crypto.subtle.sign('HMAC', key, encoder.encode(value))));
}
async function issue(env, now) {
  const nonce = await cloudOperation('SESSION_RANDOM', () => hex(crypto.getRandomValues(new Uint8Array(16))));
  const payload = btoa(JSON.stringify({ sub: env.ACCOUNT_USERNAME, exp: Math.floor(now / 1000) + AGE, nonce }));
  return `${payload}.${await sign(payload, env.SESSION_SECRET)}`;
}
async function session(request, env, now) {
  const raw = (request.headers.get('cookie') || '').split(';').map(s => s.trim()).find(s => s.startsWith(cookieName(request) + '='))?.slice(cookieName(request).length + 1);
  if (!raw || raw.length > 1024) fail('请先登录。', 401);
  const parts = raw.split('.');
  if (parts.length !== 2 || !constantEqual(parts[1], await sign(parts[0], env.SESSION_SECRET))) fail('登录已过期，请重新登录。', 401);
  let s; try { s = JSON.parse(atob(parts[0])); } catch { fail('请重新登录。', 401); }
  if (s.sub !== env.ACCOUNT_USERNAME || !uuid.test(s.nonce) || !Number.isSafeInteger(s.exp) || s.exp <= Math.floor(now / 1000) || s.exp > Math.floor(now / 1000) + AGE + 60) fail('登录已过期，请重新登录。', 401);
  return s;
}
function sameOrigin(request) {
  if (request.headers.get('origin') !== new URL(request.url).origin || request.headers.get('sec-fetch-site') === 'cross-site') fail('请求来源无效。', 403);
}
async function body(request, limit) {
  if (!(request.headers.get('content-type') || '').startsWith('application/json')) fail('请求格式无效。', 415);
  if (Number(request.headers.get('content-length')) > limit) fail('请求过大。', 413);
  const reader = request.body?.getReader(); if (!reader) fail('请求内容为空。', 400);
  let size = 0, chunks = [];
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    // EdgeOne streams also return raw ArrayBuffers, views, and strings.
    // Normalize before counting bytes; ArrayBuffer and DataView have no length.
    let chunk;
    if (typeof value === 'string') chunk = encoder.encode(value);
    else if (value instanceof ArrayBuffer) chunk = new Uint8Array(value);
    else if (ArrayBuffer.isView(value)) chunk = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    else { await reader.cancel(); fail('请求格式无效。', 400); }
    size += chunk.byteLength;
    if (size > limit) { await reader.cancel(); fail('请求过大。', 413); }
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(size); let offset = 0; for (const c of chunks) { bytes.set(c, offset); offset += c.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { fail('请求格式无效。', 400); }
}
export function validateFields(fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields) || Object.keys(fields).length > 526) fail('学习记录格式无效。', 400);
  const clean = {};
  for (const [name, field] of Object.entries(fields)) {
    if (!field || !Number.isSafeInteger(field.clock) || field.clock < 1 || field.clock > 1e12 || !uuid.test(field.actor)) fail('学习记录版本无效。', 400);
    if (name === 'position') {
      if (!field.value || !Number.isInteger(field.value.lastDay) || field.value.lastDay < 1 || field.value.lastDay > 147 || !Number.isInteger(field.value.lastIndex) || field.value.lastIndex < 0 || field.value.lastIndex > 4) fail('学习位置无效。', 400);
      clean[name] = { value: { lastDay: field.value.lastDay, lastIndex: field.value.lastIndex }, clock: field.clock, actor: field.actor };
    } else if (/^w\d{3}$/.test(name) && Number(name.slice(1)) >= 1 && Number(name.slice(1)) <= 525 && ['learned', 'practice', null].includes(field.value)) {
      clean[name] = { value: field.value, clock: field.clock, actor: field.actor };
    } else fail('学习标记无效。', 400);
  }
  return clean;
}
export function mergeFields(target, incoming) {
  for (const [name, f] of Object.entries(incoming)) {
    const old = target[name];
    if (!old || f.clock > old.clock || (f.clock === old.clock && f.actor > old.actor)) target[name] = f;
  }
  return target;
}
async function load(kv) {
  // Immutable checkpoints: concurrent devices never write over one another.
  // List metadata, then fetch only the newest checkpoint of each writer.
  const writers = new Map(); let cursor;
  do {
    const page = await cloudOperation('PROGRESS_LIST', () => kv.list({ prefix: 'progress_v2_', limit: 256, ...(cursor ? { cursor } : {}) }));
    for (const { key } of page.keys) {
      const match = /^progress_v2_([a-f0-9]{32})_(\d{16})$/.exec(key); if (!match) continue;
      const list = writers.get(match[1]) || []; list.push(key); writers.set(match[1], list);
    }
    if (page.complete) break;
    if (!page.cursor || page.cursor === cursor) throw Error('Invalid KV pagination');
    cursor = page.cursor;
  } while (true);
  const fields = {};
  // Bound parallel reads instead of loading one value per historical edit.
  const lists = [...writers.values()];
  for (let i = 0; i < lists.length; i += 8) {
    const docs = await Promise.all(lists.slice(i, i + 8).map(async keys => {
      for (const key of keys.sort().reverse()) {
        const raw = await cloudOperation('PROGRESS_READ', () => kv.get(key)); if (!raw) continue;
        return validateFields((await cloudOperation('PROGRESS_PARSE', () => JSON.parse(raw))).fields);
      }
      return {};
    }));
    for (const doc of docs) mergeFields(fields, doc);
  }
  return { fields, writers };
}
export async function handle(request, env, kv, { now = Date.now(), clientIp } = {}) {
  try {
    config(env, kv);
    if (!local(request) && new URL(request.url).protocol !== 'https:') fail('请使用 HTTPS 打开学习站。', 400);
    const route = new URL(request.url).pathname.replace(/\/$/, '');
    if (request.method === 'POST') sameOrigin(request);
    if (route === '/api/login' && request.method === 'POST') {
      const input = await body(request, 1024);
      // eo.clientIp is supplied by EdgeOne; no spoofable X-Forwarded-For trust.
      const ip = clientIp || request.eo?.clientIp;
      // If the runtime does not expose a trusted client IP, keep a shared account
      // limit instead of silently disabling it. Never trust arbitrary headers.
      const rateKey = ip ? 'login_rate_' + (await digest(ip)).slice(0, 32) : 'login_rate_account';
      const rawRate = await cloudOperation('LOGIN_RATE_READ', () => kv.get(rateKey));
      let rate = await cloudOperation('LOGIN_RATE_PARSE', () => JSON.parse(rawRate || 'null'));
      if (!rate || rate.until <= now) rate = { count: 0, until: now + 600000 };
      if (rate.count >= 8) return json({ error: '尝试次数较多，请十分钟后再试。' }, 429, { 'Retry-After': String(Math.ceil((rate.until - now) / 1000)) });
      if (typeof input.username !== 'string' || typeof input.password !== 'string' || input.username.length > 40 || input.password.length > 128) fail('姓名拼音或验证码不正确。', 401);
      const hash = await passwordHash(input.password, env.ACCOUNT_PASSWORD_SALT);
      const valid = constantEqual(input.username.trim().toLowerCase(), env.ACCOUNT_USERNAME) && constantEqual(hash, env.ACCOUNT_PASSWORD_HASH);
      rate.count = valid ? 0 : rate.count + 1; await cloudOperation('LOGIN_RATE_WRITE', () => kv.put(rateKey, JSON.stringify(rate)));
      if (!valid) fail('姓名拼音或验证码不正确。', 401);
      const token = await issue(env, now); const s = JSON.parse(atob(token.split('.')[0]));
      return json({ username: s.sub, csrf: s.nonce, expiresAt: s.exp * 1000 }, 200, { 'Set-Cookie': cookie(request, token) });
    }
    const s = await session(request, env, now);
    if (route === '/api/session' && request.method === 'GET') return json({ username: s.sub, csrf: s.nonce, expiresAt: s.exp * 1000 });
    if (request.method === 'POST' && !constantEqual(request.headers.get('x-csrf-token') || '', s.nonce)) fail('请刷新页面后再试。', 403);
    if (route === '/api/logout' && request.method === 'POST') return json({ ok: true }, 200, { 'Set-Cookie': cookie(request, '', 0) });
    if (route === '/api/progress' && request.method === 'GET') {
      const { fields } = await load(kv);
      return json({ fields, savedAt: now, consistencyDelaySeconds: 60 });
    }
    if (route === '/api/progress' && request.method === 'POST') {
      const input = await body(request, 100000);
      if (!uuid.test(input.writer) || !Number.isSafeInteger(input.sequence) || input.sequence < 1 || input.sequence > 1e15) fail('设备记录格式无效。', 400);
      const fields = validateFields(input.fields);
      const key = `progress_v2_${input.writer}_${String(input.sequence).padStart(16, '0')}`;
      const doc = { fields, savedAt: now };
      // Await persistence before acknowledging. Retried writes reuse the same key.
      const existing = await cloudOperation('PROGRESS_READ', () => kv.get(key));
      if (existing && JSON.stringify((await cloudOperation('PROGRESS_PARSE', () => JSON.parse(existing))).fields) !== JSON.stringify(fields)) fail('记录版本重复，请刷新页面。', 409);
      await cloudOperation('PROGRESS_WRITE', () => kv.put(key, JSON.stringify(doc)));
      return json({ ok: true, sequence: input.sequence, savedAt: now });
    }
    return json({ error: '接口不存在。' }, 404);
  } catch (e) {
    if (e?.[publicFailure]) return json({ error: e.message }, e.status);
    const code = diagnosticCodes.has(e?.diagnosticCode) ? e.diagnosticCode : 'INTERNAL';
    const kind = errorKinds.has(e?.kind || e?.name) ? (e.kind || e.name) : 'Error';
    const reason = errorReasons.has(e?.reason) ? e.reason : 'RUNTIME_ERROR';
    // Never log raw errors, credentials, cookies, request bodies or KV values.
    console.error(JSON.stringify({ event: 'learning_api_failure', code, kind, reason }));
    return json({ error: `云端暂时无法连接，请稍后重试。（诊断码：${code}）`, code, kind, reason }, 503);
  }
}
