// Popup logic: sign in (token auth), quick-add tasks, and take notes — all
// talking to the local Task List API. Token is stored in chrome.storage.local.
const API = 'http://localhost:4000';
const $ = s => document.querySelector(s);

const getToken   = async () => (await chrome.storage.local.get('token')).token || null;
const setToken   = async t => chrome.storage.local.set({ token: t });
const clearToken = async () => chrome.storage.local.remove('token');

async function api(path, opts = {}) {
  const token = await getToken();
  let res;
  try {
    res = await fetch(API + path, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw Object.assign(new Error('Cannot reach the app'), { offline: true });
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.error || res.statusText), { status: res.status });
  return json;
}

function show(view) { ['offline', 'login', 'main'].forEach(v => { $('#' + v).style.display = v === view ? (v === 'main' ? 'block' : 'block') : 'none'; }); }
const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const timeAgo = iso => {
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return Math.floor(d / 60) + 'm ago';
  if (d < 86400) return Math.floor(d / 3600) + 'h ago';
  return Math.floor(d / 86400) + 'd ago';
};
const openApp = () => chrome.tabs.create({ url: API });

// ---------------------------------------------------------------- boot
async function boot() {
  try {
    const { user } = await api('/api/auth/me');
    if (user) return enterMain(user);
    show('login');
  } catch (e) {
    show(e.offline ? 'offline' : 'login');
  }
}

// ---------------------------------------------------------------- login
async function doLogin() {
  const email = $('#login-email').value.trim();
  const password = $('#login-pass').value;
  const err = $('#login-err');
  err.style.display = 'none';
  if (!email || !password) { err.textContent = 'Email and password are required'; err.style.display = 'block'; return; }
  try {
    const { user, token } = await api('/api/auth/login', { method: 'POST', body: { email, password } });
    await setToken(token);
    $('#login-pass').value = '';
    enterMain(user);
  } catch (e) {
    err.textContent = e.offline ? 'Cannot reach the app at localhost:4000.' : e.message;
    err.style.display = 'block';
  }
}

// ---------------------------------------------------------------- main
async function enterMain(user) {
  show('main');
  $('#email').textContent = user.email;
  $('#avatar').textContent = (user.name || user.email).trim().charAt(0).toUpperCase() || '?';
  await loadProjects();
  await loadNotes();
}

async function loadProjects() {
  try {
    const projects = await api('/api/projects');
    const optsTask = projects.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
    $('#t-project').innerHTML = optsTask || '<option value="">No projects — create one in the app</option>';
    $('#n-project').innerHTML = '<option value="">No project</option>' + optsTask;
  } catch { /* offline handled elsewhere */ }
}

async function addTask() {
  const title = $('#t-title').value.trim();
  const ok = $('#t-ok');
  if (!title) { $('#t-title').focus(); return; }
  const body = {
    projectId: $('#t-project').value,
    title, role: $('#t-role').value, prio: $('#t-prio').value, due: $('#t-due').value.trim(),
  };
  try {
    await api('/api/tasks', { method: 'POST', body });
    $('#t-title').value = ''; $('#t-due').value = '';
    ok.textContent = '✓ Task added'; setTimeout(() => (ok.textContent = ''), 2000);
    $('#t-title').focus();
  } catch (e) { ok.textContent = ''; alert(e.message); }
}

async function loadNotes() {
  try {
    const notes = await api('/api/notes?limit=30');
    $('#n-list').innerHTML = notes.length ? notes.map(n => `
      <div class="note">
        <div class="body">${esc(n.body)}</div>
        <div class="meta"><span class="time">${timeAgo(n.updatedAt || n.createdAt)}</span>
          <button class="del" data-id="${n.id}">Delete</button></div>
      </div>`).join('') : '<div class="empty">No notes yet.</div>';
    $('#n-list').querySelectorAll('.del').forEach(b => b.onclick = () => deleteNote(Number(b.dataset.id)));
  } catch { /* ignore */ }
}

async function addNote() {
  const body = $('#n-body').value.trim();
  const ok = $('#n-ok');
  if (!body) { $('#n-body').focus(); return; }
  try {
    await api('/api/notes', { method: 'POST', body: { body, projectId: $('#n-project').value || null } });
    $('#n-body').value = '';
    ok.textContent = '✓ Saved'; setTimeout(() => (ok.textContent = ''), 1500);
    await loadNotes();
  } catch (e) { alert(e.message); }
}

async function deleteNote(id) {
  try { await api(`/api/notes/${id}`, { method: 'DELETE' }); await loadNotes(); }
  catch (e) { alert(e.message); }
}

async function doLogout() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
  await clearToken();
  show('login');
}

// ---------------------------------------------------------------- tabs
function setTab(which) {
  $('#tab-task').classList.toggle('on', which === 'task');
  $('#tab-note').classList.toggle('on', which === 'note');
  $('#view-task').style.display = which === 'task' ? 'block' : 'none';
  $('#view-note').style.display = which === 'note' ? 'block' : 'none';
}

// ---------------------------------------------------------------- wire up
$('#login-btn').onclick = doLogin;
$('#login-pass').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
$('#login-email').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
$('#login-open').onclick = e => { e.preventDefault(); openApp(); };
$('#retry').onclick = boot;
$('#offline-open').onclick = openApp;
$('#open-app').onclick = openApp;
$('#logout').onclick = doLogout;
$('#tab-task').onclick = () => setTab('task');
$('#tab-note').onclick = () => setTab('note');
$('#t-add').onclick = addTask;
$('#t-title').addEventListener('keydown', e => { if (e.key === 'Enter') addTask(); });
$('#n-add').onclick = addNote;

boot();
