# Task List — Live

A living, database-backed, **multi-user** task list. What used to be a static
in-memory prototype is now a real application that runs both locally and on Vercel:

- **Accounts** — email + password sign-in. Every project, task, and notification is
  scoped to its owner, so accounts are fully isolated. Passwords are hashed with
  scrypt; sessions are httpOnly cookies. A new account starts with a sample workspace.
- **Database** — SQLite via **libSQL**. Locally it's a file (`data/tasklist.db`);
  on Vercel it's a hosted **Turso** database — same code, chosen by env vars.
- **Alive** — the UI polls for changes (every few seconds) and reflects mutations
  immediately, so edits from another tab or via the API show up on their own.
- **Notifications** — **due soon** / **overdue** alerts are generated on read
  (scan-on-read), plus events for created / completed / status changes. Shown as a
  notification bell, toasts, and (with permission) desktop notifications.
- **REST API** — a clean HTTP API over the same database, so any external tool can
  read and manage tasks.

## Requirements

- Node.js **22.x** (works on 18+; libSQL client, no native build).

## Run locally

```bash
npm install
npm start
```

Then open **http://localhost:4000**. Register an account and you're in.

- Uses a local SQLite file by default (`data/tasklist.db`), created on first run.
- Change the port with `PORT=5000 npm start`.
- Point at a different file with `TASKLIST_DB=/path/to/other.db`.
- Point at Turso instead of a file with `TURSO_DATABASE_URL` (+ `TURSO_AUTH_TOKEN`).
- Delete `data/tasklist.db` to start fresh.

Dev mode (auto-restart on file changes): `npm run dev`.

## Start automatically on boot (Windows)

Register the local server to launch (hidden) at every logon — no admin rights needed:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
```

This drops a shortcut in your Startup folder that runs [`scripts/start-hidden.vbs`](scripts/start-hidden.vbs),
which starts the server with no console window. Remove it with `scripts\uninstall-autostart.ps1`.

## Deploy to Vercel (with Turso)

Vercel is serverless, so it can't keep a local file — the database lives in **Turso**
(hosted libSQL). The API runs as a serverless function ([`api/[...path].js`](api/%5B...path%5D.js));
the frontend in `public/` is served statically. Config is in [`vercel.json`](vercel.json).

1. **Create a Turso database** and get its URL + token — easiest via the Turso CLI:
   ```bash
   turso db create tasklist
   turso db show tasklist --url          # -> libsql://... (TURSO_DATABASE_URL)
   turso db tokens create tasklist       # -> the auth token (TURSO_AUTH_TOKEN)
   ```
   (Or add the **Turso** integration from the Vercel Marketplace, which provisions a
   database and injects these env vars for you.)
2. **In Vercel → Project → Settings → Environment Variables**, add:
   - `TURSO_DATABASE_URL` = the `libsql://…` URL
   - `TURSO_AUTH_TOKEN` = the token
3. If your Vercel project was previously set to a framework preset, set **Framework
   Preset = Other** (or clear any custom Build Command). `vercel.json` already sets
   `framework: null` and an empty build — this is what fixes the old
   `react-scripts: command not found` error.
4. **Redeploy.** Open the app, register an account, done. The Turso database persists
   across deploys.

> Note: on serverless there's no background timer, so due/overdue notifications are
> generated when a user loads their data (scan-on-read) rather than on a schedule.

## Self-host instead (Railway / Render / Fly / Docker)

Prefer a long-running server with a plain file database? Use the [`Dockerfile`](Dockerfile):
mount a persistent volume at `/data` and set `TASKLIST_DB=/data/tasklist.db`.

```bash
docker build -t tasklist .
docker run -p 4000:4000 -v tasklist_data:/data tasklist
```

## REST API

Base URL: `http://localhost:4000` (or your deployment). Responses are JSON. Requests are
same-origin and carry the session cookie automatically. Everything except `/api/health`
and `/api/auth/*` **requires a logged-in session cookie** (`sid`).

### Auth

| Method | Path | Description |
| --- | --- | --- |
| POST | `/api/auth/register` | Create an account. Body: `{ email, password, name? }`. Sets the session cookie and seeds a sample workspace. |
| POST | `/api/auth/login` | Body: `{ email, password }`. Sets the session cookie. |
| POST | `/api/auth/logout` | Clears the session. |
| GET | `/api/auth/me` | `{ user }` for the current session, or `{ user: null }`. |

```bash
# Register (cookie jar keeps the session for later calls)
curl -c jar.txt -X POST http://localhost:4000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"me@example.com","password":"secret123","name":"Me"}'

# Use the session for subsequent requests
curl -b jar.txt http://localhost:4000/api/state
```

### Task shape

