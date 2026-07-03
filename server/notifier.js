// Background notification engine (multi-user).
// Scans every open, dated task across all accounts and raises due_soon /
// overdue notifications for its owner. De-duplicated per task+type+day.
import * as db from './db.js';

const DUE_SOON_DAYS = 2;

export function scanOnce() {
  let raised = 0;
  for (const t of db.allOpenTasks()) {
    if (t.daysUntil == null) continue;
    if (t.daysUntil < 0) {
      if (!db.hasDueNotifToday(t.userId, t.id, 'overdue')) {
        const n = Math.abs(t.daysUntil);
        db.emitNotification(t.userId, { taskId: t.id, type: 'overdue', title: `Overdue: ${t.title}`, body: `Was due ${t.dueLabel} (${n} day${n === 1 ? '' : 's'} ago)` });
        raised++;
      }
    } else if (t.daysUntil <= DUE_SOON_DAYS) {
      if (!db.hasDueNotifToday(t.userId, t.id, 'due_soon')) {
        const when = t.daysUntil === 0 ? 'today' : t.daysUntil === 1 ? 'tomorrow' : `in ${t.daysUntil} days`;
        db.emitNotification(t.userId, { taskId: t.id, type: 'due_soon', title: `Due ${when}: ${t.title}`, body: `Due ${t.dueLabel}` });
        raised++;
      }
    }
  }
  return raised;
}

let timer = null;
export function startNotifier({ intervalMs = 60_000 } = {}) {
  scanOnce();
  timer = setInterval(scanOnce, intervalMs);
  if (timer.unref) timer.unref();
  return () => clearInterval(timer);
}
