import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, pbkdf2Sync } from 'node:crypto';
import { handle } from '../server/learning-api.js';
import { handleLogin } from '../server/node-login.js';

// Entirely synthetic credentials. The test never reads account files or calls a network.
const password = 'direct-browser-test-927';
const env = {
  ACCOUNT_USERNAME: 'testchild', ACCOUNT_PASSWORD_SALT: 'ac'.repeat(16),
  ACCOUNT_PASSWORD_HASH: pbkdf2Sync(password, Buffer.from('ac'.repeat(16), 'hex'), 120000, 32, 'sha256').toString('hex'),
  SESSION_SECRET: 'dc'.repeat(32)
};
const origin = 'https://learn.example';
const now = Date.parse('2026-10-09T12:00:00Z');
const ticketDomain = 'learning-station:login-ticket:v1\n';
const proofDomain = 'learning-station:login-proof:v1\n';
const actorA = 'a'.repeat(32), actorB = 'b'.repeat(32);
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
const post = (route, data, options = {}) => request(route, { ...options, method: 'POST', data });
function edge(request, kv, context = {}) {
  return handle(request, env, kv, { now, clientIp: '192.0.2.31', allowLegacyLogin: false, ...context });
}
function signature(message) { return createHmac('sha256', Buffer.from(env.SESSION_SECRET, 'hex')).update(message, 'utf8').digest('hex'); }
function independentlySignedTicket(input, payload = { nonce: '65'.repeat(16), exp: Math.floor(now / 1000) + 60 }) {
  const value = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  return value + '.' + signature(ticketDomain + value + '\n' + JSON.stringify([input.username.trim().toLowerCase(), input.password]));
}
function independentlySignedProof(payload) {
  const value = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  return value + '.' + signature(proofDomain + value);
}
function readToken(token) {
  assert.equal(typeof token, 'string');
  const parts = token.split('.');
  assert.equal(parts.length, 2);
  assert.match(parts[1], /^[a-f0-9]{64}$/);
  return { value: parts[0], signature: parts[1], payload: JSON.parse(Buffer.from(parts[0], 'base64').toString('utf8')) };
}
function noSecrets(output) {
  const text = JSON.stringify(output);
  for (const value of [password, env.ACCOUNT_PASSWORD_SALT, env.ACCOUNT_PASSWORD_HASH, env.SESSION_SECRET, 'private-error-value']) {
    assert.equal(text.includes(value), false, 'public responses and diagnostic logs must not contain credentials or raw failures');
  }
}
async function noEdgePasswordOrSubrequest(run) {
  const descriptors = Object.fromEntries(['crypto', 'fetch'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const originalCrypto = globalThis.crypto, originalError = console.error;
  let pbkdf2Calls = 0, fetchCalls = 0;
  const logs = [];
  const subtle = new Proxy(originalCrypto.subtle, { get(target, property) {
    const fn = Reflect.get(target, property, target);
    if (typeof fn !== 'function') return fn;
    return (...args) => {
      const algorithm = property === 'importKey' ? args[2] : args[0];
      if (['importKey', 'deriveBits', 'deriveKey'].includes(property) && (typeof algorithm === 'string' ? algorithm : algorithm?.name) === 'PBKDF2') {
        pbkdf2Calls++;
        throw new DOMException('PBKDF2 unavailable in Edge', 'NotSupportedError');
      }
      return fn.apply(target, args);
    };
  } });
  try {
    console.error = (...args) => logs.push(args);
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { subtle, getRandomValues: originalCrypto.getRandomValues.bind(originalCrypto) } });
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: async () => { fetchCalls++; throw Error('Edge same-host fetch is forbidden'); } });
    await run(logs);
    assert.equal(pbkdf2Calls, 0, 'Edge must not import or derive a password key');
    assert.equal(fetchCalls, 0, 'every login stage is a browser request, not an Edge subrequest');
    noSecrets(logs);
  } finally {
    console.error = originalError;
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}
async function getTicket(kv, input = { username: env.ACCOUNT_USERNAME, password }, context = {}) {
  const response = await edge(post('/api/login-ticket', input), kv, context);
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  const result = await response.json();
  assert.deepEqual(Object.keys(result), ['ticket']);
  const token = readToken(result.ticket);
  assert.equal(token.signature, signature(ticketDomain + token.value + '\n' + JSON.stringify([input.username.trim().toLowerCase(), input.password])));
  assert.match(token.payload.nonce, /^[a-f0-9]{32}$/);
  assert.equal(token.payload.exp, Math.floor((context.now ?? now) / 1000) + 60);
  noSecrets(result);
  return result.ticket;
}
async function login(kv, input = { username: env.ACCOUNT_USERNAME, password }, context = {}) {
  const ticket = await getTicket(kv, input, context);
  const verified = await handleLogin(post('/auth/login', { ...input, ticket }), env, { now: context.now ?? now });
  assert.equal(verified.status, 200, JSON.stringify(await verified.clone().json()));
  assert.equal(verified.headers.get('set-cookie'), null, 'Node may attest a login, but only Edge creates a session');
  assert.equal(verified.headers.get('cache-control'), 'private, no-store');
  const proofResult = await verified.json();
  assert.deepEqual(Object.keys(proofResult), ['proof']);
  const ticketPayload = readToken(ticket).payload, proof = readToken(proofResult.proof);
  assert.equal(proof.signature, signature(proofDomain + proof.value));
  assert.deepEqual(proof.payload, { sub: env.ACCOUNT_USERNAME, nonce: ticketPayload.nonce, exp: ticketPayload.exp });
  const result = await edge(post('/api/login-complete', proofResult), kv, context);
  assert.equal(result.status, 200, JSON.stringify(await result.clone().json()));
  const auth = await result.json(), setCookie = result.headers.get('set-cookie');
  assert.deepEqual(Object.keys(auth).sort(), ['csrf', 'expiresAt', 'username']);
  assert.match(setCookie, /__Host-learning_session=.*HttpOnly; SameSite=Strict; Max-Age=2592000; Secure/);
  noSecrets({ proofResult, auth, setCookie });
  return { result, payload: auth, cookie: setCookie.split(';')[0], csrf: auth.csrf, proof: proofResult.proof };
}

