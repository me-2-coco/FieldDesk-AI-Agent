// Opt-in single-machine guardian. No business writes or unknown-result replay.
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { advance } = require('../services/service-recovery-policy');
const { createOwnedProcess } = require('../services/owned-service-process');
const { writeMonitorHealth } = require('../services/monitor-health');
const { clearDeadLock } = require('../services/process-lock');
const { createAlertNotifier, createFeishuAlertSender } = require('../services/feishu-alert-notifier');

async function portFree(port) {
  await new Promise((resolve, reject) => {
    const socket = net.createServer(); socket.once('error', reject);
    socket.listen(port, () => socket.close(resolve));
  });
}
async function main({ intervalMs = 10000 } = {}) {
  try { process.loadEnvFile?.(); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (process.env.FIELDDESK_GUARDIAN_ENABLED !== 'true') throw Error('GUARDIAN_NOT_ENABLED');
  if (process.env.FEISHU_BUSINESS_ALERTS_ENABLED !== 'true' || !process.env.FEISHU_ALERT_OPEN_ID || !process.env.FEISHU_APP_ID || !process.env.FEISHU_APP_SECRET) throw Error('ALERT_CONFIG_MISSING');
  const cwd = path.resolve(__dirname, '..');
  const data = path.resolve(process.env.FIELDDESK_DATA_DIRECTORY || path.join(cwd, 'database/data'));
  const directory = path.join(data, 'service-guardian');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  // Kernel-owned mutex is released even after SIGKILL, unlike a stale PID file.
  const mutex = net.createServer();
  const mutexPort = Number(process.env.FIELDDESK_GUARDIAN_PORT || 3011);
  if (!Number.isInteger(mutexPort) || mutexPort < 1 || mutexPort > 65535) throw Error('INVALID_MUTEX_PORT');
  await new Promise((resolve, reject) => { mutex.once('error', reject); mutex.listen(mutexPort, '127.0.0.1', resolve); });
  const lockFile = path.join(directory, 'guardian.lock');
  try { await writeMonitorHealth(lockFile, { pid: process.pid }); }
  catch (error) { await new Promise(resolve => mutex.close(resolve)); throw error; }
  const children = []; let stopping = false; let timer;
  const deliveries = new Set();
  const notified = new Set();
  const notifier = createAlertNotifier({ directory: path.join(directory, 'deliveries'), send: createFeishuAlertSender(process.env) });
  async function stop() {
    if (stopping) return; stopping = true; clearTimeout(timer);
    await Promise.all(children.map(c => c.process.stop()));
    await Promise.allSettled([...deliveries]);
    await Promise.all(children.map(c => c.output.close()));
    await fs.unlink(lockFile);
    await new Promise(resolve => mutex.close(resolve));
  }
  process.once('SIGTERM', () => stop().catch(() => { process.exitCode = 1; }));
  process.once('SIGINT', () => stop().catch(() => { process.exitCode = 1; }));
  try {
    const port = Number(process.env.PORT || 3000);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('INVALID_PORT');
    await portFree(port);
    // Require a clean handover from the existing business alert process.
    const monitorLock = path.join(data, 'business-alerts/monitor.lock');
    try { await fs.access(monitorLock); await clearDeadLock(monitorLock); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    for (const [name, script] of [['BACKEND', 'server.js'], ['ALERT_MONITOR', 'scripts/start-business-alerts.js']]) {
      const output = await fs.open(path.join(directory, `${name}.log`), 'a', 0o600);
      const file = path.join(directory, `${name}.json`);
      let saved;
      try { saved = JSON.parse(await fs.readFile(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (saved && (!saved.state || !Array.isArray(saved.state.starts) || !Array.isArray(saved.events))) throw Error('GUARDIAN_STATE_INVALID');
      // Retain restart budget across guardian restarts. HALTED requires operator review.
      if (saved && saved.state.phase !== 'HALTED') saved.state.phase = 'WAITING';
      children.push({ name, file, saved, process: createOwnedProcess({ script, cwd, env: process.env, output: output.fd }), output });
    }
    async function probe(item) {
      if (!item.process.alive) return { alive: false };
      if (item.name === 'BACKEND') {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(3000), redirect: 'error' });
          const body = await response.json();
          return { alive: true, healthy: response.ok && body.success === true && body.service === 'fielddesk-api' && body.pid === item.process.pid };
        } catch { return { alive: true, healthy: false }; }
      }
      try {
        const state = JSON.parse(await fs.readFile(path.join(data, 'business-alerts/health.json'), 'utf8'));
        const age = Date.now() - Date.parse(state.checkedAt || state.lastSuccessfulScanAt || '');
        const fresh = state.pid === item.process.pid && age >= 0 && age < 120000;
        return { alive: true, healthy: fresh && state.status === 'HEALTHY', restartable: !fresh };
      } catch { return { alive: true, healthy: false }; }
    }
    async function check(item) {
      if (stopping) return;
      const decision = advance(item.saved?.state, await probe(item), Date.now());
      const events = [...(item.saved?.events || []), ...decision.events];
      item.saved = { state: decision.state, events: events.slice(-20) };
      await writeMonitorHealth(item.file, item.saved);
      for (const event of item.saved.events) {
        const key = `${event.id}:${event.status}`;
        if (notified.has(key)) continue;
        notified.add(key);
        const delivery = notifier.deliver({ ...event, scope: 'INFRA', component: item.name }).catch(() => ({ status: 'FAILED' }))
          .then(result => { if (result.status !== 'SENT') console.error('GUARDIAN: notification needs review'); });
        deliveries.add(delivery); delivery.finally(() => deliveries.delete(delivery));
      }
      if (stopping) return;
      if (decision.action === 'STOP') {
        const pid = item.process.pid;
        await item.process.stop();
        // Only clean a lock belonging to this known, now-closed child.
        if (item.name === 'ALERT_MONITOR' && pid) {
          try { if (await fs.readFile(monitorLock, 'utf8') === String(pid)) await fs.unlink(monitorLock); }
          catch (e) { if (e.code !== 'ENOENT') throw e; }
        }
      }
      if (decision.action === 'START') item.process.start();
    }
    async function tick() {
      try {
        await Promise.all(children.map(check));
        await writeMonitorHealth(path.join(directory, 'health.json'), { pid: process.pid, status: 'HEALTHY', lastSuccessfulScanAt: new Date().toISOString() });
        if (!stopping) timer = setTimeout(tick, intervalMs);
      } catch { console.error('GUARDIAN: check failed; stopping owned services safely'); await stop(); process.exitCode = 1; }
    }
    await tick();
  } catch (error) { await stop(); throw error; }
}
if (require.main === module) main().catch(() => { console.error('GUARDIAN: startup failed; check ownership/configuration'); process.exitCode = 1; });
module.exports = { main };
