import test from 'node:test';
import assert from 'node:assert/strict';
import { handle, passwordHash, mergeFields } from '../server/learning-api.js';

const env = { ACCOUNT_USERNAME: 'testchild', ACCOUNT_PASSWORD_SALT: 'ab'.repeat(16), ACCOUNT_PASSWORD_HASH: await passwordHash('test-pass-729', 'ab'.repeat(16)), SESSION_SECRET: 'cd'.repeat(32) };
const actorA = 'a'.repeat(32), actorB = 'b'.repeat(32);
class KV {
  data = new Map();
  get = async key => this.data.get(key) || null;
  put = async (key, value) => { this.data.set(key, value); };
  async list({ prefix, cursor, limit }) {
    const keys = [...this.data.keys()].filter(k => k.startsWith(prefix) && (!cursor || k >= cursor)).sort();
    return { keys: keys.slice(0, limit).map(key => ({ key })), complete: keys.length <= limit, cursor: keys[limit] || null };
  }
}
function request(route, { method = 'GET', data, cookie, csrf, origin = 'https://learn.example', ip } = {}) {
  const r = new Request('https://learn.example' + route, { method, headers: { ...(method === 'POST' ? { Origin: origin, 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}) }, ...(data !== undefined ? { body: JSON.stringify(data) } : {}) });
  if (ip) Object.defineProperty(r, 'eo', { value: { clientIp: ip } }); return r;
}
async function login(kv, now) {
  const res = await handle(request('/api/login', { method: 'POST', data: { username: 'testchild', password: 'test-pass-729' } }), env, kv, now ? { now } : {});
  assert.equal(res.status, 200); return { cookie: res.headers.get('set-cookie').split(';')[0], csrf: (await res.json()).csrf, res };
}

// EdgeOne readers can return string, ArrayBuffer, or any ArrayBufferView.
function streamedRequest(route, chunks, options = {}) {
  const r = request(route, { ...options, method: 'POST' });
  let index = 0, cancelled = false;
  Object.defineProperty(r, 'body', { value: { getReader: () => ({
    async read() { return index < chunks.length ? { done: false, value: chunks[index++] } : { done: true }; },
    async cancel() { cancelled = true; }
  }) } });
  return { request: r, wasCancelled: () => cancelled };
}
const encode = text => new TextEncoder().encode(text);
function paddedView(bytes, View) {
  const padded = new Uint8Array(bytes.byteLength + 7);
  padded.fill(0xff); padded.set(bytes, 3);
  return new View(padded.buffer, 3, bytes.byteLength);
}

test('EdgeOne stream chunk types support login, session refresh and persisted progress', async () => {
  const formats = {
    ArrayBuffer: text => [...encode(text)].map(byte => Uint8Array.of(byte).buffer),
    'offset Uint8Array': text => [paddedView(encode(text), Uint8Array)],
    DataView: text => [paddedView(encode(text), DataView)],
    string: text => [text.slice(0, 10), text.slice(10)],
    mixed: text => [text.slice(0, 10), encode(text.slice(10, 20)).buffer, paddedView(encode(text.slice(20)), DataView)]
  };
  for (const [name, chunks] of Object.entries(formats)) {
    const kv = new KV();
    const input = streamedRequest('/api/login', chunks(JSON.stringify({ username: 'testchild', password: 'test-pass-729', note: '例句😊' })));
    const res = await handle(input.request, env, kv);
    assert.equal(res.status, 200, name);
    const auth = { cookie: res.headers.get('set-cookie').split(';')[0], csrf: (await res.json()).csrf };
    assert.equal((await handle(request('/api/session', auth), env, kv)).status, 200, name);
    const fields = { w001: { value: 'learned', clock: 1, actor: actorA } };
    const progress = streamedRequest('/api/progress', chunks(JSON.stringify({ writer: actorA, sequence: 1, fields })), auth);
    assert.equal((await handle(progress.request, env, kv)).status, 200, name);
    assert.deepEqual((await (await handle(request('/api/progress', auth), env, kv)).json()).fields, fields, name);
  }
});

