// Frontend for the live Task List. Talks to the REST API and subscribes to the
// SSE stream so the board updates in real time — including changes made by the
// API directly (e.g. an AI agent or another browser tab).
'use strict';

const API = '';               // same origin
const $ = sel => document.querySelector(sel);

const ROLE_META = {
  dev:       { label: 'Dev',       color: '#3E52C9', bg: '#ECEEFB' },
  design:    { label: 'Design',    color: '#A93C93', bg: '#FAEBF6' },
  marketing: { label: 'Marketing', color: '#B7671A', bg: '#FAF0E4' },
  seo:       { label: 'SEO',       color: '#2A8062', bg: '#E7F4EE' },
};
const PRIO = { high: { label: 'High', color: '#D24B3E' }, med: { label: 'Medium', color: '#E0982A' }, low: { label: 'Low', color: '#B7B0A0' } };
const STATUS = {
  todo:       { label: 'To Do',       color: '#8C8574', bg: '#EFEBE1' },
  inprogress: { label: 'In Progress', color: '#B07514', bg: '#FAF0E0' },
  done:       { label: 'Done',        color: '#2A8062', bg: '#E7F4EE' },
};
const ORDER = ['todo', 'inprogress', 'done'];
const NOTIF_COLOR = { overdue: '#D24B3E', due_soon: '#E0982A', completed: '#2A8062', created: '#3E52C9', status: '#6D4FCF', project: '#A93C93' };

const AI_TASKS = {
  dev: ['Add end-to-end tests for the checkout flow', 'Set up error monitoring with Sentry', 'Refactor auth to use refresh tokens', 'Add lazy-loading for below-the-fold images'],
  design: ['Design empty & error states', 'Run an accessibility contrast audit', 'Create a reusable icon set', 'Prototype the settings screen'],
  marketing: ['Draft a launch thread for social', 'Outline a customer case study', 'Plan a webinar to drive signups', 'Write a monthly product-update email'],
  seo: ['Build an internal linking map', 'Optimize title tags for top pages', 'Fix crawl errors in Search Console', 'Create an FAQ schema block'],
};
const AI_PROJECTS = ['Q4 Newsletter Revamp', 'Portfolio Site v2', 'Podcast Launch', 'Analytics Dashboard', 'Community Forum'];

// ---------------------------------------------------------------- local UI state
const ui = {
  view: 'list', activeProject: 'all', roleFilter: 'all',
  showTaskForm: false, showProjectForm: false, panelOpen: false,
  form: { title: '', projectId: '', role: 'dev', prio: 'med', due: '' },
  newProjectName: '',
};
let data = { projects: [], tasks: [], notifications: [], stats: {} };

// ---------------------------------------------------------------- api helpers
async function apiRaw(path, opts = {}) {
  const res = await fetch(API + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) { const err = new Error(json.error || res.statusText); err.status = res.status; throw err; }
  return json;
}
// App data calls: surface errors as toasts and bounce to login on 401.
async function api(path, opts = {}) {
  try { return await apiRaw(path, opts); }
  catch (e) {
    if (e.status === 401) showAuth();
    else toast('Error', e.message, '#D24B3E');
    throw e;
  }
}
async function refresh() {
  data = await api('/api/state');
  if (!ui.form.projectId && data.projects[0]) ui.form.projectId = data.projects[0].id;
  handleNewNotifications();
  setLive(true);
  render();
}
// Fire a mutation, then refresh immediately so the acting user sees it at once
// (polling would otherwise take up to POLL_MS to catch up).
async function act(path, opts) { await api(path, opts); await refresh(); }

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const timeAgo = iso => {
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return Math.floor(d / 60) + 'm ago';
  if (d < 86400) return Math.floor(d / 3600) + 'h ago';
  return Math.floor(d / 86400) + 'd ago';
};

// ---------------------------------------------------------------- render
function render() {
  renderOverall();
  renderTabs();
  renderProjectComposer();
  renderChips();
  renderViewToggle();
  renderTaskComposer();
  renderBoard();
  renderNotifications();
}

