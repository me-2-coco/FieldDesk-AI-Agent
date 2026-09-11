const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { createAlertNotifier, createFeishuAlertSender } = require('../services/feishu-alert-notifier');
const { superviseLab } = require('../scripts/lab-supervisor');
async function dir(t) { const d = await fs.mkdtemp(path.join(os.tmpdir(), 'fielddesk-notify-test-')); t.after(() => fs.rm(d, { recursive: true, force: true })); return d; }
const alert = { id: 'synthetic-incident', status: 'OPEN' };
test('concurrent duplicate and reopened sender do not resend; recovery has separate key', async t => {
  const directory = await dir(t); let calls = 0;
  const send = async () => { calls++; return { messageId: 'synthetic-message' }; };
  const notifier = createAlertNotifier({ directory, send });
  const results = await Promise.all(Array.from({ length: 10 }, () => notifier.deliver(alert)));
  assert.ok(results.every(r => r.status === 'SENT')); assert.equal(calls, 1);
  await createAlertNotifier({ directory, send }).deliver(alert); assert.equal(calls, 1);
  await notifier.deliver({ ...alert, status: 'RECOVERED' }); assert.equal(calls, 2);
});
test('explicit rate limit retries with same identifier and bounded delay', async t => {
  const directory = await dir(t); const ids = [], delays = [];
  const notifier = createAlertNotifier({ directory, sleep: async ms => delays.push(ms), send: async (_, id) => {
    ids.push(id); if (ids.length < 3) throw Object.assign(new Error('busy'), { retryable: true }); return { messageId: 'ok' };
  } });
  assert.equal((await notifier.deliver(alert)).status, 'SENT');
  assert.deepEqual(delays, [3000, 6000]); assert.equal(new Set(ids).size, 1);
});
test('uncertain response persists and is never blindly repeated', async t => {
  const directory = await dir(t); let calls = 0;
  const notifier = createAlertNotifier({ directory, send: async () => { calls++; throw Object.assign(new Error('timeout'), { unknown: true }); } });
  assert.equal((await notifier.deliver(alert)).status, 'UNKNOWN');
  await notifier.deliver(alert); assert.equal(calls, 1);
});
test('supervisor exhaustion reaches notifier without external network', async t => {
  const directory = await dir(t); let calls = 0;
  const guard = superviseLab('/nonexistent-fielddesk-notification-worker.js', { cwd: directory, env: { PATH: process.env.PATH }, maxRestarts: 0,
    alertFile: path.join(directory, 'alert.json'), notifier: createAlertNotifier({ directory: path.join(directory, 'delivery'), send: async () => { calls++; return { messageId: 'synthetic' }; } }),
  });
  t.after(() => guard.stop());
  const [result] = await once(guard, 'notificationResult');
  assert.equal(result.status, 'SENT'); assert.equal(calls, 1);
});
test('Feishu transport uses configured recipient and excludes arbitrary error/customer text', async () => {
  const requests = [];
  const send = createFeishuAlertSender({ FEISHU_APP_ID: 'fake', FEISHU_APP_SECRET: 'fake', FEISHU_ALERT_OPEN_ID: 'ou_fake' }, async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return { ok: true, status: 200, json: async () => requests.length === 1 ? { code: 0, tenant_access_token: 'fake' } : { code: 0, data: { message_id: 'fake' } } };
  });
  assert.equal((await send({ ...alert, message: 'private-customer-data' }, 'dedup')).messageId, 'fake');
  assert.equal(requests[1].body.receive_id, 'ou_fake');
  assert.ok(!requests[1].body.content.includes('private-customer-data'));
});
