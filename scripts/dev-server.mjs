import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handle, verifyWithNode } from '../server/learning-api.js';
import { handleVerification } from '../server/node-password-verifier.js';
const root = fileURLToPath(new URL('../', import.meta.url));
const port = Number(process.argv[2]) || 8767;
const env = JSON.parse(await readFile(path.join(root, '.private/account.json'), 'utf8'));
const folder = path.join(root, '.private/kv'); await mkdir(folder, { recursive: true });
const { readdir, rename } = await import('node:fs/promises');
const kv = {
  async get(key) { try { return await readFile(path.join(folder, key + '.json'), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } },
  async put(key, value) { const target = path.join(folder, key + '.json'), tmp = target + '.' + crypto.randomUUID() + '.tmp'; await writeFile(tmp, value); await rename(tmp, target); },
  async list({ prefix, cursor, limit }) { const all = (await readdir(folder)).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).filter(k => k.startsWith(prefix) && (!cursor || k >= cursor)).sort(); const keys = all.slice(0, limit).map(key => ({ key })); return { keys, complete: all.length <= limit, cursor: all[limit] || null }; }
};
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.mp3': 'audio/mpeg', '.webmanifest': 'application/manifest+json' };
http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || `127.0.0.1:${port}`}`);
    if (url.pathname.startsWith('/api/') || url.pathname === '/internal/verify-password') {
      const chunks = []; for await (const c of req) chunks.push(c);
      const request = new Request(url, { method: req.method, headers: req.headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
      Object.defineProperty(request, 'eo', { value: { clientIp: req.socket.remoteAddress } });
      const result = url.pathname === '/internal/verify-password'
        ? await handleVerification(request, env)
        : await handle(request, env, kv, { verifyPassword: input => verifyWithNode(request, env, input) });
      res.writeHead(result.status, Object.fromEntries(result.headers)); res.end(Buffer.from(await result.arrayBuffer())); return;
    }
    const relative = decodeURIComponent(url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
    const file = path.resolve(root, 'dist', relative);
    if (!file.startsWith(path.join(root, 'dist') + path.sep) || relative.startsWith('edge-functions/') || relative.startsWith('cloud-functions/') || relative === 'package.json') { res.writeHead(404); res.end(); return; }
    const bytes = await readFile(file); res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }); res.end(bytes);
  } catch { res.writeHead(404); res.end(); }
}).listen(port, '127.0.0.1', () => console.log(`Learning station: http://127.0.0.1:${port} (persistent local KV emulator)`));
