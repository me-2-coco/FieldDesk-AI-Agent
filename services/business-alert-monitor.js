const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const stages = [
  ['RECEIPT', 'recloudReceiptSyncStatus', 'recloudReceiptAttemptedAt', 90000],
  ['PROJECT', 'recloudProjectVerificationStatus', 'recloudProjectVerificationAttemptedAt', 120000],
  ['RECEIPT_ATTACHMENTS', 'recloudReceiptAttachmentSyncStatus', 'recloudReceiptAttachmentAttemptedAt', 180000],
  ['DETECTION', 'recloudDetectionSyncStatus', 'recloudDetectionAttemptedAt', 120000],
  ['SERVICE_ORDER', 'recloudServiceOrderSyncStatus', 'recloudServiceOrderAttemptedAt', 120000],
];
function observations(orders, tasks, now = Date.now()) {
  if (!Array.isArray(orders) || !Array.isArray(tasks)) throw new Error('ALERT_SNAPSHOT_INVALID');
  const result = [];
  const add = (rmaNo, stage, status, timestamp, timeout = 180000, identity = stage) => {
    if (!rmaNo) return;
    status = String(status || '').toUpperCase();
    const age = now - Date.parse(timestamp || '');
    const kind = ['RESULT_UNKNOWN', 'MANUAL_REVIEW'].includes(status) ? 'RESULT_UNKNOWN'
      : status === 'FAILED' ? 'FAILED'
      : ['PENDING', 'SUBMITTING', 'SYNCING', 'PROCESSING', 'RUNNING'].includes(status) && Number.isFinite(age) && age >= timeout ? 'STALLED' : null;
    result.push({ key: `${rmaNo}:${identity}`, rmaNo, stage, kind, success: ['CONFIRMED', 'SUCCESS'].includes(status) });
  };
  for (const order of orders) {
    if (['CANCELLED', 'DELETED'].includes(order.status)) continue;
    for (const [stage, status, timestamp, timeout] of stages) add(order.rmaNo, stage, order[status], order[timestamp] || order.updatedAt, timeout);
    const prep = order.recloudRepairPreparation;
    if (order.hold) add(order.rmaNo, 'HOLD', order.hold.status, order.hold.attemptedAt || order.updatedAt);
    if (prep) add(order.rmaNo, 'REPAIR_PREPARATION', prep.status, prep.startedAt || prep.updatedAt || order.updatedAt);
  }
  for (const task of tasks) add(task.rmaNo, task.nodeType, task.status, task.startedAt || task.updatedAt || task.createdAt, 180000, `task:${task.id}`);
  return result;
}

// A single reader owns this ledger. It never modifies business data or retries orders.
function createBusinessAlertMonitor({ file, notifier, now = Date.now }) {
  let state; let queue = Promise.resolve();
  async function save() {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomUUID()}.tmp`;
    const handle = await fs.open(temp, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(state)); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temp, file);
  }
  async function scan(orders, tasks) {
    const rows = observations(orders, tasks, now());
    if (!state) {
      try { state = JSON.parse(await fs.readFile(file, 'utf8')); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (!state) {
        // Baseline existing failures; do not flood the owner with historical backlog.
        state = { version: 1, entries: Object.fromEntries(rows.map(row => [row.key, { suppressed: !!row.kind }])) };
        await save(); return { baseline: true, delivered: 0 };
      }
      if (state.version !== 1 || !state.entries) throw new Error('ALERT_LEDGER_INVALID');
    }
    const events = [];
    for (const row of rows) {
      const entry = state.entries[row.key] ||= {};
      if (entry.suppressed) {
        if (row.success) entry.suppressed = false;
        else continue;
      }
      if (row.kind && (!entry.incident || entry.incident.status === 'RECOVERED')) {
        entry.incident = { id: randomUUID(), scope: 'BUSINESS', status: 'OPEN', rmaNo: row.rmaNo, stage: row.stage, kind: row.kind };
      } else if (row.success && entry.incident?.status === 'OPEN') {
        entry.incident.status = 'RECOVERED';
      }
      if (entry.incident) events.push({ ...entry.incident });
    }
    await save(); // Incident identity survives a crash before delivery.
    const results = [];
    for (const event of events) {
      try { results.push(await notifier.deliver(event)); }
      catch { results.push({ status: 'FAILED' }); }
    }
    return { baseline: false, delivered: results.filter(r => r.status === 'SENT').length,
      attention: results.filter(r => r.status !== 'SENT').length };
  }
  return { scan(orders, tasks) { const job = queue.then(() => scan(orders, tasks)); queue = job.catch(() => {}); return job; } };
}
module.exports = { observations, createBusinessAlertMonitor };
