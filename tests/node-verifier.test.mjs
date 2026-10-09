import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, pbkdf2Sync } from 'node:crypto';
import { handleVerification, passwordVerifierToken } from '../server/node-password-verifier.js';
import defaultOnRequest, { onRequest } from '../cloud-functions/internal/verify-password.js';

const password = 'test-pass-729';
const salt = 'ab'.repeat(16);
const env = {
  ACCOUNT_USERNAME: 'testchild',
  ACCOUNT_PASSWORD_SALT: salt,
  ACCOUNT_PASSWORD_HASH: pbkdf2Sync(password, Buffer.from(salt, 'hex'), 120000, 32, 'sha256').toString('hex'),
  SESSION_SECRET: 'cd'.repeat(32)
};
const token = createHash('sha256').update('learning-station:password-verifier:v1\n' + env.SESSION_SECRET).digest('hex');
function request({ method = 'POST', authorization = 'Bearer ' + token, raw, data = { username: env.ACCOUNT_USERNAME, password }, contentType = 'application/json', length } = {}) {
  return new Request('https://learn.example/internal/verify-password', {
    method,
    headers: { ...(authorization === null ? {} : { Authorization: authorization }), 'Content-Type': contentType, ...(length ? { 'Content-Length': length } : {}) },
    ...(method === 'GET' || method === 'HEAD' ? {} : { body: raw ?? JSON.stringify(data) })
  });
}
async function quiet(action) {
  const messages = [];
  const original = console.error;
  console.error = message => messages.push(String(message));
  try { return { result: await action(), messages }; }
  finally { console.error = original; }
}
function assertPrivateResponse(response) {
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.equal(response.headers.get('vary'), 'Authorization');
  assert.equal(response.headers.get('set-cookie'), null);
}
function unreadableRequest(authorization, method = 'POST') {
  return { method, headers: new Headers(authorization === null ? {} : { Authorization: authorization }), get body() { throw Error('Credentials must not be read'); } };
}

test('Node verifier uses the independent PBKDF2 verifier and only returns a boolean', async () => {
  assert.equal(passwordVerifierToken(env.SESSION_SECRET), token);
  for (const [username, suppliedPassword, expected] of [
    [' TestChild ', password, true],
    [env.ACCOUNT_USERNAME, 'wrong-pass', false],
    ['differentchild', password, false],
    [env.ACCOUNT_USERNAME, '', false]
  ]) {
    const res = await handleVerification(request({ data: { username, password: suppliedPassword } }), env);
    assert.equal(res.status, 200);
    assertPrivateResponse(res);
    assert.deepEqual(await res.json(), { valid: expected });
  }
});

test('unauthenticated and incorrect internal tokens fail before body access or PBKDF2', async () => {
  let calls = 0;
  const options = { derivePassword: () => { calls++; throw Error('PBKDF2 must not execute'); } };
  for (const [authorization, method] of [[null, 'POST'], ['Bearer ' + '00'.repeat(32), 'POST'], ['Bearer ' + env.SESSION_SECRET, 'POST'], ['Bearer short', 'POST'], ['Basic ' + token, 'POST'], ['Bearer ' + token, 'GET']]) {
    const { result: res, messages } = await quiet(() => handleVerification(unreadableRequest(authorization, method), env, options));
    assert.equal(res.status, 404);
    assertPrivateResponse(res);
    assert.deepEqual(await res.json(), { error: 'Not found' });
    assert.deepEqual(messages, []);
  }
  assert.equal(calls, 0);
});

test('missing or malformed environment values fail closed without password calculation', async () => {
  let calls = 0;
  for (const name of Object.keys(env)) {
    for (const value of ['', 'invalid-value']) {
      const badEnv = { ...env, [name]: value };
      const { result: res, messages } = await quiet(() => handleVerification(request(), badEnv, { derivePassword: () => { calls++; return Buffer.alloc(32); } }));
      assert.equal(res.status, 503, name);
      assert.equal((await res.json()).code, 'NODE_PASSWORD_CONFIG');
      assert.deepEqual(messages.map(JSON.parse), [{ event: 'learning_password_verifier_failure', code: 'NODE_PASSWORD_CONFIG' }]);
    }
  }
  assert.equal(calls, 0);
});

