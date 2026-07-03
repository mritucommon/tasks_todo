// Employee chat: fast-polling 1:1 DMs with typing indicators, read receipts,
// edit / delete / forward, task sharing, and date/time history.
'use strict';
const $ = s => document.querySelector(s);
const POLL_MS = 1000;
const AV_COLORS = ['#3E52C9', '#A93C93', '#B7671A', '#2A8062', '#6D5BD0', '#0E7C86', '#C23B5B'];
const STATUS_META = { todo: { l: 'To Do', c: '#8C8574', b: '#EFEBE1' }, inprogress: { l: 'In Progress', c: '#B07514', b: '#FAF0E0' }, done: { l: 'Done', c: '#2A8062', b: '#E7F4EE' } };

let me = null, contacts = [], activePeer = null, messages = [], pending = [], pollTimer = null, lastTyping = 0, searchQ = '';

async function api(path, opts = {}) {
  const res = await fetch(path, { method: opts.method || 'GET', headers: { 'Content-Type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  if (res.status === 401) { location.href = '/'; throw new Error('unauth'); }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || res.statusText);
  return json;
}
const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const avColor = id => AV_COLORS[Math.abs(id) % AV_COLORS.length];
const initials = c => (c.name || c.email || '?').trim().charAt(0).toUpperCase();
const hhmm = iso => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
function dayLabel(iso) {
  const d = new Date(iso); d.setHours(0, 0, 0, 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((today - d) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

// ---------------------------------------------------------------- boot
async function boot() {
  const { user } = await api('/api/auth/me');
  if (!user) { location.href = '/'; return; }
  me = user;
  await refreshContacts();
  $('#search').oninput = e => { searchQ = e.target.value.toLowerCase(); renderContacts(); };
  $('#send').onclick = send;
  $('#attach').onclick = openShareTask;
  $('#back').onclick = () => { activePeer = null; $('#thread').style.display = 'none'; $('#empty').style.display = 'flex'; };
  $('#modal-x').onclick = closeModal;
  $('#modal-bg').onclick = e => { if (e.target.id === 'modal-bg') closeModal(); };
  const input = $('#input');
  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(120, input.scrollHeight) + 'px'; heartbeatTyping(); });
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  pollTimer = setInterval(poll, POLL_MS);
}

async function refreshContacts() { contacts = await api('/api/chat/contacts'); renderContacts(); }

function renderContacts() {
  const list = contacts.filter(c => !searchQ || (c.name || '').toLowerCase().includes(searchQ) || c.email.toLowerCase().includes(searchQ));
  $('#contacts').innerHTML = list.length ? list.map(c => `
    <div class="contact ${c.id === activePeer ? 'on' : ''}" data-id="${c.id}">
      <div class="av" style="background:${avColor(c.id)}">${esc(initials(c))}</div>
      <div class="c-main">
        <div class="c-top"><span class="c-name">${esc(c.name)}</span><span class="c-time">${c.lastAt ? hhmm(c.lastAt) : ''}</span></div>
        <div class="c-bot">
          <span class="c-last">${c.lastMine ? 'You: ' : ''}${esc(c.lastMessage || 'Say hi 👋')}</span>
          ${c.unread ? `<span class="c-badge">${c.unread}</span>` : ''}
        </div>
      </div>
    </div>`).join('') : '<div style="padding:20px;color:#B4AD9C;font-style:italic;">No other users yet.</div>';
  $('#contacts').querySelectorAll('[data-id]').forEach(el => el.onclick = () => openPeer(Number(el.dataset.id)));
}

function openPeer(id) {
  activePeer = id; messages = []; pending = [];
  const c = contacts.find(x => x.id === id) || {};
  $('#empty').style.display = 'none';
  $('#thread').style.display = 'flex';
  $('#peer-av').textContent = initials(c); $('#peer-av').style.background = avColor(id);
  $('#peer-name').textContent = c.name || c.email;
  $('#peer-status').textContent = '';
  $('#msgs').innerHTML = '';
  renderContacts();
  poll();
  $('#input').focus();
}

// ---------------------------------------------------------------- polling
async function poll() {
  try {
    const peer = activePeer;
    const data = await api('/api/chat/poll?peer=' + (peer || ''));
    contacts = data.contacts; renderContacts();
    if (peer && peer === activePeer) {
      messages = data.messages;
      const st = $('#peer-status');
      st.textContent = data.peerTyping ? 'typing…' : '';
      st.className = 'status' + (data.peerTyping ? ' typing' : '');
      renderMessages();
    }
  } catch (e) { if (e.message !== 'unauth') console.error(e); }
}

function renderMessages() {
  const box = $('#msgs');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  const all = [...messages, ...pending.filter(p => !messages.some(m => m.id === p.id))];
  let html = '', lastDay = '';
  for (const m of all) {
    const day = dayLabel(m.createdAt);
    if (day !== lastDay) { html += `<div class="divider">${day}</div>`; lastDay = day; }
    html += bubble(m);
  }
  box.innerHTML = html || '<div style="text-align:center;color:#B4AD9C;margin-top:40px;">No messages yet — say hello.</div>';
  box.querySelectorAll('[data-mid]').forEach(el => {
    const id = Number(el.dataset.mid);
    el.querySelector('.act-edit')?.addEventListener('click', () => editMsg(id));
    el.querySelector('.act-del')?.addEventListener('click', () => delMsg(id));
    el.querySelector('.act-fwd')?.addEventListener('click', () => openForward(id));
  });
  if (nearBottom) box.scrollTop = box.scrollHeight;
}

function bubble(m) {
  if (m.deleted) return `<div class="row ${m.mine ? 'mine' : ''}"><div class="bubble"><div class="txt deleted">🚫 This message was deleted</div><div class="meta">${hhmm(m.createdAt)}</div></div></div>`;
  const tick = m.pending ? '🕓' : m.mine ? (m.read ? '<span class="tick">✓✓</span>' : '✓') : '';
  const acts = typeof m.id === 'number' ? `<div class="acts">
      ${m.mine ? '<button class="act-edit" title="Edit">✎</button><button class="act-del" title="Delete">🗑</button>' : ''}
      <button class="act-fwd" title="Forward">↪</button>
    </div>` : '';
  return `<div class="row ${m.mine ? 'mine' : ''}"><div class="bubble" data-mid="${m.id}">
    ${acts}
    ${m.forwardedFrom ? '<div class="fwd">↪ Forwarded</div>' : ''}
    ${m.task ? taskCard(m.task) : ''}
    ${m.body ? `<div class="txt">${esc(m.body)}</div>` : ''}
    <div class="meta">${m.edited ? 'edited · ' : ''}${hhmm(m.createdAt)} ${tick}</div>
  </div></div>`;
}
function taskCard(t) {
  const s = STATUS_META[t.status] || STATUS_META.todo;
  return `<div class="taskcard">
    <div class="tt">📋 ${esc(t.title)}</div>
    <div class="tm">
      <span>${esc(t.project || '')}</span>
      <span class="chip" style="background:${s.b};color:${s.c}">${s.l}</span>
      ${t.dueLabel && t.dueLabel !== '—' ? `<span>· due ${esc(t.dueLabel)}</span>` : ''}
    </div>
  </div>`;
}

// ---------------------------------------------------------------- actions
async function send() {
  const input = $('#input');
  const body = input.value.trim();
  if (!body || !activePeer) return;
  input.value = ''; input.style.height = 'auto';
  const temp = { id: 'tmp' + Date.now(), mine: true, body, createdAt: new Date().toISOString(), pending: true };
  pending.push(temp); renderMessages();
  try {
    await api('/api/chat/messages', { method: 'POST', body: { to: activePeer, body } });
  } catch (e) { alert(e.message); }
  pending = pending.filter(p => p !== temp);
  poll();
}
let typingThrottle = 0;
function heartbeatTyping() {
  if (!activePeer) return;
  const now = Date.now();
  if (now - typingThrottle < 1500) return;
  typingThrottle = now;
  api('/api/chat/typing', { method: 'POST', body: { to: activePeer } }).catch(() => {});
}
async function editMsg(id) {
  const m = messages.find(x => x.id === id); if (!m) return;
  const next = prompt('Edit message:', m.body || '');
  if (next == null || !next.trim() || next.trim() === m.body) return;
  try { await api('/api/chat/messages/' + id, { method: 'PATCH', body: { body: next.trim() } }); poll(); }
  catch (e) { alert(e.message); }
}
async function delMsg(id) {
  if (!confirm('Delete this message?')) return;
  try { await api('/api/chat/messages/' + id, { method: 'DELETE' }); poll(); }
  catch (e) { alert(e.message); }
}

// ---------------------------------------------------------------- modal (forward / share)
function openModal(title) { $('#modal-title').textContent = title; $('#modal-bg').classList.add('on'); }
function closeModal() { $('#modal-bg').classList.remove('on'); }
function openForward(id) {
  openModal('Forward to…');
  $('#modal-list').innerHTML = contacts.map(c => `
    <div class="pick" data-fwd="${c.id}">
      <div class="av" style="width:34px;height:34px;background:${avColor(c.id)}">${esc(initials(c))}</div>
      <div><div class="pn">${esc(c.name)}</div><div class="ps">${esc(c.email)}</div></div>
    </div>`).join('') || '<div class="grp">No contacts</div>';
  $('#modal-list').querySelectorAll('[data-fwd]').forEach(el => el.onclick = async () => {
    const to = Number(el.dataset.fwd); closeModal();
    try { await api('/api/chat/forward', { method: 'POST', body: { id, to } }); if (to === activePeer) poll(); else await refreshContacts(); }
    catch (e) { alert(e.message); }
  });
}
async function openShareTask() {
  if (!activePeer) return;
  openModal('Share a task…');
  $('#modal-list').innerHTML = '<div class="grp">Loading…</div>';
  let tasks = [], projects = [];
  try { [tasks, projects] = await Promise.all([api('/api/tasks'), api('/api/projects')]); }
  catch (e) { $('#modal-list').innerHTML = '<div class="grp">' + esc(e.message) + '</div>'; return; }
  const pname = Object.fromEntries(projects.map(p => [p.id, p.name]));
  const byProj = {};
  for (const t of tasks) (byProj[t.projectId] = byProj[t.projectId] || []).push(t);
  let html = '';
  for (const pid of Object.keys(byProj)) {
    html += `<div class="grp">${esc(pname[pid] || pid)}</div>`;
    for (const t of byProj[pid]) {
      const s = STATUS_META[t.status] || STATUS_META.todo;
      html += `<div class="pick" data-task="${t.id}"><div style="min-width:0;">
        <div class="pn">${esc(t.title)}</div>
        <div class="ps"><span class="chip" style="background:${s.b};color:${s.c}">${s.l}</span>${t.dueLabel && t.dueLabel !== '—' ? ' · due ' + esc(t.dueLabel) : ''}</div>
      </div></div>`;
    }
  }
  $('#modal-list').innerHTML = html || '<div class="grp">No tasks to share</div>';
  $('#modal-list').querySelectorAll('[data-task]').forEach(el => el.onclick = async () => {
    const taskId = Number(el.dataset.task); closeModal();
    try { await api('/api/chat/share', { method: 'POST', body: { to: activePeer, taskId } }); poll(); }
    catch (e) { alert(e.message); }
  });
}

boot().catch(e => { if (e.message !== 'unauth') console.error(e); });
