// Shared SQLite data layer for the multi-user Task List app.
// Every project / task / notification belongs to a user, and every query is
// scoped by userId so accounts are fully isolated. Auth uses Node's built-in
// scrypt (no external dependencies).
import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
// TASKLIST_DB lets a host point the database at a persistent volume.
const DB_PATH = process.env.TASKLIST_DB || join(__dirname, '..', 'data', 'tasklist.db');
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

// Process-wide bus so the SSE endpoint can push per-user live changes.
export const bus = new EventEmitter();
bus.setMaxListeners(0);

// ---------------------------------------------------------------- schema
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  subtitle   TEXT NOT NULL DEFAULT '',
  color      TEXT NOT NULL DEFAULT '#3E52C9',
  ai         INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'dev',
  prio         TEXT NOT NULL DEFAULT 'med',
  status       TEXT NOT NULL DEFAULT 'todo',
  due          TEXT,
  ai           INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id    INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  read       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
`);

const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------- auth
function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = scryptSync(String(password), salt, 64);
  return `scrypt:${salt.toString('hex')}:${derived.toString('hex')}`;
}
function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split(':');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const publicUser = u => u && ({ id: u.id, email: u.email, name: u.name, createdAt: u.created_at });

export function getUserByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(String(email).trim().toLowerCase());
}
export function getUserById(id) {
  return publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id));
}

export function registerUser({ email, password, name = '' }) {
  const e = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new Error('A valid email is required');
  if (!password || String(password).length < 6) throw new Error('Password must be at least 6 characters');
  if (getUserByEmail(e)) throw new Error('An account with that email already exists');
  const info = db.prepare('INSERT INTO users (email,name,password_hash,created_at) VALUES (?,?,?,?)')
    .run(e, String(name || '').trim(), hashPassword(password), nowIso());
  const userId = Number(info.lastInsertRowid);
  seedUserWorkspace(userId); // give a new account a ready-to-use sample workspace
  return getUserById(userId);
}

export function authenticate({ email, password }) {
  const u = getUserByEmail(email);
  if (!u || !verifyPassword(password, u.password_hash)) throw new Error('Invalid email or password');
  return publicUser(u);
}

const SESSION_DAYS = 30;
export function createSession(userId) {
  const token = randomBytes(32).toString('hex');
  const created = new Date();
  const expires = new Date(created.getTime() + SESSION_DAYS * 86400000);
  db.prepare('INSERT INTO sessions (token,user_id,created_at,expires_at) VALUES (?,?,?,?)')
    .run(token, userId, created.toISOString(), expires.toISOString());
  return { token, expiresAt: expires.toISOString() };
}
export function getSessionUser(token) {
  if (!token) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!s) return null;
  if (new Date(s.expires_at) < new Date()) { deleteSession(token); return null; }
  return getUserById(s.user_id);
}
export function deleteSession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  return true;
}

// ---------------------------------------------------------------- date helpers
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function parseDue(input) {
  if (input == null) return null;
  const s = String(input).trim();
  if (!s || s === '—') return null;
  if (/^(\d{4})-(\d{2})-(\d{2})$/.test(s)) return s;
  const m = /^([A-Za-z]{3,})\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?$/.exec(s);
  if (m) {
    const mon = MONTHS.findIndex(x => x.toLowerCase() === m[1].slice(0, 3).toLowerCase());
    if (mon >= 0) {
      const year = m[3] ? Number(m[3]) : new Date().getFullYear();
      return `${year}-${String(mon + 1).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`;
    }
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}
export function formatDue(iso) {
  if (!iso) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}` : iso;
}
export function daysUntil(iso) {
  if (!iso) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return Math.round((new Date(iso + 'T00:00:00') - today) / 86400000);
}

// ---------------------------------------------------------------- serialization
function rowToTask(r) {
  if (!r) return null;
  return {
    id: r.id, projectId: r.project_id, title: r.title, role: r.role, prio: r.prio,
    status: r.status, due: r.due, dueLabel: formatDue(r.due), daysUntil: daysUntil(r.due),
    ai: !!r.ai, createdAt: r.created_at, updatedAt: r.updated_at, completedAt: r.completed_at,
  };
}
const rowToProject = r => r && ({ id: r.id, name: r.name, subtitle: r.subtitle, color: r.color, ai: !!r.ai, createdAt: r.created_at });
const rowToNotif = r => r && ({ id: r.id, taskId: r.task_id, type: r.type, title: r.title, body: r.body, read: !!r.read, createdAt: r.created_at });