test('malformed JSON and non-object bodies do not reach PBKDF2', async () => {
  let calls = 0;
  for (const raw of ['{', 'null', '[]', '"text"']) {
    const { result: res } = await quiet(() => handleVerification(request({ raw }), env, { derivePassword: () => { calls++; return Buffer.alloc(32); } }));
    assert.equal(res.status, 503);
    assert.equal((await res.json()).code, 'NODE_PASSWORD_REQUEST');
  }
  for (const contentType of ['text/plain', 'application/jsonp']) {
    const { result: res } = await quiet(() => handleVerification(request({ contentType }), env));
    assert.equal(res.status, 503);
    assert.equal((await res.json()).code, 'NODE_PASSWORD_REQUEST');
  }
  assert.equal(calls, 0);
});

test('body size limits count bytes and cancel overflowing streams', async () => {
  const requests = [request({ raw: ' '.repeat(1025) }), request({ raw: JSON.stringify({ note: '词'.repeat(400) }) }), request({ length: '1025' })];
  for (const input of requests) {
    const { result: res } = await quiet(() => handleVerification(input, env));
    assert.equal(res.status, 503);
    assert.equal((await res.json()).code, 'NODE_PASSWORD_REQUEST');
  }
  let reads = 0, cancelled = false, calls = 0;
  const input = request();
  Object.defineProperty(input, 'body', { value: { getReader: () => ({
    async read() { reads++; return { done: false, value: new Uint8Array(600) }; },
    async cancel() { cancelled = true; },
    releaseLock() {}
  }) } });
  const { result: res } = await quiet(() => handleVerification(input, env, { derivePassword: () => { calls++; return Buffer.alloc(32); } }));
  assert.equal(res.status, 503);
  assert.equal(reads, 2);
  assert.equal(cancelled, true);
  assert.equal(calls, 0);
});

test('invalid credential field lengths and types return false without PBKDF2', async () => {
  let calls = 0;
  for (const data of [{}, { username: 1, password }, { username: env.ACCOUNT_USERNAME, password: 1 }, { username: 'a'.repeat(41), password }, { username: env.ACCOUNT_USERNAME, password: 'x'.repeat(129) }]) {
    const res = await handleVerification(request({ data }), env, { derivePassword: () => { calls++; return Buffer.alloc(32); } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { valid: false });
  }
  assert.equal(calls, 0);
});

test('native failures disclose neither credentials, service tokens nor verifier secrets', async () => {
  const sensitive = [password, env.ACCOUNT_PASSWORD_HASH, env.ACCOUNT_PASSWORD_SALT, env.SESSION_SECRET, token];
  const { result: res, messages } = await quiet(() => handleVerification(request(), env, { derivePassword: () => { throw Error(sensitive.join(' ')); } }));
  assert.equal(res.status, 503);
  assertPrivateResponse(res);
  const body = await res.text();
  assert.equal(JSON.parse(body).code, 'NODE_PASSWORD_DERIVE');
  assert.deepEqual(messages.map(JSON.parse), [{ event: 'learning_password_verifier_failure', code: 'NODE_PASSWORD_DERIVE' }]);
  for (const value of sensitive) assert.equal((body + messages.join('')).includes(value), false);
  const { result: invalid } = await quiet(() => handleVerification(request(), env, { derivePassword: async () => new Uint8Array(31) }));
  assert.equal((await invalid.json()).code, 'NODE_PASSWORD_DERIVE');
});

test('Cloud Functions onRequest reads configured process.env and uses the native verifier', async () => {
  assert.equal(defaultOnRequest, onRequest);
  const previous = Object.fromEntries(Object.keys(env).map(name => [name, process.env[name]]));
  try {
    for (const [name, value] of Object.entries(env)) process.env[name] = value;
    const res = await onRequest({ request: request(), env: {} });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { valid: true });
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
