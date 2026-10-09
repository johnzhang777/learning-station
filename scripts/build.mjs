import { mkdir, readFile, writeFile } from 'node:fs/promises';
// Direct uploads need the function directory and package.json in the output.
// Inline the server module so dist contains no private configuration or sources.
const core = await readFile(new URL('../server/learning-api.js', import.meta.url), 'utf8');
const wrapper = (await readFile(new URL('../edge-functions/api/[[route]].js', import.meta.url), 'utf8')).replace(/^import .*;\s*/m, '');
await mkdir(new URL('../dist/edge-functions/api/', import.meta.url), { recursive: true });
await writeFile(new URL('../dist/edge-functions/api/[[route]].js', import.meta.url), core + '\n' + wrapper);
await writeFile(new URL('../dist/package.json', import.meta.url), JSON.stringify({ private: true, type: 'module' }, null, 2) + '\n');
const { headers, caches } = JSON.parse(await readFile(new URL('../edgeone.json', import.meta.url), 'utf8'));
await writeFile(new URL('../dist/edgeone.json', import.meta.url), JSON.stringify({ headers, caches }, null, 2) + '\n');
console.log('EdgeOne frontend and Edge Functions prepared; secrets are runtime environment variables.');
