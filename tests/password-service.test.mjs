import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, pbkdf2Sync } from 'node:crypto';
import { handle, verifyWithNode } from '../server/learning-api.js';
import { handleVerification } from '../server/node-password-verifier.js';

// These credentials are synthetic and independent of the deployed account.
const password = 'integration-test-password-729';
const env = {
  ACCOUNT_USERNAME: 'testchild', ACCOUNT_PASSWORD_SALT: 'ab'.repeat(16),
  ACCOUNT_PASSWORD_HASH: pbkdf2Sync(password, Buffer.from('ab'.repeat(16), 'hex'), 120000, 32, 'sha256').toString('hex'),
  SESSION_SECRET: 'cd'.repeat(32)
};
const origin = 'https://learn.example';
const expectedToken = createHash('sha256').update('learning-station:password-verifier:v1\n' + env.SESSION_SECRET).digest('hex');
const sensitiveFailure = `${password} ${env.SESSION_SECRET} ${env.ACCOUNT_PASSWORD_HASH} private-learning-record`;
class KV {
  data = new Map();
  get = async key => this.data.get(key) || null;
  put = async (key, value) => { this.data.set(key, value); };
  async list({ prefix, cursor, limit }) {
    const keys = [...this.data.keys()].filter(key => key.startsWith(prefix) && (!cursor || key >= cursor)).sort();
    return { keys: keys.slice(0, limit).map(key => ({ key })), complete: keys.length <= limit, cursor: keys[limit] || null };
  }
}
function request(route, { method = 'GET', data, cookie, csrf, requestOrigin = origin } = {}) {
  return new Request(origin + route, {
    method, headers: {
      ...(method === 'POST' ? { Origin: requestOrigin, 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {})
    }, ...(data === undefined ? {} : { body: JSON.stringify(data) })
  });
}
const nodeTransport = (url, options) => handleVerification(new Request(url, options), env);
function productionHandle(r, kv, { transport = nodeTransport, ...context } = {}) {
  return handle(r, env, kv, { ...context, verifyPassword: input => verifyWithNode(r, env, input, { fetch: transport }) });
}
async function login(kv, options = {}) {
  const result = await productionHandle(request('/api/login', { method: 'POST', data: { username: 'testchild', password } }), kv, options);
  assert.equal(result.status, 200, JSON.stringify(await result.clone().json()));
  const payload = await result.json();
  return { cookie: result.headers.get('set-cookie').split(';')[0], csrf: payload.csrf, result, payload };
}
async function captureDiagnostics(run) {
  const original = console.error, logs = [];
  try { console.error = (...args) => logs.push(args); return { response: await run(), logs }; }
  finally { console.error = original; }
}
async function assertServiceFailure(result, code, kv) {
  assert.equal(result.response.status, 503);
  assert.equal(result.response.headers.get('set-cookie'), null);
  const payload = await result.response.json();
  assert.equal(payload.code, code);
  assert.equal(payload.ok, undefined);
  assert.match(payload.error, new RegExp(code));
  assert.equal(result.logs.length, 1);
  assert.equal(result.logs[0].length, 1);
  assert.equal(JSON.parse(result.logs[0][0]).code, code);
  const output = JSON.stringify({ payload, logs: result.logs });
  for (const secret of [password, ...Object.values(env), expectedToken, 'private-learning-record']) {
    // Username is intentionally public, while verifiers and passwords are not.
    if (secret !== env.ACCOUNT_USERNAME) assert.equal(output.includes(secret), false);
  }
  assert.equal(kv.data.size, 0, 'a failed verifier must not create sessions, progress, or failed-password writes');
}

test('Edge password client sends only credentials to the same-origin authenticated Node route', async () => {
  const input = { username: 'testchild', password };
  const r = request('/api/login?redirect=https%3A%2F%2Fevil.example', { method: 'POST', data: input });
  for (const valid of [true, false]) {
    let calls = 0;
    const value = await verifyWithNode(r, env, input, { fetch: async (url, options) => {
      calls++;
      assert.equal(String(url), origin + '/internal/verify-password');
      assert.equal(new URL(url).search, '');
      assert.equal(options.method, 'POST');
      assert.equal(options.redirect, 'error');
      assert.equal(options.cache, 'no-store');
      assert.equal(options.signal instanceof AbortSignal, true);
      assert.equal(options.signal.aborted, false);
      const headers = new Headers(options.headers);
      assert.equal(headers.get('authorization'), 'Bearer ' + expectedToken);
      assert.match(headers.get('content-type'), /^application\/json(?:;|$)/);
      assert.deepEqual(JSON.parse(options.body), input);
      assert.deepEqual(Object.keys(JSON.parse(options.body)).sort(), ['password', 'username']);
      assert.equal(options.body.includes(env.SESSION_SECRET), false);
      assert.equal(options.body.includes(env.ACCOUNT_PASSWORD_HASH), false);
      return Response.json({ valid });
    } });
    assert.equal(value, valid);
    assert.equal(calls, 1);
  }
});

test('real Node verification supports login, refreshed cookies and cross-device persistent progress', async () => {
  const kv = new KV(), calls = [];
  const transport = async (url, options) => { calls.push(String(url)); return nodeTransport(url, options); };
  const now = Date.now(), first = await login(kv, { transport, now });
  assert.match(first.result.headers.get('set-cookie'), /HttpOnly; SameSite=Strict; Max-Age=2592000; Secure/);
  assert.equal(first.result.headers.get('cache-control'), 'private, no-store');
  const refresh = await productionHandle(request('/api/session', first), kv, { transport, now: now + 3600000 });
  assert.equal(refresh.status, 200);
  assert.equal((await refresh.json()).username, env.ACCOUNT_USERNAME);
  const second = await login(kv, { transport, now });
  const actorA = 'a'.repeat(32), actorB = 'b'.repeat(32);
  const firstFields = { w001: { value: 'learned', clock: 1, actor: actorA } };
  const secondFields = { w002: { value: 'practice', clock: 2, actor: actorB } };
  for (const [auth, writer, fields] of [[first, actorA, firstFields], [second, actorB, secondFields]]) {
    const saved = await productionHandle(request('/api/progress', { ...auth, method: 'POST', data: { writer, sequence: 1, fields } }), kv, { transport, now });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).ok, true);
  }
  for (const auth of [first, second]) {
    const read = await productionHandle(request('/api/progress', auth), kv, { transport, now });
    assert.equal(read.status, 200);
    assert.deepEqual((await read.json()).fields, { ...firstFields, ...secondFields });
  }
  assert.deepEqual(calls, Array(2).fill(origin + '/internal/verify-password'));
});

