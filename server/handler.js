// Shared async API router. Used by the local Node server (server/server.js) and
// the Vercel serverless function (api/index.js). Handles everything under /api.
// No SSE (serverless can't hold connections) — clients poll instead, and due-date
// notifications are generated on read (scan-on-read).
import * as db from './db.js';

function send(res, status, body, headers = {}) {
  const isObj = body && typeof body === 'object' && !Buffer.isBuffer(body);
  const payload = isObj ? JSON.stringify(body) : body;
  res.writeHead(status, {
    'Content-Type': isObj ? 'application/json; charset=utf-8' : (headers['Content-Type'] || 'text/plain; charset=utf-8'),
    // CORS so the Chrome extension (a different origin) can call the API. Auth is
    // via Bearer token (not cookies), so we don't need Allow-Credentials.
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    ...headers,
  });
  res.end(payload);
}
const ok = (res, data) => send(res, 200, data);
const bad = (res, msg, code = 400) => send(res, code, { error: msg });

async function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
    if (typeof req.body === 'object') return req.body;
  }
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 1e6) reject(new Error('Body too large')); });
    req.on('end', () => { if (!d) return resolve({}); try { resolve(JSON.parse(d)); } catch { reject(new Error('Invalid JSON body')); } });
    req.on('error', reject);
  });
}