test('stream parsing rejects malformed JSON and unsupported chunks', async () => {
  for (const chunks of [[encode('{').buffer], ['{'], [42]]) {
    const input = streamedRequest('/api/login', chunks);
    const res = await handle(input.request, env, new KV());
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, '请求格式无效。');
  }
});

test('stream size limit counts UTF-8 bytes and cancels oversized bodies', async () => {
  for (const chunks of [[new ArrayBuffer(1025)], ['中'.repeat(342)], [new ArrayBuffer(600), paddedView(new Uint8Array(425), DataView)]]) {
    const input = streamedRequest('/api/login', chunks);
    const kv = new KV(), res = await handle(input.request, env, kv);
    assert.equal(res.status, 413);
    assert.equal(input.wasCancelled(), true);
    assert.equal(kv.data.size, 0);
  }
});
test('auth rejects wrong password; secure cookie survives refresh, expires, rejects tampering', async () => {
  const kv = new KV();
  assert.equal((await handle(request('/api/login', { method: 'POST', data: { username: 'testchild', password: 'wrong-pass' } }), env, kv)).status, 401);
  const now = Date.now(), a = await login(kv, now);
  assert.match(a.res.headers.get('set-cookie'), /__Host-learning_session=.*HttpOnly; SameSite=Strict; Max-Age=2592000; Secure/);
  assert.equal((await handle(request('/api/session', a), env, kv, { now: now + 3600000 })).status, 200);
  assert.equal((await handle(request('/api/session', a), env, kv, { now: now + 31 * 86400000 })).status, 401);
  assert.equal((await handle(request('/api/session', { cookie: a.cookie + '0' }), env, kv)).status, 401);
  assert.equal((await handle(request('/api/progress'), env, kv)).status, 401);
});
test('origin and CSRF checks; all personal responses disable caches; logout expires cookie', async () => {
  const kv = new KV(), a = await login(kv);
  assert.equal((await handle(request('/api/login', { method: 'POST', origin: 'https://evil.example', data: {} }), env, kv)).status, 403);
  assert.equal((await handle(request('/api/progress', { method: 'POST', cookie: a.cookie, data: {} }), env, kv)).status, 403);
  const read = await handle(request('/api/progress', a), env, kv);
  assert.equal(read.headers.get('cache-control'), 'private, no-store');
  const logout = await handle(request('/api/logout', { ...a, method: 'POST', data: {} }), env, kv);
  assert.equal(logout.status, 200); assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
});
test('two device checkpoints merge, clearing uses a tombstone, retries are idempotent', async () => {
  const kv = new KV(), a = await login(kv), b = await login(kv);
  const post = async (auth, writer, sequence, fields) => handle(request('/api/progress', { ...auth, method: 'POST', data: { writer, sequence, fields } }), env, kv);
  const first = { w001: { value: 'learned', clock: 1, actor: actorA }, position: { value: { lastDay: 2, lastIndex: 3 }, clock: 2, actor: actorA } };
  const second = { w002: { value: 'practice', clock: 1, actor: actorB } };
  const results = await Promise.all([post(a, actorA, 1, first), post(b, actorB, 1, second)]);
  assert.deepEqual(results.map(r => r.status), [200, 200]);
  assert.equal((await post(a, actorA, 1, first)).status, 200);
  let fields = (await (await handle(request('/api/progress', b), env, kv)).json()).fields;
  assert.equal(fields.w001.value, 'learned'); assert.equal(fields.w002.value, 'practice'); assert.equal(fields.position.value.lastIndex, 3);
  const newer = mergeFields(structuredClone(fields), { w001: { value: null, clock: 3, actor: actorB } });
  assert.equal((await post(b, actorB, 2, newer)).status, 200);
  fields = (await (await handle(request('/api/progress', a), env, kv)).json()).fields;
  assert.equal(fields.w001.value, null); assert.equal(fields.w002.value, 'practice');
  assert.equal((await post(a, actorA, 1, second)).status, 409);
});
test('KV pagination reads newest checkpoint per writer; cache visibility can lag without destroying records', async () => {
  const kv = new KV(), a = await login(kv);
  for (let i = 1; i <= 260; i++) await kv.put(`progress_v2_${actorA}_${String(i).padStart(16, '0')}`, JSON.stringify({ fields: { w001: { value: i === 260 ? 'learned' : 'practice', clock: i, actor: actorA } } }));
  const result = await handle(request('/api/progress', a), env, kv); assert.equal((await result.json()).fields.w001.value, 'learned');
  const key = `progress_v2_${actorA}_${String(260).padStart(16, '0')}`;
  const get = kv.get; kv.get = async k => k === key ? null : get(k);
  assert.equal((await (await handle(request('/api/progress', a), env, kv)).json()).fields.w001.value, 'practice');
  kv.get = get; assert.equal((await (await handle(request('/api/progress', a), env, kv)).json()).fields.w001.value, 'learned');
});
test('validation, missing configuration and write failure never acknowledge saved progress', async () => {
  const kv = new KV(), a = await login(kv);
  assert.equal((await handle(request('/api/session'), {}, kv)).status, 503);
  const data = { writer: actorA, sequence: 2, fields: { w999: { value: 'learned', clock: 1, actor: actorA } } };
  assert.equal((await handle(request('/api/progress', { ...a, method: 'POST', data }), env, kv)).status, 400);
  data.fields = { w001: { value: 'learned', clock: 1, actor: actorA } }; kv.put = async () => { throw Error('storage unavailable'); };
  assert.equal((await handle(request('/api/progress', { ...a, method: 'POST', data }), env, kv)).status, 503);
});
test('login attempts are throttled for EdgeOne supplied client IP', async () => {
  const kv = new KV();
  for (let i = 0; i < 8; i++) assert.equal((await handle(request('/api/login', { method: 'POST', data: { username: 'testchild', password: 'incorrect' }, ip: '192.0.2.1' }), env, kv)).status, 401);
  assert.equal((await handle(request('/api/login', { method: 'POST', data: { username: 'testchild', password: 'incorrect' }, ip: '192.0.2.1' }), env, kv)).status, 429);
});