test('real Node verifier distinguishes incorrect credentials and preserves Edge login throttling', async () => {
  const kv = new KV(), context = { clientIp: '192.0.2.20' };
  for (let i = 0; i < 8; i++) {
    const r = request('/api/login', { method: 'POST', data: { username: 'testchild', password: 'incorrect-test-password' } });
    const result = await captureDiagnostics(() => productionHandle(r, kv, context));
    assert.equal(result.response.status, 401);
    assert.equal(result.response.headers.get('set-cookie'), null);
    assert.deepEqual(result.logs, []);
  }
  const throttled = await productionHandle(request('/api/login', { method: 'POST', data: { username: 'testchild', password } }), kv, context);
  assert.equal(throttled.status, 429);
  assert.equal(throttled.headers.get('set-cookie'), null);
  assert.equal((await productionHandle(request('/api/login', { method: 'POST', data: { username: 'wrongchild', password } }), new KV())).status, 401);
});

test('production login never invokes Edge PBKDF2 even if importing or deriving PBKDF2 is unsupported', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const originalCrypto = globalThis.crypto;
  let attempts = 0;
  const subtle = new Proxy(originalCrypto.subtle, { get(target, property) {
    const original = Reflect.get(target, property, target);
    if (typeof original !== 'function') return original;
    return (...args) => {
      const algorithm = property === 'importKey' ? args[2] : args[0];
      if (['importKey', 'deriveBits', 'deriveKey'].includes(property) && (typeof algorithm === 'string' ? algorithm : algorithm?.name) === 'PBKDF2') {
        attempts++;
        throw new DOMException(sensitiveFailure, 'NotSupportedError');
      }
      return original.apply(target, args);
    };
  } });
  try {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { subtle, getRandomValues: originalCrypto.getRandomValues.bind(originalCrypto) } });
    const kv = new KV();
    const auth = await login(kv);
    assert.equal((await productionHandle(request('/api/session', auth), kv)).status, 200);
    assert.equal((await productionHandle(request('/api/login', { method: 'POST', data: { username: 'testchild', password: 'incorrect' } }), kv)).status, 401);
    assert.equal(attempts, 0);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
    else delete globalThis.crypto;
  }
});

test('Node password endpoint does not expose verification without a valid service token', async () => {
  for (const authorization of [undefined, 'Bearer incorrect-token', 'Basic ' + expectedToken]) {
    const r = new Request(origin + '/internal/verify-password', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(authorization ? { Authorization: authorization } : {}) }, body: JSON.stringify({ username: 'testchild', password }) });
    const response = await handleVerification(r, env);
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal((await response.text()).includes(password), false);
  }
});

test('verifier transport and response failures retain safe diagnoses and never create sessions or acknowledge writes', async () => {
  const cases = [
    ['PASSWORD_SERVICE_FETCH', async () => { throw Error(sensitiveFailure); }],
    ['PASSWORD_SERVICE_RESPONSE', async () => new Response(sensitiveFailure, { status: 503 })],
    ['PASSWORD_SERVICE_RESPONSE', async () => new Response('', { status: 302, headers: { Location: 'https://evil.example' } })],
    ['PASSWORD_SERVICE_RESPONSE', async () => new Response('{"valid":true}', { headers: { 'Content-Type': 'text/html' } })],
    ['PASSWORD_SERVICE_RESPONSE', async () => new Response('{', { headers: { 'Content-Type': 'application/json' } })],
    ...[{}, { valid: 'true' }, { valid: 1 }, null, [true]].map(value => ['PASSWORD_SERVICE_RESPONSE', async () => Response.json(value)])
  ];
  for (const [code, transport] of cases) {
    const kv = new KV();
    const result = await captureDiagnostics(() => productionHandle(request('/api/login', { method: 'POST', data: { username: 'testchild', password } }), kv, { transport }));
    await assertServiceFailure(result, code, kv);
  }
  const kv = new KV();
  const result = await captureDiagnostics(() => handle(request('/api/login', { method: 'POST', data: { username: 'testchild', password } }), env, kv, { verifyPassword: async () => { throw Error(sensitiveFailure); } }));
  await assertServiceFailure(result, 'INTERNAL', kv);
});

test('password service requests abort after the bounded timeout without creating a session', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const kv = new KV();
  const transport = async (url, options) => {
    started();
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException(sensitiveFailure, 'AbortError')), { once: true }));
  };
  const result = captureDiagnostics(() => productionHandle(request('/api/login', { method: 'POST', data: { username: 'testchild', password } }), kv, { transport }));
  await ready;
  t.mock.timers.tick(10000);
  await assertServiceFailure(await result, 'PASSWORD_SERVICE_FETCH', kv);
});