function parseCookies(req) {
  const out = {}, raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) { const i = part.indexOf('='); if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
  return out;
}
// Session token from a Bearer header (extension) or the sid cookie (web app).
function getToken(req) {
  const auth = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return m ? m[1].trim() : parseCookies(req).sid;
}
const isHttps = req => (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
function sessionCookie(req, token, expiresAt) {
  const attrs = [`sid=${token}`, 'HttpOnly', 'Path=/', 'SameSite=Lax', `Expires=${new Date(expiresAt).toUTCString()}`];
  if (isHttps(req)) attrs.push('Secure');
  return attrs.join('; ');
}
const clearCookie = 'sid=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0';

// Main entry. Returns true if it handled the request (path under /api).
export async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;
  const method = req.method;
  if (!pathname.startsWith('/api/') && pathname !== '/api') return false;

  // CORS preflight (extension calls with Authorization/Content-Type headers).
  if (method === 'OPTIONS') return send(res, 204, ''), true;

  // Health / diagnostic — must work even if the database is misconfigured.
  // Open /api/health?db=1 in the browser to test the actual DB connection.
  if (pathname === '/api/health' && method === 'GET') {
    const info = { ok: true, time: new Date().toISOString(), vercel: !!process.env.VERCEL, dbConfigured: db.isConfigured() };
    if (url.searchParams.get('db') === '1') {
      try { await db.ready(); await db.ping(); info.db = 'connected'; }
      catch (e) { info.ok = false; info.db = 'error'; info.dbError = e.message; }
    }
    return send(res, info.ok ? 200 : 500, info), true;
  }

  try {
    await db.ready();

    // ---- auth (public) ----
    if (pathname === '/api/auth/register' && method === 'POST') {
      const user = await db.registerUser(await readBody(req));
      const { token, expiresAt } = await db.createSession(user.id);
      // token is returned for header-based clients (the extension); the web app uses the cookie.
      return send(res, 201, { user, token }, { 'Set-Cookie': sessionCookie(req, token, expiresAt) }), true;
    }
    if (pathname === '/api/auth/login' && method === 'POST') {
      const user = await db.authenticate(await readBody(req));
      const { token, expiresAt } = await db.createSession(user.id);
      return send(res, 200, { user, token }, { 'Set-Cookie': sessionCookie(req, token, expiresAt) }), true;
    }
    if (pathname === '/api/auth/logout' && method === 'POST') {
      await db.deleteSession(getToken(req));
      return send(res, 200, { ok: true }, { 'Set-Cookie': clearCookie }), true;
    }
    if (pathname === '/api/auth/me' && method === 'GET') {
      return ok(res, { user: (await db.getSessionUser(getToken(req))) || null }), true;
    }

    // ---- authenticated ----
    const user = await db.getSessionUser(getToken(req));
    if (!user) return bad(res, 'Not authenticated', 401), true;
    const uid = user.id;
    const sp = url.searchParams;

    if (pathname === '/api/state' && method === 'GET') {
      await db.scanUserDue(uid); // generate due/overdue notifications on read
      return ok(res, {
        user,
        projects: await db.listProjects(uid),
        tasks: await db.listTasks(uid, { projectId: sp.get('projectId'), role: sp.get('role'), status: sp.get('status'), q: sp.get('q') }),
        notifications: await db.listNotifications(uid, { limit: 50 }),
        stats: await db.stats(uid),
      }), true;
    }
    if (pathname === '/api/stats' && method === 'GET') return ok(res, await db.stats(uid)), true;

    // projects
    if (pathname === '/api/projects' && method === 'GET') return ok(res, await db.listProjects(uid)), true;
    if (pathname === '/api/projects' && method === 'POST') return send(res, 201, await db.createProject(uid, await readBody(req))), true;
    let m = pathname.match(/^\/api\/projects\/([^/]+)$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      if (method === 'GET') { const p = await db.getProject(uid, id); return (p ? ok(res, p) : bad(res, 'Project not found', 404)), true; }
      if (method === 'DELETE') return ((await db.deleteProject(uid, id)) ? ok(res, { deleted: true }) : bad(res, 'Project not found', 404)), true;
    }

    // tasks
    if (pathname === '/api/tasks' && method === 'GET') {
      return ok(res, await db.listTasks(uid, { projectId: sp.get('projectId'), role: sp.get('role'), status: sp.get('status'), q: sp.get('q') })), true;
    }
    if (pathname === '/api/tasks' && method === 'POST') return send(res, 201, await db.createTask(uid, await readBody(req))), true;
    m = pathname.match(/^\/api\/tasks\/(\d+)$/);
    if (m) {
      const id = Number(m[1]);
      if (method === 'GET') { const t = await db.getTask(uid, id); return (t ? ok(res, t) : bad(res, 'Task not found', 404)), true; }
      if (method === 'PATCH') return ok(res, await db.updateTask(uid, id, await readBody(req))), true;
      if (method === 'DELETE') return ((await db.deleteTask(uid, id)) ? ok(res, { deleted: true }) : bad(res, 'Task not found', 404)), true;
    }
    m = pathname.match(/^\/api\/tasks\/(\d+)\/(cycle|complete)$/);
    if (m && method === 'POST') {
      const id = Number(m[1]);
      return ok(res, m[2] === 'cycle' ? await db.cycleStatus(uid, id) : await db.completeTask(uid, id)), true;
    }

    // notifications
    if (pathname === '/api/notifications' && method === 'GET') {
      await db.scanUserDue(uid);
      return ok(res, await db.listNotifications(uid, { unreadOnly: sp.get('unread') === '1', limit: Number(sp.get('limit')) || 50 })), true;
    }
    if (pathname === '/api/notifications/read-all' && method === 'POST') { await db.markAllNotificationsRead(uid); return ok(res, { ok: true }), true; }
    if (pathname === '/api/notifications/scan' && method === 'POST') return ok(res, { raised: await db.scanUserDue(uid) }), true;
    m = pathname.match(/^\/api\/notifications\/(\d+)\/read$/);
    if (m && method === 'POST') { await db.markNotificationRead(uid, Number(m[1])); return ok(res, { ok: true }), true; }

    // notes
    if (pathname === '/api/notes' && method === 'GET') return ok(res, await db.listNotes(uid, { limit: Number(sp.get('limit')) || 100 })), true;
    if (pathname === '/api/notes' && method === 'POST') return send(res, 201, await db.createNote(uid, await readBody(req))), true;
    m = pathname.match(/^\/api\/notes\/(\d+)$/);
    if (m) {
      const id = Number(m[1]);
      if (method === 'GET') { const n = await db.getNote(uid, id); return (n ? ok(res, n) : bad(res, 'Note not found', 404)), true; }
      if (method === 'PATCH') return ok(res, await db.updateNote(uid, id, await readBody(req))), true;
      if (method === 'DELETE') return ((await db.deleteNote(uid, id)) ? ok(res, { deleted: true }) : bad(res, 'Note not found', 404)), true;
    }

    // analytics / admin dashboard. scope=all is admin-only (aggregates every account).
    if (pathname === '/api/analytics/summary' && method === 'GET') {
      const scope = (sp.get('scope') === 'all' && user.isAdmin) ? null : uid;
      const out = {
        scope: scope === null ? 'all' : 'me', isAdmin: !!user.isAdmin,
        totals: await db.analyticsTotals(scope),
        byRole: await db.byRole(scope),
        recent: await db.recentCompletions(scope, 12),
      };
      if (scope === null) out.byUser = await db.byUser();
      else out.byProject = await db.byProject(uid);
      return ok(res, out), true;
    }
    if (pathname === '/api/analytics/contributions' && method === 'GET') {
      const scope = (sp.get('scope') === 'all' && user.isAdmin) ? null : uid;
      const days = Math.min(400, Math.max(30, Number(sp.get('days')) || 371));
      const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
      const series = await db.completionSeries(scope, since);
      return ok(res, {
        scope: scope === null ? 'all' : 'me', since,
        series, total: series.reduce((s, d) => s + d.count, 0), max: series.reduce((m, d) => Math.max(m, d.count), 0),
      }), true;
    }

    return bad(res, `No route: ${method} ${pathname}`, 404), true;
  } catch (err) {
    return bad(res, err.message || 'Server error', 400), true;
  }
}
