import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHmac, pbkdf2Sync } from 'node:crypto';
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

test('actual standalone deployment bundles complete browser-direct login without Edge PBKDF2 or any server fetch', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/build.mjs', import.meta.url))], { cwd: root, stdio: 'pipe' });
  const edge = await import(new URL('../dist/edge-functions/api/[[route]].js', import.meta.url));
  const node = await import(new URL('../dist/cloud-functions/auth/login.js', import.meta.url));
  assert.equal(typeof edge.onRequest, 'function');
  assert.equal(node.default, node.onRequest);

  // Independent synthetic verifier: no private or deployed account files.
  const password = 'standalone-direct-test-581';
  const env = {
    ACCOUNT_USERNAME: 'bundletest', ACCOUNT_PASSWORD_SALT: 'ef'.repeat(16),
    ACCOUNT_PASSWORD_HASH: pbkdf2Sync(password, Buffer.from('ef'.repeat(16), 'hex'), 120000, 32, 'sha256').toString('hex'),
    SESSION_SECRET: '87'.repeat(32)
  };
  const origin = 'https://bundle.example';
  const originalEnv = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  const originalGlobals = Object.fromEntries(['crypto', 'fetch', 'LEARNING_KV'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const originalCrypto = globalThis.crypto;
  const kv = new KV();
  let forbiddenPbkdf2Calls = 0, forbiddenFetchCalls = 0;
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
  function request(route, { method = 'GET', data, cookie, csrf } = {}) {
    return new Request(origin + route, {
      method, headers: {
        ...(method === 'POST' ? { Origin: origin, 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {})
      }, ...(data === undefined ? {} : { body: JSON.stringify(data) })
    });
  }
  const edgeRequest = (route, options = {}) => edge.onRequest({ request: request(route, options), env, clientIp: '192.0.2.52' });
  const sign = text => createHmac('sha256', Buffer.from(env.SESSION_SECRET, 'hex')).update(text, 'utf8').digest('hex');
  function tokenParts(token) {
    const [value, signature] = token.split('.');
    assert.match(signature, /^[a-f0-9]{64}$/);
    return { value, signature, payload: JSON.parse(Buffer.from(value, 'base64').toString('utf8')) };
  }
  async function login() {
    const input = { username: env.ACCOUNT_USERNAME, password };
    const offered = await edgeRequest('/api/login-ticket', { method: 'POST', data: input });
    assert.equal(offered.status, 200, JSON.stringify(await offered.clone().json()));
    assert.equal(offered.headers.get('set-cookie'), null);
    const ticketData = await offered.json();
    assert.deepEqual(Object.keys(ticketData), ['ticket']);
    const ticket = tokenParts(ticketData.ticket);
    assert.equal(ticket.signature, sign('learning-station:login-ticket:v1\n' + ticket.value + '\n' + JSON.stringify([input.username, input.password])));
    assert.equal(ticket.payload.origin, origin);
    const cloudRequest = new Request('http://internal-service/auth/login', {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...input, ticket: ticketData.ticket })
    });
    const verified = await node.default({ request: cloudRequest });
    assert.equal(verified.status, 200, JSON.stringify(await verified.clone().json()));
    assert.equal(verified.headers.get('set-cookie'), null);
    const proofData = await verified.json();
    assert.deepEqual(Object.keys(proofData), ['proof']);
    const proof = tokenParts(proofData.proof);
    assert.equal(proof.signature, sign('learning-station:login-proof:v1\n' + proof.value));
    assert.deepEqual(proof.payload, { sub: env.ACCOUNT_USERNAME, nonce: ticket.payload.nonce, exp: ticket.payload.exp });
    const loggedIn = await edgeRequest('/api/login-complete', { method: 'POST', data: proofData });
    assert.equal(loggedIn.status, 200, JSON.stringify(await loggedIn.clone().json()));
    const auth = await loggedIn.json(), setCookie = loggedIn.headers.get('set-cookie');
    assert.deepEqual(Object.keys(auth).sort(), ['csrf', 'expiresAt', 'username']);
    assert.match(setCookie, /__Host-learning_session=.*HttpOnly; SameSite=Strict; Max-Age=2592000; Secure/);
    const output = JSON.stringify({ ticketData, proofData, auth, setCookie });
    for (const secret of [password, env.ACCOUNT_PASSWORD_SALT, env.ACCOUNT_PASSWORD_HASH, env.SESSION_SECRET]) assert.equal(output.includes(secret), false);
    return { cookie: setCookie.split(';')[0], csrf: auth.csrf, payload: auth };
  }
  try {
    Object.assign(process.env, env);
    Object.defineProperty(globalThis, 'LEARNING_KV', { configurable: true, value: kv });
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { subtle, getRandomValues: originalCrypto.getRandomValues.bind(originalCrypto) } });
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: async () => { forbiddenFetchCalls++; throw Error('No server subrequests allowed'); } });
    const first = await login();
    const session = await edgeRequest('/api/session', first);
    assert.equal(session.status, 200);
    assert.deepEqual(await session.json(), first.payload);
    const actor = 'c'.repeat(32), fields = { w001: { value: 'learned', clock: 1, actor } };
    const saved = await edgeRequest('/api/progress', { ...first, method: 'POST', data: { writer: actor, sequence: 1, fields } });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).ok, true);
    const second = await login();
    const synced = await edgeRequest('/api/progress', second);
    assert.equal(synced.status, 200);
    assert.deepEqual((await synced.json()).fields, fields);
    const legacy = await edgeRequest('/api/login', { method: 'POST', data: { username: env.ACCOUNT_USERNAME, password } });
    assert.equal(legacy.status, 410, 'deployed Edge wrapper must explicitly disable its legacy password path');
    assert.equal(legacy.headers.get('set-cookie'), null);
    assert.equal(forbiddenPbkdf2Calls, 0);
    assert.equal(forbiddenFetchCalls, 0);
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
