import { handle, verifyWithNode } from '../../server/learning-api.js';

export function onRequest({ request, env, clientIp }) {
  // Bind the Pages KV namespace with this exact variable name.
  const kv = typeof LEARNING_KV !== 'undefined' ? LEARNING_KV : undefined;
  return handle(request, env, kv, { clientIp, verifyPassword: input => verifyWithNode(request, env, input) });
}
