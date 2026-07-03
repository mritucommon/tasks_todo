# Task List — Live

A living, database-backed task list. What used to be a static in-memory prototype
is now a real application:

- **Database** — projects, tasks, and notifications persist in SQLite (`data/tasklist.db`).
- **Alive** — a real HTTP server with a Server-Sent Events stream, so the UI updates
  in real time whenever anything changes (in the browser, from another tab, or via the API).
- **Notifications** — a background engine raises **due soon** and **overdue** alerts,
  plus events for created / completed / status changes. Shown as a notification bell,
  toasts, and (with permission) desktop notifications.
- **REST API** — a clean HTTP API over the same database, so any external tool or AI
  agent can read and manage tasks. (This is the surface you'd wrap in an MCP server later.)

Zero runtime dependencies — it runs on Node's built-in `node:sqlite` and `http` modules.

## Requirements

- Node.js **≥ 22.5** (uses the built-in `node:sqlite`). Tested on Node 24.

## Run

```bash
npm start
```

Then open **http://localhost:4000**.

- The database is created and seeded automatically on first run (`data/tasklist.db`).
- Change the port with `PORT=5000 npm start`.
- Use a different database file with `TASKLIST_DB=/path/to/other.db`.
- Delete `data/tasklist.db` to reset to seed data.

Dev mode (auto-restart on file changes): `npm run dev`.

## Start automatically on boot (Windows)

Register the server to launch (hidden) at every logon — no admin rights needed:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
```

This drops a shortcut in your Startup folder that runs [`scripts/start-hidden.vbs`](scripts/start-hidden.vbs),
which starts the server with no console window and logs to `data/autostart.log`.

- Start it now without rebooting: `wscript scripts\start-hidden.vbs`
- Remove auto-start: `powershell -ExecutionPolicy Bypass -File scripts\uninstall-autostart.ps1`

## REST API

Base URL: `http://localhost:4000`. All responses are JSON. CORS is open (`*`).

### Data shapes

**Task**
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
| GET | `/api/health` | Liveness check. |
| GET | `/api/state` | Everything at once: `{ projects, tasks, notifications, stats }`. Accepts the same task filters as below. |
| GET | `/api/stats` | Counts: total, done, overdue, dueSoon, inProgress, todo, pct, projects, unread. |
| GET | `/api/projects` | List projects. |
| POST | `/api/projects` | Create. Body: `{ name, subtitle?, color?, ai? }`. |
| GET | `/api/projects/:id` | One project. |
| DELETE | `/api/projects/:id` | Delete a project (and its tasks). |
| GET | `/api/tasks` | List tasks. Query: `projectId`, `role`, `status`, `q` (title search). |
| POST | `/api/tasks` | Create. Body: `{ projectId, title, role?, prio?, due?, status?, ai? }`. |
| GET | `/api/tasks/:id` | One task. |
| PATCH | `/api/tasks/:id` | Update any of `projectId, title, role, prio, status, due`. |
| DELETE | `/api/tasks/:id` | Delete a task. |
| POST | `/api/tasks/:id/cycle` | Advance status todo → inprogress → done → todo. |
| POST | `/api/tasks/:id/complete` | Mark done. |
| GET | `/api/notifications` | List. Query: `unread=1`, `limit`. |
| POST | `/api/notifications/:id/read` | Mark one read. |
| POST | `/api/notifications/read-all` | Mark all read. |
| POST | `/api/notifications/scan` | Force a due-date scan now (also runs every 60s). |
| GET | `/api/events` | **SSE stream** of `hello`, `change`, and `notification` events (each carries fresh `stats`). |

### Examples

```bash
# Create a task
curl -X POST http://localhost:4000/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"projectId":"aurora","title":"Ship the pricing page","role":"dev","prio":"high","due":"2026-07-09"}'

# Complete it
curl -X POST http://localhost:4000/api/tasks/29/complete

# What needs attention?
curl "http://localhost:4000/api/stats"

# Watch changes live
curl -N http://localhost:4000/api/events
```

## Project layout

```
server/
  db.js         data layer (SQLite): projects, tasks, notifications, stats, seed
  notifier.js   background due-soon / overdue scanner
  server.js     REST API + SSE + static file server
public/
  index.html    the live UI
  app.js        frontend logic (API calls + SSE + notifications)
data/            SQLite database file (created at runtime, gitignored)
```

The original prototype (`Task List.dc.html`, `support.js`) is left untouched for reference.
