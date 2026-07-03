// Background service worker.
// - Opens the app as a tab on Chrome startup / install.
// - Adds a keyboard shortcut (Alt+Shift+T) and right-click menu to create a
//   task from the selected text (or page title) on ANY page.
// - Injects a small in-page overlay to confirm/edit the task, and performs the
//   authenticated API calls here (so it works regardless of the page's origin/CORS).
const APP_URL = 'http://localhost:4000';

function openApp() { chrome.tabs.create({ url: APP_URL }); }
chrome.runtime.onStartup.addListener(openApp);

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') openApp();
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'task-from-selection', title: 'Create task from “%s”', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'task-from-page', title: 'Create task from this page', contexts: ['page', 'link', 'image'] });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const prefill = (info.selectionText || tab?.title || '').trim();
  if (tab?.id != null) openQuickAdd(tab.id, prefill);
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'create-task') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  let prefill = '';
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => (window.getSelection ? window.getSelection().toString() : ''),
    });
    prefill = (res?.result || '').trim();
  } catch { /* selection capture failed; fall back to title */ }
  if (!prefill) prefill = (tab.title || '').trim();
  openQuickAdd(tab.id, prefill);
});

async function openQuickAdd(tabId, prefill) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: quickAddOverlay, args: [prefill || '', APP_URL] });
  } catch {
    // Can't inject here (e.g. chrome:// pages, the web store) — open the app instead.
    openApp();
  }
}

// ---- API calls on behalf of the injected overlay ----
async function apiFetch(path, method, body, token) {
  const res = await fetch(APP_URL + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || res.statusText);
  return json;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      const token = (await chrome.storage.local.get('token')).token || null;
      if (msg.type === 'quickadd:init') {
        if (!token) return sendResponse({ authed: false });
        const me = await apiFetch('/api/auth/me', 'GET', null, token);
        if (!me.user) return sendResponse({ authed: false });
        const projects = await apiFetch('/api/projects', 'GET', null, token);
        return sendResponse({ authed: true, projects });
      }
      if (msg.type === 'quickadd:create') {
        if (!token) return sendResponse({ ok: false, error: 'Not signed in' });
        const task = await apiFetch('/api/tasks', 'POST', msg.task, token);
        return sendResponse({ ok: true, task });
      }
    } catch (e) {
      sendResponse({ ok: false, offline: true, error: e.message || 'Could not reach the app' });
    }
  })();
  return true; // keep the message channel open for the async response
});

// ---- injected into the active page (runs in an isolated world) ----
function quickAddOverlay(prefill, appUrl) {
  const HOST_ID = '__tasklist_quickadd__';
  const existing = document.getElementById(HOST_ID);
  if (existing) existing.remove();

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.all = 'initial';
  host.style.position = 'fixed';
  host.style.top = '18px';
  host.style.right = '18px';
  host.style.zIndex = '2147483647';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      * { box-sizing: border-box; font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; }
      .card { width: 320px; background: #FFFFFF; color: #1B1A17; border: 1px solid #EAE6DC;
        border-radius: 14px; box-shadow: 0 20px 50px -18px rgba(20,16,8,.45); padding: 14px; }
      .hd { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
      .hd b { font-size: 14px; }
      .x { border: none; background: #F1EEE6; color: #78715F; border-radius: 7px; width: 24px; height: 24px; cursor: pointer; font-size: 14px; }
      label { display: block; font-size: 11px; font-weight: 600; color: #78715F; margin: 8px 0 4px; }
      textarea, select, input { width: 100%; font-size: 13.5px; border: 1px solid #E2DDD1; border-radius: 8px; padding: 8px 10px; outline: none; background: #F7F5F0; color: #1B1A17; }
      textarea { resize: vertical; min-height: 48px; }
      textarea:focus, select:focus, input:focus { border-color: #B4471F; }
      .row { display: flex; gap: 8px; }
      .row > div { flex: 1; }
      .add { width: 100%; margin-top: 12px; border: none; background: #B4471F; color: #fff; font-weight: 600; font-size: 14px; padding: 10px; border-radius: 9px; cursor: pointer; }
      .add:disabled { opacity: .55; cursor: default; }
      .status { font-size: 12px; margin-top: 8px; min-height: 15px; color: #2A8062; font-weight: 600; }
      .status.err { color: #C13A2C; }
      .signin { font-size: 12.5px; color: #78715F; }
      .link { color: #B4471F; font-weight: 600; cursor: pointer; text-decoration: underline; background: none; border: none; padding: 0; }
    </style>
    <div class="card">
      <div class="hd"><b>＋ New task</b><button class="x" id="qa-x" title="Close (Esc)">✕</button></div>
      <div id="qa-form">
        <label>Task</label>
        <textarea id="qa-title"></textarea>
        <label>Project</label>
        <select id="qa-project"><option>Loading…</option></select>
        <div class="row">
          <div>
            <label>Role</label>
            <select id="qa-role"><option value="dev">Dev</option><option value="design">Design</option><option value="marketing">Marketing</option><option value="seo">SEO</option></select>
          </div>
          <div>
            <label>Priority</label>
            <select id="qa-prio"><option value="high">High</option><option value="med" selected>Medium</option><option value="low">Low</option></select>
          </div>
        </div>
        <label>Due (optional)</label>
        <input id="qa-due" placeholder="e.g. Jul 20 or 2026-07-20">
        <button class="add" id="qa-add" disabled>Add task</button>
        <div class="status" id="qa-status"></div>
      </div>
      <div id="qa-signin" style="display:none">
        <p class="signin">Sign in through the extension popup first (click the toolbar icon), then try again.</p>
        <button class="link" id="qa-open">Open the app →</button>
      </div>
    </div>`;
  document.documentElement.appendChild(host);

  const $ = s => root.querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const status = $('#qa-status');
  const titleEl = $('#qa-title');
  titleEl.value = prefill || '';

  function close() { host.remove(); document.removeEventListener('keydown', onKey, true); }
  function onKey(e) { if (e.key === 'Escape') { close(); } }
  document.addEventListener('keydown', onKey, true);
  $('#qa-x').onclick = close;
  $('#qa-open').onclick = () => window.open(appUrl, '_blank');

  chrome.runtime.sendMessage({ type: 'quickadd:init' }, (resp) => {
    if (!resp) { status.textContent = 'Extension error — reload the extension.'; status.className = 'status err'; return; }
    if (resp.offline) { status.textContent = 'App not running at localhost:4000.'; status.className = 'status err'; return; }
    if (!resp.authed) { $('#qa-form').style.display = 'none'; $('#qa-signin').style.display = 'block'; return; }
    const sel = $('#qa-project');
    sel.innerHTML = (resp.projects || []).map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('') || '<option value="">No projects</option>';
    $('#qa-add').disabled = false;
  });

  $('#qa-add').onclick = () => {
    const title = titleEl.value.trim();
    if (!title) { titleEl.focus(); return; }
    $('#qa-add').disabled = true;
    status.className = 'status'; status.textContent = 'Adding…';
    chrome.runtime.sendMessage({
      type: 'quickadd:create',
      task: { projectId: $('#qa-project').value, title, role: $('#qa-role').value, prio: $('#qa-prio').value, due: $('#qa-due').value.trim() },
    }, (resp) => {
      if (resp && resp.ok) { status.textContent = '✓ Task added'; setTimeout(close, 900); }
      else { $('#qa-add').disabled = false; status.className = 'status err'; status.textContent = (resp && resp.error) || 'Failed to add task'; }
    });
  };

  setTimeout(() => { titleEl.focus(); titleEl.select(); }, 30);
}
