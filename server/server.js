// Zero-dependency HTTP server: auth + REST API + per-user SSE + static frontend.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname } from 'node:path';
import * as db from './db.js';
import { startNotifier, scanOnce } from './notifier.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT) || 4000;

startNotifier({ intervalMs: 60_000 });

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png',
};

function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  const isObj = typeof body === 'object' && !isBuf;
  const payload = isObj ? JSON.stringify(body) : body;
  res.writeHead(status, {
    'Content-Type': isObj ? 'application/json; charset=utf-8' : (headers['Content-Type'] || 'text/plain; charset=utf-8'),
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
    req.on('end', () => { if (!data) return resolve({}); try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON body')); } });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------- cookies / auth
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const isHttps = req => (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
function sessionCookie(req, token, expiresAt) {
  const attrs = [`sid=${token}`, 'HttpOnly', 'Path=/', 'SameSite=Lax', `Expires=${new Date(expiresAt).toUTCString()}`];
  if (isHttps(req)) attrs.push('Secure');
  return attrs.join('; ');
}
const clearCookie = 'sid=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0';
const currentUser = req => db.getSessionUser(parseCookies(req).sid);

// ---------------------------------------------------------------- SSE (per user)
const clients = new Set(); // { res, userId }
function sseHandler(req, res, user) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
  });
  res.write(`event: hello\ndata: ${JSON.stringify({ stats: db.stats(user.id), user })}\n\n`);
  const client = { res, userId: user.id };
  clients.add(client);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25_000);
  req.on('close', () => { clearInterval(ping); clients.delete(client); });
}
function broadcast(userId, event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify({ ...data, stats: db.stats(userId) })}\n\n`;
  for (const c of clients) if (c.userId === userId) { try { c.res.write(frame); } catch { clients.delete(c); } }
}
db.bus.on('change', d => broadcast(d.userId, 'change', d));
db.bus.on('notification', d => broadcast(d.userId, 'notification', { notification: d.notification }));

// ---------------------------------------------------------------- static files
async function serveStatic(req, res, pathname) {
  const filePath = normalize(join(PUBLIC_DIR, pathname === '/' ? '/index.html' : pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) return bad(res, 'Forbidden', 403);
  try {
    const buf = await readFile(filePath);
    send(res, 200, buf, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
  } catch {
    if (!pathname.startsWith('/api')) {
      try { return send(res, 200, await readFile(join(PUBLIC_DIR, 'index.html')), { 'Content-Type': MIME['.html'] }); } catch {}
    }
    bad(res, 'Not found', 404);
  }
}

// ---------------------------------------------------------------- router
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;
  const method = req.method;

  try {
    if (pathname.startsWith('/api/')) {
      if (pathname === '/api/health' && method === 'GET') return ok(res, { ok: true, time: new Date().toISOString() });

      // ---- auth (public) ----
      if (pathname === '/api/auth/register' && method === 'POST') {
        const b = await readBody(req);
        const user = db.registerUser(b);
        const { token, expiresAt } = db.createSession(user.id);
        return send(res, 201, { user }, { 'Set-Cookie': sessionCookie(req, token, expiresAt) });
      }
      if (pathname === '/api/auth/login' && method === 'POST') {
        const b = await readBody(req);
        const user = db.authenticate(b);
        const { token, expiresAt } = db.createSession(user.id);
        return send(res, 200, { user }, { 'Set-Cookie': sessionCookie(req, token, expiresAt) });
      }
      if (pathname === '/api/auth/logout' && method === 'POST') {
        db.deleteSession(parseCookies(req).sid);
        return send(res, 200, { ok: true }, { 'Set-Cookie': clearCookie });
      }
      if (pathname === '/api/auth/me' && method === 'GET') {
        const user = currentUser(req);
        return ok(res, { user: user || null });
      }

      // ---- everything below requires auth ----
      const user = currentUser(req);
      if (!user) return bad(res, 'Not authenticated', 401);
      const uid = user.id;

      if (pathname === '/api/events' && method === 'GET') return sseHandler(req, res, user);

      if (pathname === '/api/state' && method === 'GET') {
        return ok(res, {
          user,
          projects: db.listProjects(uid),
          tasks: db.listTasks(uid, { projectId: url.searchParams.get('projectId'), role: url.searchParams.get('role'), status: url.searchParams.get('status'), q: url.searchParams.get('q') }),
          notifications: db.listNotifications(uid, { limit: 50 }),
          stats: db.stats(uid),
        });
      }
      if (pathname === '/api/stats' && method === 'GET') return ok(res, db.stats(uid));

      // projects
      if (pathname === '/api/projects' && method === 'GET') return ok(res, db.listProjects(uid));
      if (pathname === '/api/projects' && method === 'POST') return send(res, 201, db.createProject(uid, await readBody(req)));
      let m = pathname.match(/^\/api\/projects\/([^/]+)$/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        if (method === 'GET') { const p = db.getProject(uid, id); return p ? ok(res, p) : bad(res, 'Project not found', 404); }
        if (method === 'DELETE') return db.deleteProject(uid, id) ? ok(res, { deleted: true }) : bad(res, 'Project not found', 404);
      }

      // tasks
      if (pathname === '/api/tasks' && method === 'GET') {
        return ok(res, db.listTasks(uid, { projectId: url.searchParams.get('projectId'), role: url.searchParams.get('role'), status: url.searchParams.get('status'), q: url.searchParams.get('q') }));
      }
      if (pathname === '/api/tasks' && method === 'POST') return send(res, 201, db.createTask(uid, await readBody(req)));
      m = pathname.match(/^\/api\/tasks\/(\d+)$/);
      if (m) {
        const id = Number(m[1]);
        if (method === 'GET') { const t = db.getTask(uid, id); return t ? ok(res, t) : bad(res, 'Task not found', 404); }
        if (method === 'PATCH') return ok(res, db.updateTask(uid, id, await readBody(req)));
        if (method === 'DELETE') return db.deleteTask(uid, id) ? ok(res, { deleted: true }) : bad(res, 'Task not found', 404);
      }
      m = pathname.match(/^\/api\/tasks\/(\d+)\/(cycle|complete)$/);
      if (m && method === 'POST') {
        const id = Number(m[1]);
        return ok(res, m[2] === 'cycle' ? db.cycleStatus(uid, id) : db.completeTask(uid, id));
      }

      // notifications
      if (pathname === '/api/notifications' && method === 'GET') {
        return ok(res, db.listNotifications(uid, { unreadOnly: url.searchParams.get('unread') === '1', limit: Number(url.searchParams.get('limit')) || 50 }));
      }
      if (pathname === '/api/notifications/read-all' && method === 'POST') { db.markAllNotificationsRead(uid); return ok(res, { ok: true }); }
      if (pathname === '/api/notifications/scan' && method === 'POST') return ok(res, { raised: scanOnce() });
      m = pathname.match(/^\/api\/notifications\/(\d+)\/read$/);
      if (m && method === 'POST') { db.markNotificationRead(uid, Number(m[1])); return ok(res, { ok: true }); }

      return bad(res, `No route: ${method} ${pathname}`, 404);
    }

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
  console.log(`  REST API           →  http://localhost:${PORT}/api  (auth required)`);
  console.log(`  Live event stream  →  http://localhost:${PORT}/api/events\n`);
});
