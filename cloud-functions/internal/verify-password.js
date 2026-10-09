import { handleVerification } from '../../server/node-password-verifier.js';

export function onRequest({ request }) {
  return handleVerification(request, process.env);
}

export default onRequest;
