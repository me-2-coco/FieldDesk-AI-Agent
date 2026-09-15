const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveLatestServiceOrderNo } = require('../services/recloud-repair-navigation');
const { startRepair } = require('../connectors/recloud');
test('stale repair entry stops after the short probe without a write', async t => {
  let now = 0;
  let writes = 0;
  t.mock.method(Date, 'now', () => now);
  const empty = { filter() { return this; }, count: async () => 0 };
  const page = { url: () => 'https://example.test/app', locator: () => empty, waitForTimeout: async ms => { now += ms; } };
  await assert.rejects(startRepair(page, { writeEnabled: true, entryTimeoutMs: 1200, onBeforeCreate: () => writes++ }), { code: 'RECLOUD_ACTION_NOT_FOUND' });
  assert.equal(now, 1200);
  assert.equal(writes, 0);
});
test('short entry probe preserves the longer post-click confirmation window', async t => {
  let now = 0;
  let writes = 0;
  t.mock.method(Date, 'now', () => now);
  const entry = { isVisible: async () => true, boundingBox: async () => ({ x: 0, y: 0, width: 1, height: 1 }), click: async () => { writes++; } };
  const entries = { filter() { return this; }, count: async () => 1, nth: () => entry };
  const ready = { filter() { return this; }, count: async () => now >= 3000 ? 1 : 0 };
  const page = { url: () => 'https://example.test/app', locator: selector => selector === 'body' ? { innerText: async () => 'FWD202601010001' } : entries, getByRole: () => ready, getByText: () => ready, waitForTimeout: async ms => { now += ms; } };
  const result = await startRepair(page, { writeEnabled: true, entryTimeoutMs: 1200 });
  assert.equal(result.serviceOrderCreated, true);
  assert.equal(now, 3000);
  assert.equal(writes, 1);
});
test('queued completion resolves service number created after enqueue', async () => {
  const task = { rmaNo: 'RMA-A', payload: {} };
  const orders = [];
  const store = { readAll: async () => orders };
  assert.equal(await resolveLatestServiceOrderNo(task, store), '');
  orders.push({ rmaNo: 'RMA-A', recloudServiceOrderNo: 'FWD-A' });
  assert.equal(await resolveLatestServiceOrderNo(task, store), 'FWD-A');
});
test('does not borrow another order number and preserves matching snapshot', async () => {
  const store = { readAll: async () => [{ rmaNo: 'RMA-B', recloudServiceOrderNo: 'FWD-B' }] };
  assert.equal(await resolveLatestServiceOrderNo({ rmaNo: 'RMA-A' }, store), '');
  assert.equal(await resolveLatestServiceOrderNo({ rmaNo: 'RMA-A', payload: { serviceOrderNo: 'FWD-A' } }, store), 'FWD-A');
});
test('conflicting or ambiguous service order records fail closed', async () => {
  const record = { rmaNo: 'RMA-A', recloudServiceOrderNo: 'FWD-A' };
  for (const [records, payload] of [[[record], { serviceOrderNo: 'FWD-OTHER' }], [[record, record], {}]]) {
    await assert.rejects(resolveLatestServiceOrderNo({ rmaNo: 'RMA-A', payload }, { readAll: async () => records }), { code: 'RECLOUD_REPAIR_ORDER_MISMATCH' });
  }
});
