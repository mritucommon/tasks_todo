// Shared SQLite data layer for the Task List app.
// Used by BOTH the REST API (server.js) and the MCP server (mcp/mcp-server.js)
// so the AI and the UI operate on the exact same live data.
import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = process.env.TASKLIST_DB || join(DATA_DIR, 'tasklist.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

// A process-wide bus so the SSE endpoint can push live changes to browsers.
export const bus = new EventEmitter();
bus.setMaxListeners(0);

// ---------------------------------------------------------------- schema
db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  subtitle   TEXT NOT NULL DEFAULT '',
  color      TEXT NOT NULL DEFAULT '#3E52C9',
  ai         INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'dev',
  prio         TEXT NOT NULL DEFAULT 'med',
  status       TEXT NOT NULL DEFAULT 'todo',
  due          TEXT,                      -- ISO date (YYYY-MM-DD) or NULL
  ai           INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,               -- due_soon | overdue | created | completed | status | project
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  read       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_notif_read ON notifications(read);
`);

const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------- date helpers
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Accepts: ISO 'YYYY-MM-DD', 'Jul 20', 'Jul 20 2026', '', null.
// Returns an ISO date string 'YYYY-MM-DD' or null.
export function parseDue(input) {
  if (input == null) return null;
  const s = String(input).trim();
  if (!s || s === '—') return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (iso) return s;
  const m = /^([A-Za-z]{3,})\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?$/.exec(s);
  if (m) {
    const mon = MONTHS.findIndex(x => x.toLowerCase() === m[1].slice(0, 3).toLowerCase());
    if (mon >= 0) {
      const year = m[3] ? Number(m[3]) : new Date().getFullYear();
      const day = String(Number(m[2])).padStart(2, '0');
      return `${year}-${String(mon + 1).padStart(2, '0')}-${day}`;
    }
  }
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null; // unparseable -> treat as no due date
}

// 'YYYY-MM-DD' -> 'Jul 20' for display.
export function formatDue(iso) {
  if (!iso) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}`;
}

// Whole-day difference from today (negative = overdue).
export function daysUntil(iso) {
  if (!iso) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(iso + 'T00:00:00');
  return Math.round((due - today) / 86400000);
}

// ---------------------------------------------------------------- serialization
function rowToTask(r) {
  if (!r) return null;
  return {
    id: r.id,
    projectId: r.project_id,
    title: r.title,
    role: r.role,
    prio: r.prio,
    status: r.status,
    due: r.due,                 // ISO or null
    dueLabel: formatDue(r.due), // 'Jul 20'
    daysUntil: daysUntil(r.due),
    ai: !!r.ai,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    completedAt: r.completed_at,
  };
}
function rowToProject(r) {
  if (!r) return null;
  return { id: r.id, name: r.name, subtitle: r.subtitle, color: r.color, ai: !!r.ai, createdAt: r.created_at };
}
function rowToNotif(r) {
  if (!r) return null;
  return { id: r.id, taskId: r.task_id, type: r.type, title: r.title, body: r.body, read: !!r.read, createdAt: r.created_at };
}

// ---------------------------------------------------------------- projects
export function listProjects() {
  return db.prepare('SELECT * FROM projects ORDER BY created_at ASC').all().map(rowToProject);
}
export function getProject(id) {
  return rowToProject(db.prepare('SELECT * FROM projects WHERE id = ?').get(id));
}

const PALETTE = ['#3E52C9', '#A93C93', '#B7671A', '#2A8062', '#6D5BD0', '#0E7C86', '#C23B5B'];
function slugify(name) {
  const base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'project';
  let id = base, n = 1;
  while (getProject(id)) id = `${base}-${++n}`;
  return id;
}

export function createProject({ name, subtitle = 'New project', color, ai = false, id } = {}) {
  if (!name || !String(name).trim()) throw new Error('Project name is required');
  const pid = id || slugify(name);
  const count = db.prepare('SELECT COUNT(*) AS c FROM projects').get().c;
  const proj = {
    id: pid, name: String(name).trim(), subtitle: String(subtitle || ''),
    color: color || PALETTE[count % PALETTE.length], ai: ai ? 1 : 0, created_at: nowIso(),
  };
  db.prepare('INSERT INTO projects (id,name,subtitle,color,ai,created_at) VALUES (?,?,?,?,?,?)')
    .run(proj.id, proj.name, proj.subtitle, proj.color, proj.ai, proj.created_at);
  const out = getProject(pid);
  emitNotification({ type: 'project', title: `New project: ${out.name}`, body: out.subtitle });
  bus.emit('change', { kind: 'project.created', project: out });
  return out;
}

