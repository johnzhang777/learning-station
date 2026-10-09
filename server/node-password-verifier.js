import { createHash, pbkdf2, timingSafeEqual } from 'node:crypto';

const LIMIT = 1024;
const ITERATIONS = 120000;
const encoder = new TextEncoder();
const headers = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'private, no-store',
  'Vary': 'Authorization',
  'X-Content-Type-Options': 'nosniff'
};
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers });
const codes = new Set(['NODE_PASSWORD_CONFIG', 'NODE_PASSWORD_REQUEST', 'NODE_PASSWORD_DERIVE', 'NODE_PASSWORD_INTERNAL']);
const failure = code => { throw Object.assign(new Error('Password verifier unavailable'), { code }); };
const equal = (a, b) => a.byteLength === b.byteLength && timingSafeEqual(a, b);

// Isolate the internal service credential from the session signing key.
export function passwordVerifierToken(secret) {
  return createHash('sha256').update('learning-station:password-verifier:v1\n' + secret, 'utf8').digest('hex');
}

function derivePassword(password, salt) {
  return new Promise((resolve, reject) => {
    pbkdf2(password, Buffer.from(salt, 'hex'), ITERATIONS, 32, 'sha256', (error, bytes) => {
      if (error) reject(error);
      else resolve(bytes);
    });
  });
}

async function readInput(request) {
  if ((request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() !== 'application/json' || Number(request.headers.get('content-length')) > LIMIT) failure('NODE_PASSWORD_REQUEST');
  const reader = request.body?.getReader();
  if (!reader) failure('NODE_PASSWORD_REQUEST');
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      let bytes;
      if (typeof value === 'string') bytes = encoder.encode(value);
      else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
      else if (ArrayBuffer.isView(value)) bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      else failure('NODE_PASSWORD_REQUEST');
      size += bytes.byteLength;
      if (size > LIMIT) {
        await reader.cancel();
        failure('NODE_PASSWORD_REQUEST');
      }
      chunks.push(bytes);
    }
  } catch {
    failure('NODE_PASSWORD_REQUEST');
  } finally {
    reader.releaseLock?.();
  }
  const data = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let input;
  try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)); }
  catch { failure('NODE_PASSWORD_REQUEST'); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) failure('NODE_PASSWORD_REQUEST');
  return input;
}

export async function handleVerification(request, env, { derivePassword: derive = derivePassword } = {}) {
  try {
    // Authenticate the server caller before reading credentials or doing PBKDF2.
    const auth = request.headers.get('authorization') || '';
    if (request.method !== 'POST' || !/^Bearer [a-f0-9]{64}$/.test(auth)) return json({ error: 'Not found' }, 404);
    if (!/^[a-f0-9]{64}$/.test(env?.SESSION_SECRET || '')) failure('NODE_PASSWORD_CONFIG');
    const token = auth.slice(7);
    if (!equal(Buffer.from(token, 'hex'), Buffer.from(passwordVerifierToken(env.SESSION_SECRET), 'hex'))) return json({ error: 'Not found' }, 404);
    if (!/^[a-z]{2,40}$/.test(env.ACCOUNT_USERNAME || '') || !/^[a-f0-9]{32}$/.test(env.ACCOUNT_PASSWORD_SALT || '') || !/^[a-f0-9]{64}$/.test(env.ACCOUNT_PASSWORD_HASH || '')) failure('NODE_PASSWORD_CONFIG');

    const input = await readInput(request);
    if (typeof input.username !== 'string' || typeof input.password !== 'string' || input.username.length > 40 || input.password.length > 128) return json({ valid: false });
    let bytes;
    try { bytes = await derive(input.password, env.ACCOUNT_PASSWORD_SALT); }
    catch { failure('NODE_PASSWORD_DERIVE'); }
    if (!ArrayBuffer.isView(bytes) || bytes.byteLength !== 32) failure('NODE_PASSWORD_DERIVE');
    const actual = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const userMatches = equal(Buffer.from(input.username.trim().toLowerCase(), 'utf8'), Buffer.from(env.ACCOUNT_USERNAME, 'utf8'));
    const hashMatches = equal(actual, Buffer.from(env.ACCOUNT_PASSWORD_HASH, 'hex'));
    return json({ valid: userMatches && hashMatches });
  } catch (error) {
    const code = codes.has(error?.code) ? error.code : 'NODE_PASSWORD_INTERNAL';
    // Never include native errors, inputs, tokens, verifier values or secrets.
    console.error(JSON.stringify({ event: 'learning_password_verifier_failure', code }));
    return json({ error: '云端暂时无法连接，请稍后重试。', code }, 503);
  }
}
