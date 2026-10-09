import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, pbkdf2Sync } from 'node:crypto';
import { fileURLToPath } from 'node:url';

class KV {
  data = new Map();
  get = async key => this.data.get(key) || null;
  put = async (key, value) => { this.data.set(key, value); };
  async list({ prefix, cursor, limit }) {
    const keys = [...this.data.keys()].filter(key => key.startsWith(prefix) && (!cursor || key >= cursor)).sort();
    return { keys: keys.slice(0, limit).map(key => ({ key })), complete: keys.length <= limit, cursor: keys[limit] || null };
  }
}

test('standalone deployment wrappers use native Node verification when Edge PBKDF2 is unavailable', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/build.mjs', import.meta.url))], { cwd: root, stdio: 'pipe' });
  const edge = await import(new URL('../dist/edge-functions/api/[[route]].js', import.meta.url));
  const node = await import(new URL('../dist/cloud-functions/internal/verify-password.js', import.meta.url));
  assert.equal(typeof edge.onRequest, 'function');
  assert.equal(node.default, node.onRequest);

  // Independent synthetic verifier: no private or deployed account files.
  const password = 'standalone-bundle-test-581';
  const env = {
    ACCOUNT_USERNAME: 'bundletest', ACCOUNT_PASSWORD_SALT: 'ef'.repeat(16),
    ACCOUNT_PASSWORD_HASH: pbkdf2Sync(password, Buffer.from('ef'.repeat(16), 'hex'), 120000, 32, 'sha256').toString('hex'),
    SESSION_SECRET: '87'.repeat(32)
  };
  const origin = 'https://bundle.example';
  const token = createHash('sha256').update('learning-station:password-verifier:v1\n' + env.SESSION_SECRET).digest('hex');
  const originalEnv = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  const originalGlobals = Object.fromEntries(['crypto', 'fetch', 'LEARNING_KV'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const originalCrypto = globalThis.crypto;
  const kv = new KV();
  let forbiddenPbkdf2Calls = 0, nativeVerifierCalls = 0;
  const subtle = new Proxy(originalCrypto.subtle, { get(target, property) {
    const original = Reflect.get(target, property, target);
    if (typeof original !== 'function') return original;
    return (...args) => {
      const algorithm = property === 'importKey' ? args[2] : args[0];
      if (['importKey', 'deriveBits', 'deriveKey'].includes(property) && (typeof algorithm === 'string' ? algorithm : algorithm?.name) === 'PBKDF2') {
        forbiddenPbkdf2Calls++;
        throw new DOMException('PBKDF2 unavailable in simulated Edge runtime', 'NotSupportedError');
      }
      return original.apply(target, args);
    };
  } });
  function request(route, { method = 'GET', data, cookie } = {}) {
    return new Request(origin + route, {
      method, headers: {
        ...(method === 'POST' ? { Origin: origin, 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {})
      }, ...(data === undefined ? {} : { body: JSON.stringify(data) })
    });
  }
  try {
    Object.assign(process.env, env);
    Object.defineProperty(globalThis, 'LEARNING_KV', { configurable: true, value: kv });
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { subtle, getRandomValues: originalCrypto.getRandomValues.bind(originalCrypto) } });
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: async (url, options) => {
      assert.equal(String(url), origin + '/internal/verify-password');
      assert.equal(options.redirect, 'error');
      assert.equal(options.cache, 'no-store');
      const internal = new Request(url, options);
      assert.equal(internal.headers.get('authorization'), 'Bearer ' + token);
      assert.deepEqual(await internal.clone().json(), { username: env.ACCOUNT_USERNAME, password });
      nativeVerifierCalls++;
      return node.default({ request: internal });
    } });

    const loggedIn = await edge.onRequest({ request: request('/api/login', { method: 'POST', data: { username: env.ACCOUNT_USERNAME, password } }), env });
    assert.equal(loggedIn.status, 200, JSON.stringify(await loggedIn.clone().json()));
    const auth = await loggedIn.json();
    assert.deepEqual(Object.keys(auth).sort(), ['csrf', 'expiresAt', 'username']);
    const setCookie = loggedIn.headers.get('set-cookie');
    assert.match(setCookie, /__Host-learning_session=.*HttpOnly; SameSite=Strict; Max-Age=2592000; Secure/);
    const cookie = setCookie.split(';')[0];
    const session = await edge.onRequest({ request: request('/api/session', { cookie }), env });
    assert.equal(session.status, 200);
    const refreshed = await session.json();
    assert.equal(refreshed.username, env.ACCOUNT_USERNAME);
    assert.equal(refreshed.csrf, auth.csrf);
    const progress = await edge.onRequest({ request: request('/api/progress', { cookie }), env });
    assert.equal(progress.status, 200);
    const saved = await progress.json();
    assert.deepEqual(saved.fields, {});
    const publicOutput = JSON.stringify({ auth, refreshed, saved, setCookie });
    for (const secret of [password, env.ACCOUNT_PASSWORD_SALT, env.ACCOUNT_PASSWORD_HASH, env.SESSION_SECRET, token]) {
      assert.equal(publicOutput.includes(secret), false);
    }
    assert.equal(nativeVerifierCalls, 1);
    assert.equal(forbiddenPbkdf2Calls, 0, 'the actual built Edge wrapper must delegate password verification to the Node wrapper');
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const [key, descriptor] of Object.entries(originalGlobals)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
