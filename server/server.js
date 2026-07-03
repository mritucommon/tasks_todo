// Zero-dependency HTTP server: REST API + Server-Sent Events + static frontend.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname } from 'node:path';
import * as db from './db.js';
import { startNotifier, scanOnce } from './notifier.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT) || 4000;

db.seedIfEmpty();
startNotifier({ intervalMs: 60_000 });

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png',
};

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': typeof body === 'object' && !Buffer.isBuffer(body) ? 'application/json; charset=utf-8' : (headers['Content-Type'] || 'text/plain; charset=utf-8'),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    ...headers,
  });
  res.end(payload);
}
const ok = (res, data) => send(res, 200, data);
const bad = (res, msg, code = 400) => send(res, code, { error: msg });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) reject(new Error('Body too large')); });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------- SSE
const clients = new Set();
function sseHandler(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no',
  });
  res.write(`event: hello\ndata: ${JSON.stringify({ stats: db.stats() })}\n\n`);
  clients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => { clearInterval(ping); clients.delete(res); });
}
function broadcast(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify({ ...data, stats: db.stats() })}\n\n`;
  for (const res of clients) { try { res.write(frame); } catch { clients.delete(res); } }
}
db.bus.on('change', d => broadcast('change', d));
db.bus.on('notification', n => broadcast('notification', { notification: n }));

// ---------------------------------------------------------------- static files
async function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = normalize(join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) return bad(res, 'Forbidden', 403);
  try {
    const buf = await readFile(filePath);
    send(res, 200, buf, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
  } catch {
    // SPA-ish fallback to index.html for unknown non-API GETs
    if (!pathname.startsWith('/api')) {
      try { send(res, 200, await readFile(join(PUBLIC_DIR, 'index.html')), { 'Content-Type': MIME['.html'] }); return; } catch {}
    }
    bad(res, 'Not found', 404);
  }
}

// ---------------------------------------------------------------- router
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;
  const method = req.method;

  if (method === 'OPTIONS') return send(res, 204, '');

  try {
    // ---- API ----
    if (pathname.startsWith('/api/')) {
      // health
      if (pathname === '/api/health' && method === 'GET') return ok(res, { ok: true, time: new Date().toISOString() });

      // live event stream
      if (pathname === '/api/events' && method === 'GET') return sseHandler(req, res);

      // full bootstrap state
      if (pathname === '/api/state' && method === 'GET') {
        return ok(res, {
          projects: db.listProjects(),
          tasks: db.listTasks({ projectId: url.searchParams.get('projectId'), role: url.searchParams.get('role'), status: url.searchParams.get('status'), q: url.searchParams.get('q') }),
          notifications: db.listNotifications({ limit: 50 }),
          stats: db.stats(),
        });
      }

      if (pathname === '/api/stats' && method === 'GET') return ok(res, db.stats());

      // projects
      if (pathname === '/api/projects' && method === 'GET') return ok(res, db.listProjects());
      if (pathname === '/api/projects' && method === 'POST') {
        const b = await readBody(req);
        return send(res, 201, db.createProject(b));
      }
      let m = pathname.match(/^\/api\/projects\/([^/]+)$/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        if (method === 'GET') { const p = db.getProject(id); return p ? ok(res, p) : bad(res, 'Project not found', 404); }
        if (method === 'DELETE') return db.deleteProject(id) ? ok(res, { deleted: true }) : bad(res, 'Project not found', 404);
      }

      // tasks
      if (pathname === '/api/tasks' && method === 'GET') {
        return ok(res, db.listTasks({
          projectId: url.searchParams.get('projectId'), role: url.searchParams.get('role'),
          status: url.searchParams.get('status'), q: url.searchParams.get('q'),
        }));
      }
      if (pathname === '/api/tasks' && method === 'POST') {
        const b = await readBody(req);
        return send(res, 201, db.createTask(b));
      }
      m = pathname.match(/^\/api\/tasks\/(\d+)$/);
      if (m) {
        const id = Number(m[1]);
        if (method === 'GET') { const t = db.getTask(id); return t ? ok(res, t) : bad(res, 'Task not found', 404); }
        if (method === 'PATCH') { const b = await readBody(req); return ok(res, db.updateTask(id, b)); }
        if (method === 'DELETE') return db.deleteTask(id) ? ok(res, { deleted: true }) : bad(res, 'Task not found', 404);
      }
      m = pathname.match(/^\/api\/tasks\/(\d+)\/(cycle|complete)$/);
      if (m && method === 'POST') {
        const id = Number(m[1]);
        return ok(res, m[2] === 'cycle' ? db.cycleStatus(id) : db.completeTask(id));
      }

      // notifications
      if (pathname === '/api/notifications' && method === 'GET') {
        return ok(res, db.listNotifications({ unreadOnly: url.searchParams.get('unread') === '1', limit: Number(url.searchParams.get('limit')) || 50 }));
      }
      if (pathname === '/api/notifications/read-all' && method === 'POST') { db.markAllNotificationsRead(); return ok(res, { ok: true }); }
      if (pathname === '/api/notifications/scan' && method === 'POST') return ok(res, { raised: scanOnce() });
      m = pathname.match(/^\/api\/notifications\/(\d+)\/read$/);
      if (m && method === 'POST') { db.markNotificationRead(Number(m[1])); return ok(res, { ok: true }); }

      return bad(res, `No route: ${method} ${pathname}`, 404);
    }

    // ---- static ----
    if (method === 'GET') return serveStatic(req, res, pathname);
    return bad(res, 'Method not allowed', 405);
  } catch (err) {
    return bad(res, err.message || 'Server error', 400);
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
  console.log(`  REST API           →  http://localhost:${PORT}/api`);
  console.log(`  Live event stream  →  http://localhost:${PORT}/api/events\n`);
});
