// Dashboard: task-completion analytics with a GitHub-style contribution heatmap.
'use strict';
const $ = s => document.querySelector(s);
const HEAT_COLORS = ['#EAE6DC', '#CDE9D3', '#93D0A0', '#4FA972', '#2A8062'];
const ROLE_META = {
  dev: { label: 'Dev', color: '#3E52C9' }, design: { label: 'Design', color: '#A93C93' },
  marketing: { label: 'Marketing', color: '#B7671A' }, seo: { label: 'SEO', color: '#2A8062' },
};
let scope = 'me';
let isAdmin = false;

async function api(path) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' } });
  if (res.status === 401) { location.href = '/'; throw new Error('unauth'); }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || res.statusText);
  return json;
}
const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const fmtDate = iso => new Date(iso + (iso.length === 10 ? 'T00:00:00' : '')).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

async function load() {
  const [summary, contrib] = await Promise.all([
    api('/api/analytics/summary?scope=' + scope),
    api('/api/analytics/contributions?scope=' + scope + '&days=371'),
  ]);
  isAdmin = summary.isAdmin;
  $('#scope-seg').style.display = isAdmin ? 'inline-flex' : 'none';
  $('#scope-note').textContent = scope === 'all' ? 'Across all accounts' : 'Your workspace';

  const streaks = computeStreaks(contrib.series);
  renderTiles(summary.totals, contrib.total, streaks);
  renderHeatmap(contrib);
  renderBreakdown(summary);
  renderRoles(summary.byRole);
  renderRecent(summary.recent);
}

function renderTiles(t, yearTotal, streaks) {
  const tiles = [
    { n: t.done, l: 'Tasks completed' },
    { n: t.pct + '<small>%</small>', l: 'Completion rate' },
    { n: streaks.current, l: 'Current streak (days)' },
    { n: streaks.longest, l: 'Longest streak (days)' },
    { n: t.inprogress, l: 'In progress' },
    { n: t.todo, l: 'To do' },
  ];
  $('#tiles').innerHTML = tiles.map(x => `<div class="tile"><div class="n">${x.n}</div><div class="l">${x.l}</div></div>`).join('');
}

function computeStreaks(series) {
  const set = new Set(series.filter(d => d.count > 0).map(d => d.date));
  const dayISO = d => d.toISOString().slice(0, 10);
  // longest
  const dates = [...set].sort();
  let longest = 0, run = 0, prev = null;
  for (const ds of dates) {
    if (prev) { const gap = (new Date(ds) - new Date(prev)) / 86400000; run = gap === 1 ? run + 1 : 1; }
    else run = 1;
    longest = Math.max(longest, run); prev = ds;
  }
  // current: count back from today (or yesterday if nothing today yet)
  let current = 0;
  const d = new Date(); d.setHours(0, 0, 0, 0);
  if (!set.has(dayISO(d))) d.setDate(d.getDate() - 1);
  while (set.has(dayISO(d))) { current++; d.setDate(d.getDate() - 1); }
  return { current, longest };
}

function renderHeatmap(contrib) {
  const counts = Object.fromEntries(contrib.series.map(d => [d.date, d.count]));
  const max = contrib.max || 0;
  const level = c => !c ? 0 : max <= 0 ? 1 : c / max <= 0.25 ? 1 : c / max <= 0.5 ? 2 : c / max <= 0.75 ? 3 : 4;
  const dayISO = d => d.toISOString().slice(0, 10);

  const end = new Date(); end.setHours(0, 0, 0, 0);
  const start = new Date(end); start.setDate(start.getDate() - 364);
  start.setDate(start.getDate() - start.getDay()); // align to Sunday

  const weeks = []; const monthAt = [];
  let cur = new Date(start), wi = 0, lastMonth = -1;
  while (cur <= end) {
    const col = [];
    for (let dow = 0; dow < 7; dow++) {
      if (cur > end) { col.push(null); }
      else {
        const iso = dayISO(cur);
        col.push({ iso, count: counts[iso] || 0 });
        if (dow === 0) {
          const m = cur.getMonth();
          if (m !== lastMonth) { monthAt.push({ wi, label: cur.toLocaleString(undefined, { month: 'short' }) }); lastMonth = m; }
        }
      }
      cur = new Date(cur); cur.setDate(cur.getDate() + 1);
    }
    weeks.push(col); wi++;
  }

  $('#heat-weeks').innerHTML = weeks.map(col => `<div class="heat-col">${
    col.map(cell => cell
      ? `<div class="cell" style="background:${HEAT_COLORS[level(cell.count)]}" title="${cell.count} completed on ${fmtDate(cell.iso)}"></div>`
      : `<div class="cell" style="background:transparent"></div>`).join('')
  }</div>`).join('');

  // month labels positioned by week index (each column = 12px cell + 3px gap = 15px)
  $('#heat-months').innerHTML = monthAt.map(m => `<span style="left:${m.wi * 15}px">${m.label}</span>`).join('');
  $('#heat-sub').textContent = `${contrib.total} task${contrib.total === 1 ? '' : 's'} completed in the last year`;
  $('#heat-title').textContent = scope === 'all' ? 'Task completions — all users' : 'Task completions';
}

function renderBreakdown(summary) {
  const el = $('#breakdown');
  if (summary.scope === 'all' && summary.byUser) {
    $('#breakdown-title').textContent = 'By user';
    el.innerHTML = summary.byUser.length ? summary.byUser.map(u => bar(u.name || u.email, u.done, u.total, '#3E52C9', u.pct)).join('') : '<div class="empty">No data.</div>';
  } else {
    $('#breakdown-title').textContent = 'By project';
    const list = summary.byProject || [];
    el.innerHTML = list.length ? list.map(p => bar(p.name, p.done, p.total, p.color, p.pct)).join('') : '<div class="empty">No projects yet.</div>';
  }
}
function renderRoles(byRole) {
  const el = $('#byrole');
  el.innerHTML = (byRole && byRole.length) ? byRole
    .sort((a, b) => b.total - a.total)
    .map(r => bar((ROLE_META[r.role] || { label: r.role }).label, r.done, r.total, (ROLE_META[r.role] || { color: '#8C8574' }).color, r.pct)).join('')
    : '<div class="empty">No data.</div>';
}
function bar(label, done, total, color, pct) {
  return `<div class="bar-row">
    <span class="bar-label">${esc(label)}</span>
    <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${color}"></div></div>
    <span class="bar-val">${done}/${total}</span>
  </div>`;
}
function renderRecent(recent) {
  const el = $('#recent');
  el.innerHTML = (recent && recent.length) ? recent.map(r => `
    <li>
      <span class="pill">✓ done</span>
      <span class="t">${esc(r.title)}</span>
      <span class="m">${esc(r.project)}${scope === 'all' ? ' · ' + esc(r.email) : ''} · ${fmtDate(r.completedAt.slice(0, 10))}</span>
    </li>`).join('') : '<li class="empty">No completed tasks yet.</li>';
}

function setScope(s) {
  scope = s;
  $('#scope-me').classList.toggle('on', s === 'me');
  $('#scope-all').classList.toggle('on', s === 'all');
  load().catch(e => console.error(e));
}

$('#scope-me').onclick = () => setScope('me');
$('#scope-all').onclick = () => setScope('all');
load().catch(e => { if (e.message !== 'unauth') console.error(e); });
