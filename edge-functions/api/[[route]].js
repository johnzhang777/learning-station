import { handle } from '../../server/learning-api.js';

export function onRequest({ request, env, clientIp }) {
  // KV and session signing remain in Edge; the browser calls Node directly.
  const kv = typeof LEARNING_KV !== 'undefined' ? LEARNING_KV : undefined;
  return handle(request, env, kv, { clientIp, allowLegacyLogin: false });
}