// Diagnostics describe only the failed operation and exception type. Runtime
// exceptions may include inputs, so their messages must never reach users/logs.
const sensitiveFailure = 'raw-password-do-not-log session-secret-do-not-log private-kv-value-do-not-log';
async function captureDiagnostics(run, overrides) {
  const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const originalCrypto = globalThis.crypto, originalError = console.error, logs = [];
  try {
    console.error = (...args) => logs.push(args);
    if (overrides) {
      const subtle = new Proxy(originalCrypto.subtle, {
        get(target, property) {
          const value = overrides[property] || Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
      });
      Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {
        subtle, getRandomValues: originalCrypto.getRandomValues.bind(originalCrypto)
      } });
    }
    return { response: await run(), logs };
  } finally {
    if (cryptoDescriptor) Object.defineProperty(globalThis, 'crypto', cryptoDescriptor);
    else delete globalThis.crypto;
    console.error = originalError;
  }
}
async function assertDiagnostic(result, code, kind, reason = 'RUNTIME_ERROR') {
  assert.equal(result.response.status, 503);
  const payload = await result.response.json();
  assert.deepEqual(payload, { error: `云端暂时无法连接，请稍后重试。（诊断码：${code}）`, code, kind, reason });
  assert.equal(result.logs.length, 1);
  assert.equal(result.logs[0].length, 1);
  assert.equal(typeof result.logs[0][0], 'string');
  assert.deepEqual(JSON.parse(result.logs[0][0]), { event: 'learning_api_failure', code, kind, reason });
  const publicOutput = JSON.stringify({ payload, logs: result.logs });
  for (const secret of sensitiveFailure.split(' ')) assert.equal(publicOutput.includes(secret), false);
  for (const secret of Object.values(env)) assert.equal(publicOutput.includes(secret), false);
  assert.equal(publicOutput.includes('test-pass-729'), false);
  return publicOutput;
}