function renderOverall() {
  const s = data.stats;
  $('#ov-done').textContent = s.done ?? 0;
  $('#ov-total').textContent = s.total ?? 0;
  $('#ov-fill').style.width = (s.pct ?? 0) + '%';
}

function renderTabs() {
  const tabs = [{ id: 'all', name: 'All projects', ai: false, all: true }, ...data.projects];
  $('#tabs').innerHTML = tabs.map(p => {
    const active = ui.activeProject === p.id;
    const bg = active ? (p.all ? '#1B1A17' : p.color) : '#fff';
    const color = active ? '#fff' : '#5C554A';
    const border = active ? 'transparent' : '#E2DDD1';
    const dot = p.all ? '' : `<span class="dot" style="background:${p.color};display:inline-block"></span>`;
    const ai = p.ai ? `<span class="ai-tag" style="${active ? 'background:rgba(255,255,255,.22);color:#fff' : ''}">✦ AI</span>` : '';
    return `<button class="pill" data-proj="${p.id}" style="background:${bg};color:${color};border-color:${border}">${dot}${esc(p.name)}${ai}</button>`;
  }).join('') +
    `<button class="pill dashed" id="new-proj">+ New project</button>`;

  $('#tabs').querySelectorAll('[data-proj]').forEach(b =>
    b.onclick = () => { ui.activeProject = b.dataset.proj; render(); });
  $('#new-proj').onclick = () => { ui.showProjectForm = !ui.showProjectForm; renderProjectComposer(); };
}

function renderProjectComposer() {
  const el = $('#proj-composer');
  if (!ui.showProjectForm) { el.innerHTML = ''; return; }
  el.innerHTML = `
    <div class="composer row">
      <input class="fld" id="np-name" placeholder="Project name…" style="flex:1;min-width:220px" value="${esc(ui.newProjectName)}">
      <button class="btn-accent" id="np-create">Create project</button>
      <button class="btn-ai" id="np-ai">✦ Generate with AI</button>
      <button class="btn-ghost" id="np-cancel">Cancel</button>
    </div>`;
  const name = $('#np-name');
  name.oninput = e => ui.newProjectName = e.target.value;
  name.focus();
  $('#np-create').onclick = createProject;
  $('#np-ai').onclick = generateAiProject;
  $('#np-cancel').onclick = () => { ui.showProjectForm = false; ui.newProjectName = ''; renderProjectComposer(); };
  name.onkeydown = e => { if (e.key === 'Enter') createProject(); };
}

function renderChips() {
  const roleOrder = ['all', 'dev', 'design', 'marketing', 'seo'];
  const scoped = data.tasks.filter(t => ui.activeProject === 'all' || t.projectId === ui.activeProject);
  $('#chips').innerHTML = roleOrder.map(key => {
    const active = ui.roleFilter === key;
    const meta = key === 'all' ? { label: 'All', color: '#1B1A17', bg: '#1B1A17' } : ROLE_META[key];
    const count = key === 'all' ? scoped.length : scoped.filter(t => t.role === key).length;
    const bg = active ? (key === 'all' ? '#1B1A17' : meta.bg) : '#fff';
    const color = active ? (key === 'all' ? '#fff' : meta.color) : '#5C554A';
    const dot = key === 'all' ? '' : `<span class="dot" style="background:${meta.color}"></span>`;
    return `<button class="chip" data-role="${key}" style="background:${bg};color:${color};border-color:${active ? 'transparent' : '#E2DDD1'}">${dot}${meta.label}<span class="count">${count}</span></button>`;
  }).join('');
  $('#chips').querySelectorAll('[data-role]').forEach(b =>
    b.onclick = () => { ui.roleFilter = b.dataset.role; render(); });
}

function renderViewToggle() {
  $('#view-list').classList.toggle('on', ui.view === 'list');
  $('#view-kanban').classList.toggle('on', ui.view === 'kanban');
}

