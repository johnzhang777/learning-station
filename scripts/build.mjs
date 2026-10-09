import { mkdir, readFile, writeFile } from 'node:fs/promises';
// Direct uploads need the function directory and package.json in the output.
// Inline the server module so dist contains no private configuration or sources.
const core = await readFile(new URL('../server/learning-api.js', import.meta.url), 'utf8');
const wrapper = (await readFile(new URL('../edge-functions/api/[[route]].js', import.meta.url), 'utf8')).replace(/^import .*;\s*/m, '');
await mkdir(new URL('../dist/edge-functions/api/', import.meta.url), { recursive: true });
await writeFile(new URL('../dist/edge-functions/api/[[route]].js', import.meta.url), core + '\n' + wrapper);
const verifier = await readFile(new URL('../server/node-password-verifier.js', import.meta.url), 'utf8');
const verifierWrapper = (await readFile(new URL('../cloud-functions/internal/verify-password.js', import.meta.url), 'utf8')).replace(/^import .*;\s*/m, '');
await mkdir(new URL('../dist/cloud-functions/internal/', import.meta.url), { recursive: true });
await writeFile(new URL('../dist/cloud-functions/internal/verify-password.js', import.meta.url), verifier + '\n' + verifierWrapper);
const verifierImports = verifier.match(/^import .+;$/gm).join('\n');
const verifierBody = verifier.replace(/^import .*;\s*/gm, '').replace(/^export /gm, '');
const login = (await readFile(new URL('../server/node-login.js', import.meta.url), 'utf8')).replace(/^import .* from ['"]\.\/node-password-verifier\.js['"];\s*/m, 'const { verifyCredentials } = __passwordVerifier;\n');
const loginWrapper = (await readFile(new URL('../cloud-functions/auth/login.js', import.meta.url), 'utf8')).replace(/^import .*;\s*/m, '');
await mkdir(new URL('../dist/cloud-functions/auth/', import.meta.url), { recursive: true });
await writeFile(new URL('../dist/cloud-functions/auth/login.js', import.meta.url), verifierImports + '\nconst __passwordVerifier = (() => {\n' + verifierBody + '\nreturn { verifyCredentials };\n})();\n' + login + '\n' + loginWrapper);
await writeFile(new URL('../dist/package.json', import.meta.url), JSON.stringify({ private: true, type: 'module' }, null, 2) + '\n');
const { headers, caches, cloudFunctions } = JSON.parse(await readFile(new URL('../edgeone.json', import.meta.url), 'utf8'));
await writeFile(new URL('../dist/edgeone.json', import.meta.url), JSON.stringify({ headers, caches, cloudFunctions }, null, 2) + '\n');
console.log('EdgeOne frontend, Edge Functions and Node password verifier prepared; secrets are runtime environment variables.');
