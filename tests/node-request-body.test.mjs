import test from 'node:test';
import assert from 'node:assert/strict';
import { pbkdf2Sync } from 'node:crypto';
import { Readable } from 'node:stream';
import { handleVerification, passwordVerifierToken } from '../server/node-password-verifier.js';

const password = 'facade-pass-752';
const salt = '71'.repeat(16);
const env = {
  ACCOUNT_USERNAME: 'facadechild',
  ACCOUNT_PASSWORD_SALT: salt,
  ACCOUNT_PASSWORD_HASH: pbkdf2Sync(password, Buffer.from(salt, 'hex'), 120000, 32, 'sha256').toString('hex'),
  SESSION_SECRET: '83'.repeat(32)
};
const authorization = 'Bearer ' + passwordVerifierToken(env.SESSION_SECRET);
function facade({ raw = JSON.stringify({ username: env.ACCOUNT_USERNAME, password }), auth = authorization, contentType = 'application/json', length, method = 'POST', parse } = {}) {
  let reads = 0;
  const request = {
    method,
    headers: new Headers({ 'Content-Type': contentType, ...(auth === null ? {} : { Authorization: auth }), ...(length === undefined ? {} : { 'Content-Length': String(length) }) }),
    body: Readable.from([raw]),
    async json() { reads++; return parse ? parse() : JSON.parse(raw); }
  };
  return { request, reads: () => reads };
}
async function quiet(action) {
  const logs = [], previous = console.error;
  console.error = value => logs.push(String(value));
  try { return { response: await action(), logs }; }
  finally { console.error = previous; }
}

test('CloudRequest JSON facade with a Node stream body verifies native passwords', async () => {
  const correct = facade();
  assert.equal(typeof correct.request.body.getReader, 'undefined');
  assert.equal(typeof correct.request.text, 'undefined');
  assert.equal(typeof correct.request.arrayBuffer, 'undefined');
  const response = await handleVerification(correct.request, env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { valid: true });
  assert.equal(correct.reads(), 1);
  const wrong = facade({ raw: JSON.stringify({ username: env.ACCOUNT_USERNAME, password: 'wrong-pass' }) });
  assert.deepEqual(await (await handleVerification(wrong.request, env)).json(), { valid: false });
});

test('Node verifier does not inspect the CloudRequest body property', async () => {
  const input = facade();
  Object.defineProperty(input.request, 'body', { get() { throw Error('Body stream is not a Web stream'); } });
  const response = await handleVerification(input.request, env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { valid: true });
});

test('CloudRequest content length and decoded UTF-8 size are bounded before PBKDF2', async () => {
  let calls = 0;
  const options = { derivePassword() { calls++; throw Error('Must not derive'); } };
  const declared = facade({ length: 1025 });
  const encoded = facade({ raw: JSON.stringify({ note: '词'.repeat(400) }) });
  for (const input of [declared, encoded]) {
    const { response } = await quiet(() => handleVerification(input.request, env, options));
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'NODE_PASSWORD_REQUEST');
  }
  assert.equal(declared.reads(), 0);
  assert.equal(encoded.reads(), 1);
  assert.equal(calls, 0);
});

test('malformed or non-object CloudRequest JSON maps to the safe request code', async () => {
  let calls = 0;
  for (const raw of ['{', '', 'null', '[]', '"text"', '1']) {
    const { response } = await quiet(() => handleVerification(facade({ raw }).request, env, { derivePassword() { calls++; } }));
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'NODE_PASSWORD_REQUEST');
  }
  const plain = facade({ contentType: 'text/plain' });
  const { response } = await quiet(() => handleVerification(plain.request, env));
  assert.equal((await response.json()).code, 'NODE_PASSWORD_REQUEST');
  assert.equal(plain.reads(), 0);
  assert.equal(calls, 0);
});

test('CloudRequest token authentication happens before parsing or password derivation', async () => {
  let calls = 0;
  for (const auth of [null, 'Bearer ' + '00'.repeat(32), 'Bearer short']) {
    const input = facade({ auth, parse() { throw Error('Must not parse'); } });
    Object.defineProperty(input.request, 'body', { get() { throw Error('Must not access stream'); } });
    const { response, logs } = await quiet(() => handleVerification(input.request, env, { derivePassword() { calls++; } }));
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'Not found' });
    assert.equal(input.reads(), 0);
    assert.deepEqual(logs, []);
  }
  assert.equal(calls, 0);
});

test('CloudRequest parsing exceptions disclose only fixed diagnostics', async () => {
  const privateValue = 'do-not-log-raw-parse-details';
  const input = facade({ parse() { throw Error(privateValue); } });
  const { response, logs } = await quiet(() => handleVerification(input.request, env));
  assert.equal(response.status, 503);
  const text = await response.text();
  assert.equal(JSON.parse(text).code, 'NODE_PASSWORD_REQUEST');
  assert.equal((text + logs.join('')).includes(privateValue), false);
  assert.deepEqual(logs.map(JSON.parse), [{ event: 'learning_password_verifier_failure', code: 'NODE_PASSWORD_REQUEST' }]);
});