test('three direct browser login stages independently verify signatures, refresh and persist progress across devices', async () => {
  await noEdgePasswordOrSubrequest(async logs => {
    const kv = new KV(), first = await login(kv, { username: ' TESTCHILD ', password });
    const refreshed = await edge(request('/api/session', first), kv, { now: now + 3600000 });
    assert.equal(refreshed.status, 200);
    assert.deepEqual(await refreshed.json(), first.payload);
    const second = await login(kv);
    const fieldsA = { w001: { value: 'learned', clock: 1, actor: actorA }, position: { value: { lastDay: 4, lastIndex: 2 }, clock: 2, actor: actorA } };
    const fieldsB = { w002: { value: 'practice', clock: 3, actor: actorB } };
    for (const [auth, writer, fields] of [[first, actorA, fieldsA], [second, actorB, fieldsB]]) {
      const saved = await edge(post('/api/progress', { writer, sequence: 1, fields }, auth), kv);
      assert.equal(saved.status, 200);
      assert.equal((await saved.json()).ok, true);
    }
    for (const auth of [first, second]) {
      const read = await edge(request('/api/progress', auth), kv);
      assert.equal(read.status, 200);
      assert.deepEqual((await read.json()).fields, { ...fieldsA, ...fieldsB });
    }
    assert.equal((await edge(request('/api/session', first), kv, { now: now + 31 * 86400000 })).status, 401);
    assert.equal((await edge(request('/api/progress'), kv)).status, 401);
    assert.deepEqual(logs, []);
  });
});

test('wrong credentials never create sessions and tickets reserve a bounded attempt before Node password computation', async () => {
  await noEdgePasswordOrSubrequest(async logs => {
    const kv = new KV();
    for (let i = 0; i < 8; i++) {
      const input = i % 2 ? { username: 'wrongchild', password } : { username: env.ACCOUNT_USERNAME, password: 'wrong-password' };
      const ticket = await getTicket(kv, input);
      const rejected = await handleLogin(post('/auth/login', { ...input, ticket }), env, { now });
      assert.equal(rejected.status, 401);
      assert.equal(rejected.headers.get('set-cookie'), null);
      noSecrets(await rejected.json());
    }
    const blocked = await edge(post('/api/login-ticket', { username: env.ACCOUNT_USERNAME, password }), kv);
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers.get('retry-after'), '600');
    assert.equal(blocked.headers.get('set-cookie'), null);
    assert.equal([...kv.data.keys()].some(key => key.startsWith('progress_')), false);
    await login(kv, { username: env.ACCOUNT_USERNAME, password }, { now: now + 600001 });
    assert.deepEqual(logs, []);
  });
});