export function deleteProject(id) {
  const p = getProject(id);
  if (!p) return false;
  db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  bus.emit('change', { kind: 'project.deleted', id });
  return true;
}

// ---------------------------------------------------------------- tasks
const ROLES = ['dev', 'design', 'marketing', 'seo'];
const PRIOS = ['high', 'med', 'low'];
const STATUSES = ['todo', 'inprogress', 'done'];

export function listTasks({ projectId, role, status, q } = {}) {
  const where = [], args = [];
  if (projectId && projectId !== 'all') { where.push('project_id = ?'); args.push(projectId); }
  if (role && role !== 'all') { where.push('role = ?'); args.push(role); }
  if (status && status !== 'all') { where.push('status = ?'); args.push(status); }
  if (q) { where.push('title LIKE ?'); args.push('%' + q + '%'); }
  const sql = 'SELECT * FROM tasks' + (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    ' ORDER BY (due IS NULL), due ASC, id ASC';
  return db.prepare(sql).all(...args).map(rowToTask);
}
export function getTask(id) {
  return rowToTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id));
}

export function createTask({ projectId, title, role = 'dev', prio = 'med', due, status = 'todo', ai = false } = {}) {
  if (!title || !String(title).trim()) throw new Error('Task title is required');
  if (!projectId || !getProject(projectId)) throw new Error(`Unknown projectId: ${projectId}`);
  if (!ROLES.includes(role)) throw new Error(`role must be one of ${ROLES.join(', ')}`);
  if (!PRIOS.includes(prio)) throw new Error(`prio must be one of ${PRIOS.join(', ')}`);
  if (!STATUSES.includes(status)) throw new Error(`status must be one of ${STATUSES.join(', ')}`);
  const ts = nowIso();
  const info = db.prepare(
    'INSERT INTO tasks (project_id,title,role,prio,status,due,ai,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(projectId, String(title).trim(), role, prio, status, parseDue(due), ai ? 1 : 0, ts, ts);
  const task = getTask(Number(info.lastInsertRowid));
  emitNotification({ taskId: task.id, type: 'created', title: `New task: ${task.title}`, body: labelFor(task) });
  bus.emit('change', { kind: 'task.created', task });
  return task;
}

export function updateTask(id, patch = {}) {
  const cur = getTask(id);
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
  if (next.project_id !== cur.projectId && !getProject(next.project_id)) throw new Error(`Unknown projectId: ${next.project_id}`);
  const justCompleted = next.status === 'done' && cur.status !== 'done';
  const completed_at = next.status === 'done' ? (cur.completedAt || nowIso()) : null;
  db.prepare('UPDATE tasks SET project_id=?,title=?,role=?,prio=?,status=?,due=?,updated_at=?,completed_at=? WHERE id=?')
    .run(next.project_id, next.title, next.role, next.prio, next.status, next.due, nowIso(), completed_at, id);
  const task = getTask(id);
  if (justCompleted) emitNotification({ taskId: task.id, type: 'completed', title: `Completed: ${task.title}`, body: '' });
  else if (patch.status && patch.status !== cur.status) emitNotification({ taskId: task.id, type: 'status', title: `${task.title} → ${statusLabel(task.status)}`, body: '' });
  bus.emit('change', { kind: 'task.updated', task });
  return task;
}

export function cycleStatus(id) {
  const cur = getTask(id);
  if (!cur) throw new Error(`Unknown task id: ${id}`);
  const nextStatus = STATUSES[(STATUSES.indexOf(cur.status) + 1) % STATUSES.length];
  return updateTask(id, { status: nextStatus });
}

export function completeTask(id) {
  return updateTask(id, { status: 'done' });
}

export function deleteTask(id) {
  const t = getTask(id);
  if (!t) return false;
  db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  bus.emit('change', { kind: 'task.deleted', id });
  return true;
}

function statusLabel(s) {
  return { todo: 'To Do', inprogress: 'In Progress', done: 'Done' }[s] || s;
}
function labelFor(t) {
  const p = getProject(t.projectId);
  return `${p ? p.name.split(' — ')[0] : ''} · ${t.role} · due ${t.dueLabel}`;
}

// ---------------------------------------------------------------- notifications
export function emitNotification({ taskId = null, type, title, body = '' }) {
  const created_at = nowIso();
  const info = db.prepare('INSERT INTO notifications (task_id,type,title,body,read,created_at) VALUES (?,?,?,?,0,?)')
    .run(taskId, type, title, body, created_at);
  const notif = rowToNotif(db.prepare('SELECT * FROM notifications WHERE id = ?').get(Number(info.lastInsertRowid)));
  bus.emit('notification', notif);
  return notif;
}

export function listNotifications({ unreadOnly = false, limit = 50 } = {}) {
  const sql = 'SELECT * FROM notifications' + (unreadOnly ? ' WHERE read = 0' : '') + ' ORDER BY created_at DESC, id DESC LIMIT ?';
  return db.prepare(sql).all(limit).map(rowToNotif);
}
export function unreadCount() {
  return db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE read = 0').get().c;
}
export function markNotificationRead(id) {
  db.prepare('UPDATE notifications SET read = 1 WHERE id = ?').run(id);
  bus.emit('change', { kind: 'notification.read', id });
  return true;
}
export function markAllNotificationsRead() {
  db.prepare('UPDATE notifications SET read = 1 WHERE read = 0').run();
  bus.emit('change', { kind: 'notification.readAll' });
  return true;
}

// Does a "due_soon"/"overdue" notification already exist for this task today?
export function hasDueNotifToday(taskId, type) {
  const today = new Date().toISOString().slice(0, 10);
  const row = db.prepare(
    "SELECT 1 FROM notifications WHERE task_id = ? AND type = ? AND substr(created_at,1,10) = ? LIMIT 1"
  ).get(taskId, type, today);
  return !!row;
}

// ---------------------------------------------------------------- stats
export function stats() {
  const tasks = listTasks();
  const done = tasks.filter(t => t.status === 'done').length;
  const overdue = tasks.filter(t => t.status !== 'done' && t.daysUntil != null && t.daysUntil < 0).length;
  const dueSoon = tasks.filter(t => t.status !== 'done' && t.daysUntil != null && t.daysUntil >= 0 && t.daysUntil <= 2).length;
  return {
    total: tasks.length, done, overdue, dueSoon,
    inProgress: tasks.filter(t => t.status === 'inprogress').length,
    todo: tasks.filter(t => t.status === 'todo').length,
    pct: Math.round((done / (tasks.length || 1)) * 100),
    projects: listProjects().length,
    unread: unreadCount(),
  };
}

// ---------------------------------------------------------------- seed
export function seedIfEmpty() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM projects').get().c;
  if (count > 0) return false;
  const ts = nowIso();
  const projects = [
    { id: 'aurora', name: 'Aurora — SaaS Marketing Site', subtitle: 'Own product · launching Q3', color: '#3E52C9' },
    { id: 'finch',  name: 'Finch — Mobile App Launch',    subtitle: 'Own product · App Store rollout', color: '#A93C93' },
    { id: 'nordic', name: 'Nordic Coffee — Brand Refresh', subtitle: 'Client work · retainer', color: '#B7671A' },
    { id: 'growth', name: 'Growth & Ops',                 subtitle: 'Internal · ongoing', color: '#2A8062' },
  ];
  const insP = db.prepare('INSERT INTO projects (id,name,subtitle,color,ai,created_at) VALUES (?,?,?,?,0,?)');
  for (const p of projects) insP.run(p.id, p.name, p.subtitle, p.color, ts);

  // Dues are ISO dates. "Today" in the original mock is early July 2026.
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
    'INSERT INTO tasks (project_id,title,role,prio,status,due,ai,created_at,updated_at,completed_at) VALUES (?,?,?,?,?,?,0,?,?,?)'
  );
  for (const [pid, role, prio, due, title, status] of tasks) {
    insT.run(pid, title, role, prio, status, due, ts, ts, status === 'done' ? ts : null);
  }
  return true;
}

export { db };
