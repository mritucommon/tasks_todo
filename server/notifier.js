// Background notification engine.
// Periodically scans tasks and raises notifications for anything due soon or
// overdue. De-duplicated so a given task raises at most one due_soon and one
// overdue notification per calendar day.
import * as db from './db.js';

const DUE_SOON_DAYS = 2; // "due soon" window: today .. +2 days

export function scanOnce() {
  const tasks = db.listTasks();
  let raised = 0;
  for (const t of tasks) {
    if (t.status === 'done' || t.daysUntil == null) continue;
    if (t.daysUntil < 0) {
      if (!db.hasDueNotifToday(t.id, 'overdue')) {
        const n = Math.abs(t.daysUntil);
        db.emitNotification({
          taskId: t.id, type: 'overdue',
          title: `Overdue: ${t.title}`,
          body: `Was due ${t.dueLabel} (${n} day${n === 1 ? '' : 's'} ago)`,
        });
        raised++;
      }
    } else if (t.daysUntil <= DUE_SOON_DAYS) {
      if (!db.hasDueNotifToday(t.id, 'due_soon')) {
        const when = t.daysUntil === 0 ? 'today' : t.daysUntil === 1 ? 'tomorrow' : `in ${t.daysUntil} days`;
        db.emitNotification({
          taskId: t.id, type: 'due_soon',
          title: `Due ${when}: ${t.title}`,
          body: `Due ${t.dueLabel}`,
        });
        raised++;
      }
    }
  }
  return raised;
}

let timer = null;
export function startNotifier({ intervalMs = 60_000 } = {}) {
  scanOnce(); // run immediately on boot
  timer = setInterval(scanOnce, intervalMs);
  if (timer.unref) timer.unref();
  return () => clearInterval(timer);
}