test('tickets bind the exact password and normalized username; malformed, expired and replay-modified tickets skip PBKDF2', async () => {
  await noEdgePasswordOrSubrequest(async logs => {
    const input = { username: env.ACCOUNT_USERNAME, password }, ticket = await getTicket(new KV(), input);
    let attempts = 0;
    const verifyCredentials = async () => { attempts++; throw Error('must not reach password derivation'); };
    const expired = independentlySignedTicket(input, { nonce: '65'.repeat(16), exp: Math.floor(now / 1000) });
    const tooLong = independentlySignedTicket(input, { nonce: '65'.repeat(16), exp: Math.floor(now / 1000) + 66 });
    const invalidNonce = independentlySignedTicket(input, { nonce: 'not-a-nonce', exp: Math.floor(now / 1000) + 60 });
    const cases = [
      { ...input, password: 'new-guess', ticket },
      { ...input, username: 'otherchild', ticket },
      ...['', 'invalid', ticket + '0', expired, tooLong, invalidNonce].map(ticket => ({ ...input, ticket }))
    ];
    for (const data of cases) {
      const rejected = await handleLogin(post('/auth/login', data), env, { now, verifyCredentials });
      assert.equal(rejected.status, 403);
      assert.equal(rejected.headers.get('set-cookie'), null);
      noSecrets(await rejected.json());
    }
    assert.equal(attempts, 0);
    assert.deepEqual(logs, []);
  });
});

test('only a current signed proof for the configured account can create an Edge session', async () => {
  await noEdgePasswordOrSubrequest(async logs => {
    const kv = new KV(), auth = await login(kv);
    const payload = readToken(auth.proof).payload;
    const badProofs = [
      '', 'invalid', auth.proof + '0',
      independentlySignedProof({ ...payload, sub: 'otherchild' }),
      independentlySignedProof({ ...payload, exp: Math.floor(now / 1000) }),
      independentlySignedProof({ ...payload, exp: Math.floor(now / 1000) + 66 }),
      independentlySignedProof({ ...payload, nonce: 'invalid' }),
      independentlySignedTicket({ username: env.ACCOUNT_USERNAME, password })
    ];
    for (const proof of badProofs) {
      const rejected = await edge(post('/api/login-complete', { proof }), kv);
      assert.equal(rejected.status, 401);
      assert.equal(rejected.headers.get('set-cookie'), null);
      noSecrets(await rejected.json());
    }
    const oldLogin = await edge(post('/api/login', { username: env.ACCOUNT_USERNAME, password }), kv);
    assert.equal(oldLogin.status, 410, 'production must not fall back to the broken Edge-to-Node subrequest');
    assert.equal(oldLogin.headers.get('set-cookie'), null);
    assert.deepEqual(logs, []);
  });
});

test('each login stage rejects cross-origin requests and remains cache private', async () => {
  await noEdgePasswordOrSubrequest(async logs => {
    const kv = new KV(), input = { username: env.ACCOUNT_USERNAME, password }, ticket = await getTicket(kv, input);
    const proof = independentlySignedProof({ sub: env.ACCOUNT_USERNAME, nonce: '65'.repeat(16), exp: Math.floor(now / 1000) + 60 });
    for (const requestOrigin of ['https://evil.example', 'null']) {
      const responses = [
        await edge(post('/api/login-ticket', input, { requestOrigin }), kv),
        await handleLogin(post('/auth/login', { ...input, ticket }, { requestOrigin }), env, { now }),
        await edge(post('/api/login-complete', { proof }, { requestOrigin }), kv)
      ];
      for (const rejected of responses) {
        assert.equal(rejected.status, 403);
        assert.equal(rejected.headers.get('set-cookie'), null);
        assert.equal(rejected.headers.get('cache-control'), 'private, no-store');
        noSecrets(await rejected.json());
      }
    }
    assert.deepEqual(logs, []);
  });
});

test('Node computation and Edge rate-store failures expose fixed codes and cannot acknowledge a login', async () => {
  await noEdgePasswordOrSubrequest(async logs => {
    const input = { username: env.ACCOUNT_USERNAME, password }, kv = new KV(), ticket = await getTicket(kv, input);
    const failed = await handleLogin(post('/auth/login', { ...input, ticket }), env, { now, verifyCredentials: async () => { throw Error('private-error-value ' + password + env.SESSION_SECRET); } });
    assert.equal(failed.status, 503);
    assert.equal(failed.headers.get('set-cookie'), null);
    const nodePayload = await failed.json();
    assert.match(nodePayload.code, /^NODE_/);
    kv.put = async () => { throw Error('private-error-value ' + env.ACCOUNT_PASSWORD_HASH); };
    const writeFailed = await edge(post('/api/login-ticket', input), kv);
    assert.equal(writeFailed.status, 503);
    assert.equal(writeFailed.headers.get('set-cookie'), null);
    const edgePayload = await writeFailed.json();
    assert.equal(edgePayload.code, 'LOGIN_RATE_WRITE');
    assert.equal(logs.length, 2);
    noSecrets({ nodePayload, edgePayload, logs });
  });
});