```json
{
  "id": 12, "projectId": "aurora", "title": "Build responsive nav",
  "role": "dev", "prio": "med", "status": "todo",
  "due": "2026-07-11", "dueLabel": "Jul 11", "daysUntil": 8,
  "ai": false, "createdAt": "…", "updatedAt": "…", "completedAt": null
}
```
- `role`: `dev` | `design` | `marketing` | `seo`
- `prio`: `high` | `med` | `low`
- `status`: `todo` | `inprogress` | `done`
- `due`: ISO `YYYY-MM-DD` (or `null`). On input, also accepts `"Jul 20"`.

### Endpoints

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/health` | Liveness check (no auth). |
| GET | `/api/state` | Everything at once: `{ user, projects, tasks, notifications, stats }`. Accepts the task filters below. Also runs the due-date scan. |
| GET | `/api/stats` | Counts: total, done, overdue, dueSoon, inProgress, todo, pct, projects, unread. |
| GET | `/api/projects` | List projects. |
| POST | `/api/projects` | Create. Body: `{ name, subtitle?, color?, ai? }`. |
| GET / DELETE | `/api/projects/:id` | Get / delete a project (delete cascades to its tasks). |
| GET | `/api/tasks` | List tasks. Query: `projectId`, `role`, `status`, `q` (title search). |
| POST | `/api/tasks` | Create. Body: `{ projectId, title, role?, prio?, due?, status?, ai? }`. |
| GET / PATCH / DELETE | `/api/tasks/:id` | Get / update / delete a task. |
| POST | `/api/tasks/:id/cycle` | Advance status todo → inprogress → done → todo. |
| POST | `/api/tasks/:id/complete` | Mark done. |
| GET | `/api/notifications` | List. Query: `unread=1`, `limit`. Also runs the scan. |
| POST | `/api/notifications/:id/read` | Mark one read. |
| POST | `/api/notifications/read-all` | Mark all read. |
| POST | `/api/notifications/scan` | Force a due-date scan now. |
| GET | `/api/notes` | List notes. Query: `limit`. |
| POST | `/api/notes` | Create. Body: `{ body, projectId? }`. |
| GET / PATCH / DELETE | `/api/notes/:id` | Get / update / delete a note. |
| GET | `/api/analytics/summary` | Totals, per-project/role breakdown, recent completions. Query `scope=me` (default) or `scope=all` (admin only). |
| GET | `/api/analytics/contributions` | Task completions grouped by day for the heatmap. Query `scope`, `days` (default 371). |

### Dashboard / admin

Open **`/admin.html`** (📊 in the app header) for an analytics dashboard: a
GitHub-style **contribution heatmap** of task completions, completion rate,
current/longest streaks, and per-project / per-role breakdowns.

Admins additionally get an **"All users"** scope (aggregate across every account,
with a per-user leaderboard). The first-registered account is made an admin
automatically; you can also set `ADMIN_EMAILS=a@x.com,b@y.com` to promote specific
accounts.

**Auth for non-browser clients:** `/api/auth/login` and `/api/auth/register` also
return a `token`. Send it as `Authorization: Bearer <token>` instead of the cookie
(this is how the Chrome extension authenticates). CORS is open for this reason.

## Chrome extension

In [`extension/`](extension/) there's a Manifest V3 extension that:

- **Opens the app as a tab when Chrome starts** (and once right after you install it).
- Gives you a **popup to quickly add a task** (project, role, priority, due) and
  **take notes**, without leaving the page you're on. Notes are saved to your account.

**Install it (unpacked):**

1. Make sure the app is running locally (`npm start`, at `http://localhost:4000`).
2. Go to `chrome://extensions`, turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select the `extension/` folder.
4. Click the extension's icon, **sign in** with your app email + password (the popup
   uses a token, since browser cookies don't reach an extension). You're set.

Notes:
- The extension talks to `http://localhost:4000`. If you run the app on a different
  port or host, edit `API`/`APP_URL` in `extension/popup.js` and `extension/background.js`
  and the `host_permissions` in `extension/manifest.json`, then reload the extension.
- "Open on startup" needs Chrome to have run the extension at least once.

## Project layout

```
server/
  db.js         async data layer (libSQL): users, sessions, projects, tasks,
                notifications, stats, per-user seed, scan-on-read
  handler.js    shared async API router (used by both entry points below)
  server.js     local Node server: static frontend + handler
api/
  [...path].js  Vercel serverless entry -> handler
public/
  index.html    the UI (auth screen + board)
  app.js        frontend logic (API calls + polling + notifications + sounds)
extension/
  manifest.json, background.js, popup.html, popup.js, icons/
                Chrome extension: quick-add tasks + notes, open app on startup
vercel.json     Vercel config (static from public/, API function, no build)
Dockerfile      optional self-hosting on a persistent host
data/            local SQLite file (gitignored on Vercel; not used there)
```

The original prototype (`Task List.dc.html`, `support.js`) is left untouched for reference.
