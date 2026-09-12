const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { observations, createBusinessAlertMonitor } = require('../services/business-alert-monitor');
const { createAlertNotifier, createFeishuAlertSender } = require('../services/feishu-alert-notifier');
const row = status => ({ rmaNo: 'LAB-ALERT', recloudDetectionSyncStatus: status, updatedAt: '2026-01-01' });
async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fielddesk-business-alert-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const calls = [];
  const notifier = createAlertNotifier({ directory: path.join(dir, 'sent'), send: async alert => { calls.push({...alert}); return { messageId: 'fake' }; } });
  const create = () => createBusinessAlertMonitor({ file: path.join(dir, 'state.json'), notifier });
  return { calls, create, monitor: create() };
}
test('historical failures are suppressed until confirmed success and a new failure', async t => {
  const { monitor, calls } = await setup(t);
  await monitor.scan([row('FAILED')], []);
  await monitor.scan([row('FAILED')], []);
  await monitor.scan([row('PENDING')], []);
  assert.equal(calls.length, 0);
  await monitor.scan([row('CONFIRMED')], []);
  await monitor.scan([row('RESULT_UNKNOWN')], []);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, 'RESULT_UNKNOWN');
});
test('one incident survives reopen; only explicit success recovers; recurrence gets a new id', async t => {
  const { monitor, calls, create } = await setup(t);
  await monitor.scan([row('CONFIRMED')], []);
  await monitor.scan([row('FAILED')], []);
  const reopened = create();
  await reopened.scan([row('FAILED')], []);
  await reopened.scan([], []);
  assert.equal(calls.length, 1);
  await reopened.scan([row('CONFIRMED')], []);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].id, calls[0].id);
  assert.equal(calls[1].status, 'RECOVERED');
  await reopened.scan([row('FAILED')], []);
  assert.equal(calls.length, 3);
  assert.notEqual(calls[2].id, calls[0].id);
});
test('stage timeouts and outbox manual review are observed without reading private payload', () => {
  const now = Date.parse('2026-01-01T00:02:01Z');
  const rows = observations([row('SYNCING')], [{ id: 'task', rmaNo: 'LAB-2', nodeType: 'REPAIR_COMPLETED', status: 'MANUAL_REVIEW', payload: { phone: 'private' } }], now);
  assert.equal(rows.find(x => x.stage === 'DETECTION').kind, 'STALLED');
  assert.equal(rows.find(x => x.stage === 'REPAIR_COMPLETED').kind, 'RESULT_UNKNOWN');
  assert.ok(!JSON.stringify(rows).includes('private'));
  assert.equal(observations([row('SYNCING')], [], Date.parse('2026-01-01T00:01:59Z')).find(x => x.stage === 'DETECTION').kind, null);
});
test('invalid snapshot never emits recovery', async t => {
  const { monitor, calls } = await setup(t);
  await monitor.scan([], []); await monitor.scan([row('FAILED')], []);
  await assert.rejects(monitor.scan(null, []));
  assert.equal(calls.length, 1);
});
test('business sender uses fixed text and configured recipient, not arbitrary error text', async () => {
  const requests = [];
  const send = createFeishuAlertSender({ FEISHU_APP_ID: 'fake', FEISHU_APP_SECRET: 'fake', FEISHU_ALERT_OPEN_ID: 'ou_fake' }, async (url, opts) => {
    requests.push(JSON.parse(opts.body)); return { ok: true, status: 200, json: async () => requests.length % 2 ? {code:0,tenant_access_token:'fake'} : {code:0,data:{message_id:'fake'}} };
  });
  await send({ scope: 'BUSINESS', id: 'test', rmaNo: 'LAB-ALERT', stage: 'DETECTION', status: 'OPEN', kind: 'RESULT_UNKNOWN', message: 'private-customer-error' }, 'uuid');
  assert.equal(requests[1].receive_id, 'ou_fake');
  assert.match(requests[1].content, /不要重复提交/);
  assert.ok(!requests[1].content.includes('private-customer-error'));
  assert.ok(!requests[1].content.includes('隔离演练'));
});

test('sidecar starts on synthetic files, refuses duplicate ownership and releases lock', { timeout: 10000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fielddesk-alert-sidecar-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'receipt-preparations.json'), '[]');
  await fs.writeFile(path.join(dir, 'recloud-sync-outbox.json'), '[]');
  const env = { PATH: process.env.PATH, FIELDDESK_DATA_DIRECTORY: dir, FEISHU_BUSINESS_ALERTS_ENABLED: 'true', FEISHU_APP_ID: 'fake', FEISHU_APP_SECRET: 'fake', FEISHU_ALERT_OPEN_ID: 'fake' };
  const start = () => spawn(process.execPath, [path.join(__dirname, '../scripts/start-business-alerts.js')], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const child = start(); t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
  await new Promise((resolve, reject) => {
    let output = ''; const timeout = setTimeout(() => reject(Error('startup timeout')), 5000);
    child.stdout.on('data', chunk => { output += chunk; if (output.includes('BUSINESS_ALERTS: running')) { clearTimeout(timeout); resolve(); } });
    child.once('exit', () => { clearTimeout(timeout); reject(Error('unexpected exit')); });
  });
  const duplicate = start(); const [code] = await once(duplicate, 'exit'); assert.equal(code, 1);
  assert.equal((await fs.readFile(path.join(dir, 'business-alerts/monitor.lock'), 'utf8')), String(child.pid));
  const stopped = once(child, 'exit'); child.kill('SIGTERM'); await stopped;
  await assert.rejects(fs.access(path.join(dir, 'business-alerts/monitor.lock')));
  assert.equal(await fs.readFile(path.join(dir, 'receipt-preparations.json'), 'utf8'), '[]');
});
