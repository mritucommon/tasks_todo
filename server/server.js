// Local / persistent-host Node server: static frontend + the shared API handler.
// (On Vercel the same handler runs from api/[...path].js instead.)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname } from 'node:path';
import { handleApi } from './handler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT) || 4000;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png',
};

async function serveStatic(res, pathname) {
  const filePath = normalize(join(PUBLIC_DIR, pathname === '/' ? '/index.html' : pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403).end('Forbidden'); return; }
  try {
    const buf = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
    res.end(buf);
  } catch {
    try {
      const idx = await readFile(join(PUBLIC_DIR, 'index.html'));
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      res.end(idx);
    } catch { res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Not found' })); }
  }
}

const server = createServer(async (req, res) => {
  try {
    if (await handleApi(req, res)) return;                 // handled an /api/* route
    if (req.method === 'GET') return serveStatic(res, new URL(req.url, 'http://localhost').pathname);
    res.writeHead(405, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Method not allowed' }));
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: err.message || 'Server error' }));
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use — the Task List server may already be running.`);
    console.error(`  Set a different port with  PORT=5000 npm start\n`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  console.log(`\n  Task List is alive →  http://localhost:${PORT}`);
  console.log(`  REST API           →  http://localhost:${PORT}/api  (auth required)\n`);
});