test('PBKDF2 import and derive failures expose fixed diagnostics without sensitive exception text', async () => {
  for (const [method, code] of [['importKey', 'CRYPTO_PASSWORD_IMPORT'], ['deriveBits', 'CRYPTO_PASSWORD_DERIVE']]) {
    const originalCrypto = globalThis.crypto, originalError = console.error;
    const result = await captureDiagnostics(() => handle(request('/api/login', {
      method: 'POST', data: { username: 'testchild', password: 'test-pass-729' }
    }), env, new KV()), {
      [method]: async () => { throw new DOMException(sensitiveFailure, 'OperationError'); }
    });
    assert.equal(globalThis.crypto, originalCrypto);
    assert.equal(console.error, originalError);
    await assertDiagnostic(result, code, 'OperationError');
  }
});

test('PBKDF2 iteration ceiling is classified without disclosing raw message or iteration counts', async () => {
  for (const message of [
    'PBKDF2 requires an iteration count <= 100000 (requested 120000).',
    'PBKDF2 iteration counts above 100000 are not supported (requested 120000).'
  ]) {
    const result = await captureDiagnostics(() => handle(request('/api/login', {
      method: 'POST', data: { username: 'testchild', password: 'test-pass-729' }
    }), env, new KV()), {
      deriveBits: async () => { throw new DOMException(`${message} ${sensitiveFailure}`, 'OperationError'); }
    });
    const publicOutput = await assertDiagnostic(result, 'CRYPTO_PASSWORD_DERIVE', 'OperationError', 'ITERATION_LIMIT');
    assert.equal(publicOutput.includes('100000'), false);
    assert.equal(publicOutput.includes('120000'), false);
    assert.equal(publicOutput.includes(message), false);
  }
});

test('PBKDF2 unsupported algorithm is classified without disclosing raw message', async () => {
  const result = await captureDiagnostics(() => handle(request('/api/login', {
    method: 'POST', data: { username: 'testchild', password: 'test-pass-729' }
  }), env, new KV()), {
    importKey: async () => { throw new DOMException(`Unrecognized algorithm ${sensitiveFailure}`, 'NotSupportedError'); }
  });
  const publicOutput = await assertDiagnostic(result, 'CRYPTO_PASSWORD_IMPORT', 'NotSupportedError', 'UNSUPPORTED_ALGORITHM');
  assert.equal(publicOutput.includes('Unrecognized algorithm'), false);
});

test('login rate writes expose only the storage operation diagnostic', async () => {
  for (const status of [undefined, 401, 503]) {
    const kv = new KV();
    // Vendor errors sometimes have HTTP status fields. They are not trusted
    // public failures and must not disclose the vendor's raw error message.
    kv.put = async () => { throw Object.assign(Error(sensitiveFailure), { status }); };
    const result = await captureDiagnostics(() => handle(request('/api/login', {
      method: 'POST', data: { username: 'testchild', password: 'test-pass-729' }
    }), env, kv));
    await assertDiagnostic(result, 'LOGIN_RATE_WRITE', 'Error');
    assert.equal(result.response.headers.get('set-cookie'), null);
  }
});

test('progress listing failures expose only the storage operation diagnostic', async () => {
  const kv = new KV(), auth = await login(kv);
  kv.list = async () => { throw Error(sensitiveFailure); };
  const result = await captureDiagnostics(() => handle(request('/api/progress', auth), env, kv));
  await assertDiagnostic(result, 'PROGRESS_LIST', 'Error');
});

test('expected authentication and configuration errors do not emit diagnostics', async () => {
  const wrongPassword = await captureDiagnostics(() => handle(request('/api/login', {
    method: 'POST', data: { username: 'testchild', password: 'incorrect' }
  }), env, new KV()));
  assert.equal(wrongPassword.response.status, 401);
  assert.deepEqual(await wrongPassword.response.json(), { error: '姓名拼音或验证码不正确。' });
  assert.deepEqual(wrongPassword.logs, []);
  const unconfigured = await captureDiagnostics(() => handle(request('/api/session'), {}, new KV()));
  assert.equal(unconfigured.response.status, 503);
  assert.deepEqual(await unconfigured.response.json(), { error: '登录服务尚未完成配置，请联系家长。' });
  assert.deepEqual(unconfigured.logs, []);
});
