const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
async function freePort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function until(read, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { try { const result = await read(); if (result) return result; } catch {} await new Promise(r => setTimeout(r, 50)); }
  throw Error('synthetic guardian timeout');
}
test('guardian restarts only its exited backend, refuses duplicate, and shuts down children', { timeout: 20000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fielddesk-guardian-'));
  const source = path.resolve(__dirname, '..');
  const files = ['scripts/start-service-guardian.js', 'scripts/start-business-alerts.js', 'services/service-recovery-policy.js', 'services/owned-service-process.js', 'services/monitor-health.js', 'services/business-alert-monitor.js', 'services/process-lock.js'];
  for (const file of files) { await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true }); await fs.copyFile(path.join(source, file), path.join(root, file)); }
  for (const [from, to] of [['guardian-backend.cjs', 'server.js'], ['guardian-notifier.cjs', 'services/feishu-alert-notifier.js'], ['guardian-entry.cjs', 'entry.cjs']]) await fs.copyFile(path.join(__dirname, 'fixtures', from), path.join(root, to));
  const data = path.join(root, 'database/data'); await fs.mkdir(data, { recursive: true });
  for (const file of ['receipt-preparations.json', 'recloud-sync-outbox.json']) await fs.writeFile(path.join(data, file), '[]');
  const port = await freePort(); let mutex = await freePort(); while (mutex === port) mutex = await freePort();
  const env = { PATH: process.env.PATH, PORT: String(port), FIELDDESK_GUARDIAN_PORT: String(mutex), FIELDDESK_GUARDIAN_ENABLED: 'true', FEISHU_BUSINESS_ALERTS_ENABLED: 'true', FEISHU_APP_ID: 'fake', FEISHU_APP_SECRET: 'fake', FEISHU_ALERT_OPEN_ID: 'fake' };
  const start = () => spawn(process.execPath, ['entry.cjs'], { cwd: root, env, stdio: 'ignore' });
  let child = start();
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const closed = once(child, 'close'); child.kill('SIGTERM'); await closed; } await fs.rm(root, { recursive: true, force: true }); });
  const health = async () => (await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500) })).json();
  const first = await until(health);
  const duplicate = start(); assert.equal((await once(duplicate, 'close'))[0], 1);
  const monitorFile = path.join(data, 'business-alerts/health.json');
  const monitor = await until(async () => JSON.parse(await fs.readFile(monitorFile)));
  process.kill(first.pid, 'SIGTERM');
  const second = await until(async () => { const current = await health(); return current.pid !== first.pid && current; });
  assert.notEqual(second.pid, first.pid);
  assert.equal(JSON.parse(await fs.readFile(monitorFile)).pid, monitor.pid);
  await until(async () => JSON.parse(await fs.readFile(path.join(data, 'service-guardian/BACKEND.json'))).events.some(e => e.status === 'RECOVERED'));
  process.kill(monitor.pid, 'SIGKILL');
  const restartedMonitor = await until(async () => { const current = JSON.parse(await fs.readFile(monitorFile)); return current.pid !== monitor.pid && current; });
  assert.equal((await health()).pid, second.pid);
  const crashed = once(child, 'close'); child.kill('SIGKILL'); await crashed;
  await until(async () => { try { await health(); return false; } catch { return true; } });
  await until(async () => { try { await fs.access(path.join(data, 'business-alerts/monitor.lock')); return false; } catch { return true; } });
  child = start();
  const afterGuardianRestart = await until(health);
  assert.notEqual(afterGuardianRestart.pid, second.pid);
  const finalMonitor = await until(async () => { const current = JSON.parse(await fs.readFile(monitorFile)); return current.pid !== restartedMonitor.pid && current; });
  const closed = once(child, 'close'); child.kill('SIGTERM'); await closed;
  await assert.rejects(health());
  assert.throws(() => process.kill(finalMonitor.pid, 0));
  assert.equal(await fs.readFile(path.join(data, 'receipt-preparations.json'), 'utf8'), '[]');
});
