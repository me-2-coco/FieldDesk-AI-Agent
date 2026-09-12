const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { JsonReceiptPreparationStore } = require('../database/receipt-preparation-store');
const { createApp } = require('../server');
const { readRmaHoldSnapshot } = require('../connectors/recloud');
const rmaNo = 'JXTH-LAB-HOLD';
const hold = { status: 'RESULT_UNKNOWN', category: '保内', reason: '网点缺件', remark: '等待测试配件' };
const snapshot = { rmaNo, reasonPath: '保内 / 网点缺件', remark: hold.remark, readBackVerified: true };
async function storeFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fielddesk-hold-reconcile-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new JsonReceiptPreparationStore(path.join(root, 'orders.json'));
  await store.writeAll([{ rmaNo, status: 'ON_HOLD', hold, timeline: [] }]); return store;
}
test('only exact persisted remote hold confirms locally; conflicting or stale data is retained', async t => {
  const store = await storeFixture(t);
  for (const changed of [{ ...snapshot, rmaNo: 'OTHER' }, { ...snapshot, remark: '其他备注' }, { ...snapshot, reasonPath: '保外/网点缺件' }, { ...snapshot, readBackVerified: false }]) {
    await assert.rejects(store.reconcileRecloudHold(rmaNo, hold, changed));
    assert.equal((await store.readAll())[0].hold.status, 'RESULT_UNKNOWN');
  }
  await assert.rejects(store.reconcileRecloudHold(rmaNo, { ...hold, remark: '旧备注' }, snapshot));
  const updated = await store.reconcileRecloudHold(rmaNo, hold, snapshot);
  assert.equal(updated.hold.status, 'CONFIRMED');
  assert.equal(updated.timeline.at(-1).type, 'RECLOUD_HOLD_RECONCILED');
  await assert.rejects(store.reconcileRecloudHold(rmaNo, hold, snapshot));
});
test('readback reloads and never edits; ambiguous order identity refuses confirmation', async () => {
  let reloads = 0;
  let body = rmaNo;
  const field = label => ({ locator: () => ({ first: () => ({ waitFor: async () => {}, inputValue: async () => label.source.includes('滞处理') ? snapshot.reasonPath : snapshot.remark }) }) });
  const page = { reload: async () => { reloads++; }, locator: selector => selector === 'body'
    ? { innerText: async () => body }
    : { filter: ({ hasText }) => ({ filter: () => ({ first: () => field(hasText) }) }) } };
  assert.deepEqual(await readRmaHoldSnapshot(page, rmaNo), snapshot);
  assert.equal(reloads, 1);
  body += ' JXTH-OTHER'; await assert.rejects(readRmaHoldSnapshot(page, rmaNo), { code: 'HOLD_RECONCILIATION_ORDER_MISMATCH' });
});
test('reconciliation API is admin-only, mismatch never marks success or writes to Recloud', async t => {
  const store = await storeFixture(t); let remote = snapshot; let reads = 0;
  const connector = { openRecloud: async () => ({ page: {}, loginRequired: false }), queryRmaByLogisticsNo: async () => ({ rmaNo }),
    readRmaHoldSnapshot: async () => { reads++; return remote; }, submitRmaHold: async () => { assert.fail('must not submit'); } };
  const app = createApp(connector, store, { env: { DRY_RUN: 'true' }, syncService: {},
    getCurrentUser: req => ({ userId: 'LAB', role: req.headers['x-test-role'] || 'ADMIN' }),
    coordinationStore: { assertAvailable: async () => {}, audit: async () => {} }, operationalLogger: { write() {} },
    recloudRecoveryWatchdogEnabled: false, resumePendingRecloudReceipts: false, resumePendingRecloudDetections: false, resumePendingRecloudServiceOrders: false });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const send = role => fetch(`http://127.0.0.1:${server.address().port}/api/repairs/hold/reconcile`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-role': role }, body: JSON.stringify({ rmaNo }) });
  assert.equal((await send('TECHNICIAN')).status, 403); assert.equal(reads, 0);
  remote = { ...snapshot, remark: '不同' }; assert.equal((await send('ADMIN')).status, 409);
  remote = snapshot; assert.equal((await send('ADMIN')).status, 200);
  assert.equal((await store.readAll())[0].hold.status, 'CONFIRMED');
  assert.equal((await send('ADMIN')).status, 409);
});
