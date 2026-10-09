import { handleLogin } from '../../server/node-login.js';

export function onRequest({ request }) {
  // Use the same runtime environment source already verified on this project.
  return handleLogin(request, process.env);
}

export default onRequest;