// ---------------------------------------------------------------- projects
export function listProjects(userId) {
  return db.prepare('SELECT * FROM projects WHERE user_id = ? ORDER BY created_at ASC').all(userId).map(rowToProject);
}
export function getProject(userId, id) {
  return rowToProject(db.prepare('SELECT * FROM projects WHERE user_id = ? AND id = ?').get(userId, id));
}

const PALETTE = ['#3E52C9', '#A93C93', '#B7671A', '#2A8062', '#6D5BD0', '#0E7C86', '#C23B5B'];
function uniqueProjectId(name) {
  const base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'project';
  let id = base, n = 1;
  while (db.prepare('SELECT 1 FROM projects WHERE id = ?').get(id)) id = `${base}-${++n}`;
  return id;
}

export function createProject(userId, { name, subtitle = 'New project', color, ai = false } = {}) {
  if (!name || !String(name).trim()) throw new Error('Project name is required');
  const pid = uniqueProjectId(name);
  const count = db.prepare('SELECT COUNT(*) AS c FROM projects WHERE user_id = ?').get(userId).c;
  db.prepare('INSERT INTO projects (id,user_id,name,subtitle,color,ai,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(pid, userId, String(name).trim(), String(subtitle || ''), color || PALETTE[count % PALETTE.length], ai ? 1 : 0, nowIso());
  const out = getProject(userId, pid);
  emitNotification(userId, { type: 'project', title: `New project: ${out.name}`, body: out.subtitle });
  bus.emit('change', { userId, kind: 'project.created', project: out });
  return out;
}
export function deleteProject(userId, id) {
  if (!getProject(userId, id)) return false;
  db.prepare('DELETE FROM projects WHERE user_id = ? AND id = ?').run(userId, id);
  bus.emit('change', { userId, kind: 'project.deleted', id });
  return true;
}

// ---------------------------------------------------------------- tasks
const ROLES = ['dev', 'design', 'marketing', 'seo'];
const PRIOS = ['high', 'med', 'low'];
const STATUSES = ['todo', 'inprogress', 'done'];

export function listTasks(userId, { projectId, role, status, q } = {}) {
  const where = ['user_id = ?'], args = [userId];
  if (projectId && projectId !== 'all') { where.push('project_id = ?'); args.push(projectId); }
  if (role && role !== 'all') { where.push('role = ?'); args.push(role); }
  if (status && status !== 'all') { where.push('status = ?'); args.push(status); }
  if (q) { where.push('title LIKE ?'); args.push('%' + q + '%'); }
  return db.prepare(`SELECT * FROM tasks WHERE ${where.join(' AND ')} ORDER BY (due IS NULL), due ASC, id ASC`)
    .all(...args).map(rowToTask);
}
export function getTask(userId, id) {
  return rowToTask(db.prepare('SELECT * FROM tasks WHERE user_id = ? AND id = ?').get(userId, id));
}

export function createTask(userId, { projectId, title, role = 'dev', prio = 'med', due, status = 'todo', ai = false } = {}) {
  if (!title || !String(title).trim()) throw new Error('Task title is required');
  if (!projectId || !getProject(userId, projectId)) throw new Error(`Unknown projectId: ${projectId}`);
  if (!ROLES.includes(role)) throw new Error(`role must be one of ${ROLES.join(', ')}`);
  if (!PRIOS.includes(prio)) throw new Error(`prio must be one of ${PRIOS.join(', ')}`);
  if (!STATUSES.includes(status)) throw new Error(`status must be one of ${STATUSES.join(', ')}`);
  const ts = nowIso();
  const info = db.prepare(
    'INSERT INTO tasks (user_id,project_id,title,role,prio,status,due,ai,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
  ).run(userId, projectId, String(title).trim(), role, prio, status, parseDue(due), ai ? 1 : 0, ts, ts);
  const task = getTask(userId, Number(info.lastInsertRowid));
  emitNotification(userId, { taskId: task.id, type: 'created', title: `New task: ${task.title}`, body: labelFor(userId, task) });
  bus.emit('change', { userId, kind: 'task.created', task });
  return task;
}

export function updateTask(userId, id, patch = {}) {
  const cur = getTask(userId, id);
  if (!cur) throw new Error(`Unknown task id: ${id}`);
  const next = {
    project_id: patch.projectId ?? cur.projectId,
    title: patch.title != null ? String(patch.title).trim() : cur.title,
    role: patch.role ?? cur.role,
    prio: patch.prio ?? cur.prio,
    status: patch.status ?? cur.status,
    due: patch.due !== undefined ? parseDue(patch.due) : cur.due,
  };
  if (!ROLES.includes(next.role)) throw new Error(`role must be one of ${ROLES.join(', ')}`);
  if (!PRIOS.includes(next.prio)) throw new Error(`prio must be one of ${PRIOS.join(', ')}`);
  if (!STATUSES.includes(next.status)) throw new Error(`status must be one of ${STATUSES.join(', ')}`);
  if (next.project_id !== cur.projectId && !getProject(userId, next.project_id)) throw new Error(`Unknown projectId: ${next.project_id}`);
  const justCompleted = next.status === 'done' && cur.status !== 'done';
  const completed_at = next.status === 'done' ? (cur.completedAt || nowIso()) : null;
  db.prepare('UPDATE tasks SET project_id=?,title=?,role=?,prio=?,status=?,due=?,updated_at=?,completed_at=? WHERE user_id=? AND id=?')
    .run(next.project_id, next.title, next.role, next.prio, next.status, next.due, nowIso(), completed_at, userId, id);
  const task = getTask(userId, id);
  if (justCompleted) emitNotification(userId, { taskId: task.id, type: 'completed', title: `Completed: ${task.title}`, body: '' });
  else if (patch.status && patch.status !== cur.status) emitNotification(userId, { taskId: task.id, type: 'status', title: `${task.title} → ${statusLabel(task.status)}`, body: '' });
  bus.emit('change', { userId, kind: 'task.updated', task });
  return task;
}
export function cycleStatus(userId, id) {
  const cur = getTask(userId, id);
  if (!cur) throw new Error(`Unknown task id: ${id}`);
  return updateTask(userId, id, { status: STATUSES[(STATUSES.indexOf(cur.status) + 1) % STATUSES.length] });
}
export function completeTask(userId, id) { return updateTask(userId, id, { status: 'done' }); }
export function deleteTask(userId, id) {
  if (!getTask(userId, id)) return false;
  db.prepare('DELETE FROM tasks WHERE user_id = ? AND id = ?').run(userId, id);
  bus.emit('change', { userId, kind: 'task.deleted', id });
  return true;
}

const statusLabel = s => ({ todo: 'To Do', inprogress: 'In Progress', done: 'Done' }[s] || s);
function labelFor(userId, t) {
  const p = getProject(userId, t.projectId);
  return `${p ? p.name.split(' — ')[0] : ''} · ${t.role} · due ${t.dueLabel}`;
}

// ---------------------------------------------------------------- notifications
export function emitNotification(userId, { taskId = null, type, title, body = '' }) {
  const info = db.prepare('INSERT INTO notifications (user_id,task_id,type,title,body,read,created_at) VALUES (?,?,?,?,?,0,?)')
    .run(userId, taskId, type, title, body, nowIso());
  const notif = rowToNotif(db.prepare('SELECT * FROM notifications WHERE id = ?').get(Number(info.lastInsertRowid)));
  bus.emit('notification', { userId, notification: notif });
  return notif;
}
export function listNotifications(userId, { unreadOnly = false, limit = 50 } = {}) {
  const sql = `SELECT * FROM notifications WHERE user_id = ?${unreadOnly ? ' AND read = 0' : ''} ORDER BY created_at DESC, id DESC LIMIT ?`;
  return db.prepare(sql).all(userId, limit).map(rowToNotif);
}
export function unreadCount(userId) {
  return db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read = 0').get(userId).c;
}
export function markNotificationRead(userId, id) {
  db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ? AND id = ?').run(userId, id);
  bus.emit('change', { userId, kind: 'notification.read', id });
  return true;
}
export function markAllNotificationsRead(userId) {
  db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ? AND read = 0').run(userId);
  bus.emit('change', { userId, kind: 'notification.readAll' });
  return true;
}
export function hasDueNotifToday(userId, taskId, type) {
  const today = new Date().toISOString().slice(0, 10);
  return !!db.prepare('SELECT 1 FROM notifications WHERE user_id = ? AND task_id = ? AND type = ? AND substr(created_at,1,10) = ? LIMIT 1')
    .get(userId, taskId, type, today);
}

// For the background scanner: every open task across all users, with its owner.
export function allOpenTasks() {
  return db.prepare("SELECT id, user_id, title, due, status FROM tasks WHERE status != 'done' AND due IS NOT NULL")
    .all().map(r => ({ id: r.id, userId: r.user_id, title: r.title, due: r.due, dueLabel: formatDue(r.due), daysUntil: daysUntil(r.due), status: r.status }));
}

// ---------------------------------------------------------------- stats
export function stats(userId) {
  const tasks = listTasks(userId);
  const done = tasks.filter(t => t.status === 'done').length;
  return {
    total: tasks.length, done,
    overdue: tasks.filter(t => t.status !== 'done' && t.daysUntil != null && t.daysUntil < 0).length,
    dueSoon: tasks.filter(t => t.status !== 'done' && t.daysUntil != null && t.daysUntil >= 0 && t.daysUntil <= 2).length,
    inProgress: tasks.filter(t => t.status === 'inprogress').length,
    todo: tasks.filter(t => t.status === 'todo').length,
    pct: Math.round((done / (tasks.length || 1)) * 100),
    projects: listProjects(userId).length,
    unread: unreadCount(userId),
  };
}

// ---------------------------------------------------------------- per-user seed
// Give a brand-new account a ready-made sample workspace so it looks alive.
export function seedUserWorkspace(userId) {
  const ts = nowIso();
  const projects = [
    { key: 'aurora', name: 'Aurora — SaaS Marketing Site', subtitle: 'Own product · launching Q3', color: '#3E52C9' },
    { key: 'finch',  name: 'Finch — Mobile App Launch',    subtitle: 'Own product · App Store rollout', color: '#A93C93' },
    { key: 'nordic', name: 'Nordic Coffee — Brand Refresh', subtitle: 'Client work · retainer', color: '#B7671A' },
    { key: 'growth', name: 'Growth & Ops',                 subtitle: 'Internal · ongoing', color: '#2A8062' },
  ];
  const idByKey = {};
  const insP = db.prepare('INSERT INTO projects (id,user_id,name,subtitle,color,ai,created_at) VALUES (?,?,?,?,?,0,?)');
  for (const p of projects) { const id = uniqueProjectId(p.key); idByKey[p.key] = id; insP.run(id, userId, p.name, p.subtitle, p.color, ts); }

  const tasks = [
    ['aurora','dev','high','2026-07-05','Scaffold Next.js + Tailwind project','done'],
    ['aurora','design','high','2026-07-06','Design hero + feature sections in Figma','done'],
    ['aurora','design','med','2026-07-09','Define color & type tokens for the site','inprogress'],
    ['aurora','dev','med','2026-07-11','Build responsive nav with mobile menu','todo'],
    ['aurora','seo','high','2026-07-08','Keyword research for landing pages','inprogress'],
    ['aurora','marketing','med','2026-07-12','Draft 3 homepage headline variants','todo'],
    ['aurora','seo','low','2026-07-15','Add schema markup & meta descriptions','todo'],
    ['aurora','dev','low','2026-07-16','Wire up analytics & cookie consent','todo'],
    ['finch','design','high','2026-07-07','Finalize onboarding flow screens','inprogress'],
    ['finch','dev','high','2026-07-04','Fix login crash on Android 14','todo'],
    ['finch','dev','med','2026-07-10','Implement push notifications','todo'],
    ['finch','design','med','2026-07-06','Export app icon in all required sizes','done'],
    ['finch','marketing','high','2026-07-13','Plan App Store launch campaign','todo'],
    ['finch','marketing','med','2026-07-11','Write App Store listing copy','todo'],
    ['finch','seo','med','2026-07-12','Optimize App Store keywords (ASO)','todo'],
    ['nordic','design','high','2026-06-30','Present 3 logo directions to client','done'],
    ['nordic','design','med','2026-07-09','Build brand guidelines PDF','inprogress'],
    ['nordic','dev','med','2026-07-14','Build Shopify product page templates','todo'],
    ['nordic','marketing','med','2026-07-10','Plan Instagram content calendar','todo'],
    ['nordic','seo','low','2026-07-02','Audit current site rankings','done'],
    ['nordic','marketing','low','2026-07-17','Design email newsletter template','todo'],
    ['growth','seo','med','2026-07-08','Compile monthly SEO report','inprogress'],
    ['growth','seo','high','2026-07-07','Fix broken backlinks flagged in audit','todo'],
    ['growth','marketing','med','2026-07-15','A/B test pricing page CTA copy','todo'],
    ['growth','marketing','med','2026-07-20','Launch customer referral program','todo'],
    ['growth','dev','low','2026-07-22','Migrate blog to a headless CMS','todo'],
    ['growth','dev','med','2026-07-01','Set up CI/CD deploy pipeline','done'],
    ['growth','design','low','2026-07-18','Refresh the pitch deck template','todo'],
  ];
  const insT = db.prepare(
    'INSERT INTO tasks (user_id,project_id,title,role,prio,status,due,ai,created_at,updated_at,completed_at) VALUES (?,?,?,?,?,?,?,0,?,?,?)'
  );
  for (const [key, role, prio, due, title, status] of tasks) {
    insT.run(userId, idByKey[key], title, role, prio, status, due, ts, ts, status === 'done' ? ts : null);
  }
}

export { db };
