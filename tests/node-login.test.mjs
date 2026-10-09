import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, pbkdf2Sync } from 'node:crypto';
import { handleLogin } from '../server/node-login.js';
import { verifyCredentials } from '../server/node-password-verifier.js';
import defaultOnRequest, { onRequest } from '../cloud-functions/auth/login.js';

const password = 'test-pass-729';
const now = 1800000000000;
const nonce = 'ab'.repeat(16);
const env = {
  ACCOUNT_USERNAME: 'testchild',
  ACCOUNT_PASSWORD_SALT: 'bc'.repeat(16),
  ACCOUNT_PASSWORD_HASH: pbkdf2Sync(password, Buffer.from('bc'.repeat(16), 'hex'), 120000, 32, 'sha256').toString('hex'),
  SESSION_SECRET: 'cd'.repeat(32)
};
const hmac = value => createHmac('sha256', Buffer.from(env.SESSION_SECRET, 'hex')).update(value, 'utf8').digest('hex');
function ticket(username = env.ACCOUNT_USERNAME, suppliedPassword = password, payload = { nonce, exp: Math.floor(now / 1000) + 60 }, domain = 'learning-station:login-ticket:v1\n') {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64');
  return encoded + '.' + hmac(domain + encoded + '\n' + JSON.stringify([username.trim().toLowerCase(), suppliedPassword]));
}
function request({ data = { username: env.ACCOUNT_USERNAME, password, ticket: ticket() }, raw, method = 'POST', url = 'https://learn.example/auth/login', origin = new URL(url).origin, type = 'application/json', length, site } = {}) {
  return new Request(url, {
    method,
    headers: { ...(origin === null ? {} : { Origin: origin }), 'Content-Type': type, ...(length ? { 'Content-Length': String(length) } : {}), ...(site ? { 'Sec-Fetch-Site': site } : {}) },
    ...(['GET', 'HEAD'].includes(method) ? {} : { body: raw ?? JSON.stringify(data) })
  });
}
async function quiet(action) {
  const messages = [];
  const original = console.error;
  console.error = message => messages.push(String(message));
  try { return { result: await action(), messages }; }
  finally { console.error = original; }
}
function privateResponse(response) {
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
}

test('direct Node login verifies native PBKDF2 and returns an independently verifiable short-lived proof', async () => {
  assert.equal(await verifyCredentials({ username: ' TestChild ', password }, env), true);
  const response = await handleLogin(request({ data: { username: ' TestChild ', password, ticket: ticket(' TestChild ') } }), env, { now });
  assert.equal(response.status, 200);
  privateResponse(response);
  const body = await response.json();
  assert.deepEqual(Object.keys(body), ['proof']);
  const [payload, signature] = body.proof.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64').toString('utf8')), { sub: env.ACCOUNT_USERNAME, nonce, exp: now / 1000 + 60 });
  assert.equal(signature, hmac('learning-station:login-proof:v1\n' + payload));
  for (const value of [password, env.ACCOUNT_PASSWORD_SALT, env.ACCOUNT_PASSWORD_HASH, env.SESSION_SECRET]) assert.equal(JSON.stringify(body).includes(value), false);
});

test('tickets bind one credential attempt; changing password or username fails before calculation', async () => {
  let calls = 0;
  const verify = () => { calls++; return true; };
  const originalTicket = ticket();
  const changedSignature = originalTicket.slice(0, -1) + (originalTicket.endsWith('0') ? '1' : '0');
  for (const data of [
    { username: env.ACCOUNT_USERNAME, password: 'different-pass', ticket: ticket() },
    { username: 'anotherchild', password, ticket: ticket() },
    { username: env.ACCOUNT_USERNAME, password, ticket: changedSignature },
    { username: env.ACCOUNT_USERNAME, password, ticket: ticket(undefined, undefined, undefined, 'other-domain\n') }
  ]) {
    const res = await handleLogin(request({ data }), env, { now, verifyCredentials: verify });
    assert.equal(res.status, 403);
    privateResponse(res);
  }
  assert.equal(calls, 0);
});

test('missing, expired, overlong and malformed tickets are rejected before verification', async () => {
  let calls = 0;
  const verify = () => { calls++; return true; };
  for (const suppliedTicket of [
    undefined, '', 'x'.repeat(513), 'not-a-ticket', 'e30=.bad', ticket() + '.extra',
    ticket(undefined, undefined, { nonce, exp: now / 1000 }),
    ticket(undefined, undefined, { nonce, exp: now / 1000 - 1 }),
    ticket(undefined, undefined, { nonce, exp: now / 1000 + 66 }),
    ticket(undefined, undefined, { nonce: 'bad', exp: now / 1000 + 60 }),
    ticket(undefined, undefined, { nonce, exp: now / 1000 + 60, additional: true }),
    ticket(undefined, undefined, { nonce, exp: String(now / 1000 + 60) })
  ]) {
    const res = await handleLogin(request({ data: { username: env.ACCOUNT_USERNAME, password, ticket: suppliedTicket } }), env, { now, verifyCredentials: verify });
    assert.equal(res.status, 403);
  }
  assert.equal(calls, 0);
  const allowedClockSkew = await handleLogin(request({ data: { username: env.ACCOUNT_USERNAME, password, ticket: ticket(undefined, undefined, { nonce, exp: now / 1000 + 65 }) } }), env, { now, verifyCredentials: verify });
  assert.equal(allowedClockSkew.status, 200);
  assert.equal(calls, 1);
});