function renderTaskComposer() {
  const el = $('#task-composer');
  if (!ui.showTaskForm) { el.innerHTML = ''; return; }
  const opts = data.projects.map(p => `<option value="${p.id}" ${ui.form.projectId === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  el.innerHTML = `
    <div class="composer">
      <input class="fld title" id="f-title" placeholder="What needs doing?" value="${esc(ui.form.title)}">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
        <select class="fld" id="f-proj">${opts}</select>
        <select class="fld" id="f-role">
          ${Object.entries(ROLE_META).map(([k, v]) => `<option value="${k}" ${ui.form.role === k ? 'selected' : ''}>${v.label}</option>`).join('')}
        </select>
        <select class="fld" id="f-prio">
          <option value="high" ${ui.form.prio === 'high' ? 'selected' : ''}>High priority</option>
          <option value="med" ${ui.form.prio === 'med' ? 'selected' : ''}>Medium priority</option>
          <option value="low" ${ui.form.prio === 'low' ? 'selected' : ''}>Low priority</option>
        </select>
        <input class="fld" id="f-due" placeholder="Due (e.g. Jul 20 or 2026-07-20)" style="width:200px" value="${esc(ui.form.due)}">
        <div style="flex:1"></div>
        <button class="btn-accent" id="f-add">Add task</button>
      </div>
    </div>`;
  const t = $('#f-title'); t.focus();
  t.oninput = e => ui.form.title = e.target.value;
  t.onkeydown = e => { if (e.key === 'Enter') addTask(); };
  $('#f-proj').onchange = e => ui.form.projectId = e.target.value;
  $('#f-role').onchange = e => ui.form.role = e.target.value;
  $('#f-prio').onchange = e => ui.form.prio = e.target.value;
  $('#f-due').oninput = e => ui.form.due = e.target.value;
  $('#f-add').onclick = addTask;
}

function decorate(t, projById) {
  const done = t.status === 'done', inprog = t.status === 'inprogress';
  const overdue = t.status !== 'done' && t.daysUntil != null && t.daysUntil < 0;
  const rm = ROLE_META[t.role], st = STATUS[t.status], pr = projById[t.projectId] || {};
  return { ...t, done, inprog, overdue, rm, st, pr,
    dueColor: overdue ? '#D24B3E' : '#A19A8B',
    dueText: overdue ? `${t.dueLabel} ⚠` : t.dueLabel };
}

function renderBoard() {
  const board = $('#board');
  const projById = Object.fromEntries(data.projects.map(p => [p.id, p]));
  const roleOk = t => ui.roleFilter === 'all' || t.role === ui.roleFilter;
  const projOk = t => ui.activeProject === 'all' || t.projectId === ui.activeProject;

  if (ui.view === 'list') {
    const shown = data.projects.filter(p => ui.activeProject === 'all' || p.id === ui.activeProject);
    board.className = 'stack';
    board.innerHTML = shown.map(p => {
      const all = data.tasks.filter(t => t.projectId === p.id);
      const done = all.filter(t => t.status === 'done').length;
      const list = all.filter(roleOk).map(t => decorate(t, projById));
      const pct = Math.round((done / (all.length || 1)) * 100);
      const rows = list.length ? `<ul class="tasks">${list.map(rowHtml).join('')}</ul>`
        : `<div class="empty">No tasks match this filter.</div>`;
      const ai = p.ai ? `<span class="ai-tag">✦ AI</span>` : '';
      return `<section class="card">
        <div class="card-head">
          <div style="display:flex;align-items:center;gap:14px;min-width:0;">
            <span class="proj-bar" style="background:${p.color}"></span>
            <div style="display:flex;flex-direction:column;gap:2px;min-width:0;">
              <div style="display:flex;align-items:center;gap:8px;"><h2 class="proj-name">${esc(p.name)}</h2>${ai}</div>
              <span class="proj-sub">${esc(p.subtitle)}</span>
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:14px;flex-shrink:0;">
            <span style="font-size:13px;color:#78715F;font-weight:600;white-space:nowrap;">${done}/${all.length}</span>
            <div class="mini-track"><div class="mini-fill" style="background:${p.color};width:${pct}%"></div></div>
          </div>
        </div>${rows}</section>`;
    }).join('') || `<div class="empty">No projects yet — create one above.</div>`;
    bindTaskActions();
  } else {
    const kanban = data.tasks.filter(t => projOk(t) && roleOk(t)).map(t => decorate(t, projById));
    board.className = 'kboard';
    board.innerHTML = ORDER.map(key => {
      const st = STATUS[key];
      const list = kanban.filter(t => t.status === key);
      const cards = list.length ? list.map(kcardHtml).join('') : `<div class="empty" style="padding:14px 6px">Nothing here.</div>`;
      return `<div class="kcol">
        <div class="kcol-head"><span class="dot" style="width:9px;height:9px;border-radius:99px;background:${st.color}"></span>
          <span class="name">${st.label}</span><span class="cnt">${list.length}</span></div>${cards}</div>`;
    }).join('');
    bindTaskActions();
  }
}

function rowHtml(t) {
  const check = t.done ? '✓' : (t.inprog ? '•' : '');
  const checkStyle = t.done ? `background:var(--accent);border-color:var(--accent);color:#fff`
    : (t.inprog ? `border-color:var(--accent);color:var(--accent)` : '');
  const titleStyle = t.done ? 'color:#B0A99A;text-decoration:line-through;text-decoration-color:#C9C3B4' : 'color:#1B1A17';
  const ai = t.ai ? `<span class="ai-tag">✦ AI</span>` : '';
  const inprog = t.inprog ? `<span class="status-tag" style="background:${t.st.bg};color:${t.st.color}">In progress</span>` : '';
  return `<li class="row-task" data-id="${t.id}">
    <button class="check act-cycle" title="${t.st.label}" style="${checkStyle}">${check}</button>
    <span class="t-title" style="${titleStyle}">${esc(t.title)}</span>${ai}${inprog}
    <span class="due"><span class="pdot" style="background:${PRIO[t.prio].color}" title="${PRIO[t.prio].label}"></span>
      <span class="txt" style="color:${t.dueColor}">${esc(t.dueText)}</span></span>
    <span class="role-tag" style="background:${t.rm.bg};color:${t.rm.color}">${t.rm.label}</span>
    <button class="del act-del" title="Delete">✕</button>
  </li>`;
}

function kcardHtml(t) {
  const i = ORDER.indexOf(t.status);
  const titleStyle = t.done ? 'color:#B0A99A;text-decoration:line-through;text-decoration-color:#C9C3B4' : '';
  const ai = t.ai ? `<span class="ai-tag" style="margin-left:auto">✦ AI</span>` : '';
  return `<div class="kcard" data-id="${t.id}">
    <div style="display:flex;align-items:center;gap:7px;">
      <span style="width:8px;height:8px;border-radius:3px;background:${t.pr.color || '#ccc'};flex-shrink:0;"></span>
      <span class="kproj">${esc((t.pr.name || '').split(' — ')[0])}</span>${ai}</div>
    <span style="font-size:14.5px;font-weight:600;line-height:1.3;${titleStyle}">${esc(t.title)}</span>
    <div style="display:flex;align-items:center;gap:8px;">
      <span class="role-tag" style="min-width:0;background:${t.rm.bg};color:${t.rm.color};padding:3px 8px;">${t.rm.label}</span>
      <span class="pdot" style="width:6px;height:6px;border-radius:99px;background:${PRIO[t.prio].color}"></span>
      <span style="font-size:12px;color:${t.dueColor};font-weight:500;">${esc(t.dueText)}</span>
      <div style="flex:1"></div>
      <button class="kmove act-left" ${i === 0 ? 'disabled style="color:#D6D0C2"' : ''}>‹</button>
      <button class="kmove act-right" ${i === 2 ? 'disabled style="color:#D6D0C2"' : ''}>›</button>
    </div></div>`;
}

function bindTaskActions() {
  document.querySelectorAll('[data-id]').forEach(el => {
    const id = Number(el.dataset.id);
    el.querySelector('.act-cycle')?.addEventListener('click', () => act(`/api/tasks/${id}/cycle`, { method: 'POST' }));
    el.querySelector('.act-del')?.addEventListener('click', () => act(`/api/tasks/${id}`, { method: 'DELETE' }));
    el.querySelector('.act-left')?.addEventListener('click', () => moveTask(id, -1));
    el.querySelector('.act-right')?.addEventListener('click', () => moveTask(id, 1));
  });
}
async function moveTask(id, dir) {
  const t = data.tasks.find(x => x.id === id); if (!t) return;
  const i = Math.max(0, Math.min(2, ORDER.indexOf(t.status) + dir));
  await act(`/api/tasks/${id}`, { method: 'PATCH', body: { status: ORDER[i] } });
}

// ---------------------------------------------------------------- notifications UI
function renderNotifications() {
  const unread = data.notifications.filter(n => !n.read).length;
  const badge = $('#badge');
  badge.style.display = unread ? 'inline-flex' : 'none';
  badge.textContent = unread > 99 ? '99+' : unread;

  $('#panel').style.display = ui.panelOpen ? 'block' : 'none';
  if (!ui.panelOpen) return;
  const list = $('#panel-list');
  list.innerHTML = data.notifications.length ? data.notifications.map(n => `
    <div class="notif ${n.read ? '' : 'unread'}" data-nid="${n.id}">
      <span class="ndot" style="background:${NOTIF_COLOR[n.type] || '#A19A8B'}"></span>
      <div style="min-width:0;flex:1;">
        <div class="ntitle">${esc(n.title)}</div>
        ${n.body ? `<div class="nbody">${esc(n.body)}</div>` : ''}
        <div class="ntime">${timeAgo(n.createdAt)}</div>
      </div>
    </div>`).join('') : `<div class="empty">No notifications yet.</div>`;
  list.querySelectorAll('[data-nid]').forEach(el =>
    el.onclick = () => act(`/api/notifications/${el.dataset.nid}/read`, { method: 'POST' }));
}

// ---------------------------------------------------------------- mutations
async function addTask() {
  const f = ui.form;
  if (!f.title.trim()) return;
  await api('/api/tasks', { method: 'POST', body: { projectId: f.projectId, title: f.title, role: f.role, prio: f.prio, due: f.due } });
  ui.form.title = ''; ui.form.due = ''; ui.showTaskForm = false;
  renderTaskComposer();
  await refresh();
}
async function createProject() {
  const name = ui.newProjectName.trim();
  if (!name) return;
  const p = await api('/api/projects', { method: 'POST', body: { name } });
  ui.newProjectName = ''; ui.showProjectForm = false; ui.activeProject = p.id;
  renderProjectComposer();
  await refresh();
}
async function generateAiTask() {
  const roles = ['dev', 'design', 'marketing', 'seo'];
  const role = ui.roleFilter !== 'all' ? ui.roleFilter : roles[Math.floor(Math.random() * 4)];
  const pid = ui.activeProject !== 'all' ? ui.activeProject : data.projects[Math.floor(Math.random() * data.projects.length)]?.id;
  if (!pid) { toast('No project', 'Create a project first', '#E0982A'); return; }
  const used = data.tasks.map(t => t.title);
  const title = AI_TASKS[role].find(x => !used.includes(x)) || AI_TASKS[role][Math.floor(Math.random() * 4)];
  const dues = ['2026-07-21', '2026-07-24', '2026-07-28', '2026-08-01', '2026-08-05'];
  const prios = ['high', 'med', 'low'];
  await api('/api/tasks', { method: 'POST', body: { projectId: pid, role, title, prio: prios[Math.floor(Math.random() * 3)], due: dues[Math.floor(Math.random() * dues.length)], ai: true } });
  await refresh();
}
async function generateAiProject() {
  const used = data.projects.map(p => p.name);
  const name = AI_PROJECTS.find(x => !used.includes(x)) || (AI_PROJECTS[0] + ' ' + Date.now());
  const p = await api('/api/projects', { method: 'POST', body: { name, subtitle: 'Generated by AI', ai: true } });
  ui.newProjectName = ''; ui.showProjectForm = false; ui.activeProject = p.id;
  renderProjectComposer();
  await refresh();
}

// ---------------------------------------------------------------- toasts + desktop
function toast(title, body, color = '#6D4FCF') {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span class="tdot" style="background:${color}"></span><div><div class="tt">${esc(title)}</div>${body ? `<div class="tb">${esc(body)}</div>` : ''}</div>`;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.transition = 'opacity .3s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 4200);
}
function desktopNotify(n) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try { new Notification(n.title, { body: n.body, tag: 'task-' + n.id }); } catch {}
}

// ---------------------------------------------------------------- sounds
// Distinct Web Audio tones per event — no audio files (works under Vercel's CSP).
let audioCtx = null;
let masterGain = null;
let soundOn = localStorage.getItem('tl_sound') !== 'off';
const SOUND_VOLUME = 2.4; // master boost; a compressor/limiter keeps it from distorting
function initAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx && !masterGain) {
      masterGain = audioCtx.createGain();
      masterGain.gain.value = SOUND_VOLUME;
      const comp = audioCtx.createDynamicsCompressor(); // acts as a limiter when pushed loud
      masterGain.connect(comp).connect(audioCtx.destination);
    }
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  } catch {}
}
function beep(freq, startAt, dur, type = 'sine', peak = 0.5) {
  if (!audioCtx || !masterGain) return;
  const t = audioCtx.currentTime + startAt;
  const osc = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(masterGain);
  osc.start(t); osc.stop(t + dur + 0.03);
}
const SOUNDS = {
  // new task assigned — bright two-note rise
  assigned:  () => { beep(523.25, 0, 0.15, 'sine', 0.6); beep(783.99, 0.12, 0.2, 'sine', 0.6); },
  // task completed — happy major arpeggio C–E–G
  completed: () => { beep(523.25, 0, 0.14, 'triangle', 0.55); beep(659.25, 0.12, 0.14, 'triangle', 0.55); beep(783.99, 0.24, 0.26, 'triangle', 0.6); },
  // task delay / overdue — urgent low buzzer, descending, repeated
  delay:     () => { beep(440, 0, 0.18, 'square', 0.5); beep(330, 0.21, 0.26, 'square', 0.5); beep(330, 0.54, 0.28, 'square', 0.5); },
  // generic notification log — short blip
  log:       () => { beep(700, 0, 0.11, 'sine', 0.5); },
};
function playSound(kind) {
  if (!soundOn) return;
  initAudio();
  (SOUNDS[kind] || SOUNDS.log)();
}
function soundForNotif(type) {
  if (type === 'overdue' || type === 'due_soon') return 'delay';
  if (type === 'created') return 'assigned';
  if (type === 'completed') return 'completed';
  return 'log'; // status changes, new project, etc.
}
function setSoundBtn() {
  const b = document.getElementById('soundbtn');
  if (b) { b.textContent = soundOn ? '🔊' : '🔇'; b.title = `Sound alerts: ${soundOn ? 'on' : 'off'}`; }
}

// ---------------------------------------------------------------- live (polling)
// Serverless can't hold an SSE connection, so we poll /api/state. Polling also
// triggers scan-on-read, which is how due/overdue notifications get raised.
const POLL_MS = 4000;
let pollTimer = null;
let lastNotifId = 0;
let primed = false; // don't toast notifications that already existed on first load

function setLive(on) {
  const el = $('#live');
  el.className = on ? 'live' : 'live off';
  el.innerHTML = `<span class="ldot"></span> ${on ? 'Live' : 'Reconnecting…'}`;
}
function handleNewNotifications() {
  const notifs = data.notifications || [];
  const maxId = notifs.reduce((m, n) => Math.max(m, n.id), 0);
  if (!primed) { lastNotifId = maxId; primed = true; return; }
  const fresh = notifs.filter(n => n.id > lastNotifId).sort((a, b) => a.id - b.id);
  for (const n of fresh) {
    toast(n.title, n.body, NOTIF_COLOR[n.type] || '#6D4FCF');
    playSound(soundForNotif(n.type));
    if (!n.read) desktopNotify(n);
  }
  if (maxId > lastNotifId) lastNotifId = maxId;
}
function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => { refresh().catch(() => setLive(false)); }, POLL_MS);
}
function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

// ---------------------------------------------------------------- auth
let authMode = 'login';
function authError(msg) {
  const el = $('#auth-error');
  el.style.display = msg ? 'block' : 'none';
  el.textContent = msg || '';
}
function renderAuthMode() {
  const reg = authMode === 'register';
  $('#auth-name').style.display = reg ? 'block' : 'none';
  $('#auth-sub').textContent = reg ? 'Create your workspace' : 'Sign in to your workspace';
  $('#auth-submit').textContent = reg ? 'Create account' : 'Sign in';
  $('#auth-toggle-text').textContent = reg ? 'Already have an account?' : 'New here?';
  $('#auth-toggle').textContent = reg ? 'Sign in' : 'Create an account';
  $('#auth-pass').setAttribute('autocomplete', reg ? 'new-password' : 'current-password');
  authError('');
}
async function submitAuth() {
  const email = $('#auth-email').value.trim();
  const password = $('#auth-pass').value;
  const name = $('#auth-name').value.trim();
  if (!email || !password) { authError('Email and password are required'); return; }
  try {
    const path = authMode === 'register' ? '/api/auth/register' : '/api/auth/login';
    const body = authMode === 'register' ? { email, password, name } : { email, password };
    const { user } = await apiRaw(path, { method: 'POST', body });
    $('#auth-pass').value = '';
    enterApp(user);
  } catch (e) { authError(e.message); }
}
function showAuth() {
  stopPolling();
  $('#app').style.display = 'none';
  $('#userchip').style.display = 'none';
  $('#auth').style.display = 'flex';
  $('#auth-email').focus();
}
function enterApp(user) {
  $('#auth').style.display = 'none';
  $('#app').style.display = 'flex';
  $('#userchip').style.display = 'inline-flex';
  $('#uemail').textContent = user.email;
  $('#uavatar').textContent = (user.name || user.email).trim().charAt(0).toUpperCase() || '?';
  primed = false; lastNotifId = 0;          // re-prime notification tracking for this session
  refresh().then(startPolling).catch(() => {});
}

// ---------------------------------------------------------------- wire up
function init() {
  // app controls
  $('#view-list').onclick = () => { ui.view = 'list'; render(); };
  $('#view-kanban').onclick = () => { ui.view = 'kanban'; render(); };
  $('#add-task').onclick = () => { ui.showTaskForm = !ui.showTaskForm; if (ui.showTaskForm && ui.activeProject !== 'all') ui.form.projectId = ui.activeProject; renderTaskComposer(); };
  $('#ai-task').onclick = generateAiTask;
  $('#bellbtn').onclick = () => {
    ui.panelOpen = !ui.panelOpen;
    if (ui.panelOpen && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission();
    renderNotifications();
  };
  $('#markall').onclick = () => act('/api/notifications/read-all', { method: 'POST' });
  $('#logout').onclick = async () => { try { await apiRaw('/api/auth/logout', { method: 'POST' }); } catch {} showAuth(); };

  // sound toggle + unlock audio on the first user gesture (browser autoplay policy)
  setSoundBtn();
  $('#soundbtn').onclick = () => {
    soundOn = !soundOn;
    localStorage.setItem('tl_sound', soundOn ? 'on' : 'off');
    setSoundBtn();
    if (soundOn) playSound('log'); // preview when turning on
  };
  document.addEventListener('pointerdown', initAudio, { once: true });
  document.addEventListener('click', e => {
    if (ui.panelOpen && !e.target.closest('.bell')) { ui.panelOpen = false; renderNotifications(); }
  });

  // auth controls
  $('#auth-toggle').onclick = () => { authMode = authMode === 'login' ? 'register' : 'login'; renderAuthMode(); };
  $('#auth-submit').onclick = submitAuth;
  ['#auth-email', '#auth-pass', '#auth-name'].forEach(sel => $(sel).addEventListener('keydown', e => { if (e.key === 'Enter') submitAuth(); }));

  // decide which screen to show
  apiRaw('/api/auth/me').then(({ user }) => { if (user) enterApp(user); else showAuth(); }).catch(showAuth);
}
init();