test('wrong credentials with a genuine rate-limited ticket return 401 without a proof or cookie', async () => {
  for (const [username, suppliedPassword] of [[env.ACCOUNT_USERNAME, 'wrong-pass'], ['anotherchild', password]]) {
    const res = await handleLogin(request({ data: { username, password: suppliedPassword, ticket: ticket(username, suppliedPassword) } }), env, { now });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: '姓名拼音或验证码不正确。' });
    privateResponse(res);
  }
});

test('Node login enforces same-origin and HTTPS before reading credentials', async () => {
  let reads = 0;
  let calculations = 0;
  for (const [options, status] of [[{ origin: null }, 403], [{ origin: 'https://other.example' }, 403], [{ site: 'cross-site' }, 403], [{ url: 'http://learn.example/auth/login' }, 400]]) {
    const req = request(options);
    Object.defineProperty(req, 'json', { value: async () => { reads++; throw Error('Do not read'); } });
    const res = await handleLogin(req, env, { now, verifyCredentials: () => { calculations++; return true; } });
    assert.equal(res.status, status);
  }
  assert.equal(reads, 0);
  assert.equal(calculations, 0);
  const local = await handleLogin(request({ url: 'http://localhost:8767/auth/login' }), env, { now, verifyCredentials: () => true });
  assert.equal(local.status, 200);
});

test('documented request.json() parsing supports Cloud requests without Web streams', async () => {
  const req = {
    method: 'POST', url: 'https://learn.example/auth/login',
    headers: new Headers({ Origin: 'https://learn.example', 'Content-Type': 'application/json' }),
    get body() { throw Error('No Web stream is available'); },
    json: async () => ({ username: env.ACCOUNT_USERNAME, password, ticket: ticket() })
  };
  const res = await handleLogin(req, env, { now, verifyCredentials: () => true });
  assert.equal(res.status, 200);
});

test('invalid JSON, content types and UTF-8 body sizes cannot trigger password calculation', async () => {
  let calls = 0;
  for (const [options, status] of [[{ raw: '{' }, 400], [{ raw: 'null' }, 400], [{ raw: '[]' }, 400], [{ type: 'text/plain' }, 415], [{ type: 'application/jsonp' }, 415], [{ data: { username: env.ACCOUNT_USERNAME, password, ticket: ticket(), note: '词'.repeat(700) } }, 413]]) {
    const res = await handleLogin(request(options), env, { now, verifyCredentials: () => { calls++; return true; } });
    assert.equal(res.status, status);
  }
  let reads = 0;
  const req = request({ length: 2049 });
  Object.defineProperty(req, 'json', { value: async () => { reads++; throw Error('Oversize'); } });
  assert.equal((await handleLogin(req, env, { now })).status, 413);
  assert.equal(reads, 0);
  assert.equal(calls, 0);
});

test('invalid credential fields fail before ticket validation or password calculation', async () => {
  let calls = 0;
  for (const data of [{ password, ticket: ticket() }, { username: 1, password, ticket: ticket() }, { username: env.ACCOUNT_USERNAME, password: 1, ticket: ticket() }, { username: 'x'.repeat(41), password, ticket: ticket() }, { username: env.ACCOUNT_USERNAME, password: 'x'.repeat(129), ticket: ticket() }]) {
    const res = await handleLogin(request({ data }), env, { now, verifyCredentials: () => { calls++; return true; } });
    assert.equal(res.status, 401);
  }
  assert.equal(calls, 0);
});

test('config and calculation failures disclose fixed labels without credentials or secrets', async () => {
  const sensitive = [password, ticket(), env.ACCOUNT_PASSWORD_HASH, env.ACCOUNT_PASSWORD_SALT, env.SESSION_SECRET];
  for (const [options, badEnv, code] of [
    [{ now, verifyCredentials: () => { throw Error(sensitive.join(' ')); } }, env, 'NODE_LOGIN_PASSWORD'],
    [{ now, verifyCredentials: () => undefined }, env, 'NODE_LOGIN_PASSWORD'],
    [{ now }, { ...env, SESSION_SECRET: '' }, 'NODE_LOGIN_CONFIG']
  ]) {
    const { result, messages } = await quiet(() => handleLogin(request(), badEnv, options));
    assert.equal(result.status, 503);
    privateResponse(result);
    const body = await result.text();
    assert.equal(JSON.parse(body).code, code);
    assert.deepEqual(messages.map(JSON.parse), [{ event: 'learning_node_login_failure', code }]);
    for (const value of sensitive) assert.equal((body + messages.join('')).includes(value), false);
  }
});

test('Cloud login wrapper uses process.env despite empty SDK env and aliases default and named handlers', async () => {
  assert.equal(defaultOnRequest, onRequest);
  const liveNow = Date.now();
  const currentTicket = ticket(undefined, undefined, { nonce, exp: Math.floor(liveNow / 1000) + 60 });
  const previous = Object.fromEntries(Object.keys(env).map(name => [name, process.env[name]]));
  try {
    for (const [name, value] of Object.entries(env)) process.env[name] = value;
    const res = await onRequest({ request: request({ data: { username: env.ACCOUNT_USERNAME, password, ticket: currentTicket } }), env: {} });
    assert.equal(res.status, 200);
    assert.equal(typeof (await res.json()).proof, 'string');
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  for (const options of [{ method: 'GET' }, { url: 'https://learn.example/auth/other' }]) {
    assert.equal((await handleLogin(request(options), undefined)).status, 404);
  }
});
