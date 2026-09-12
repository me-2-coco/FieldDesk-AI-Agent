const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { receiptEvidenceMatches } = require('../services/receipt-reconciliation-evidence');
const { JsonReceiptPreparationStore } = require('../database/receipt-preparation-store');
const { createApp } = require('../server');
const { readRmaReceiptSnapshot } = require('../connectors/recloud');
const order = { rmaNo: 'JXTH-LAB-RECEIPT', sn: 'LABSN001', status: 'RECEIPT_PREPARED', recloudReceiptSyncStatus: 'RESULT_UNKNOWN', updatedAt: 'v1', timeline: [] };
const row = { sn: order.sn, systemReceiptStatus: '已签收' };
const snapshot = { rmaNo: order.rmaNo, rows: [row], readBackVerified: true };
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fielddesk-receipt-snapshot-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new JsonReceiptPreparationStore(path.join(root, 'orders.json'));
  await store.writeAll([order]); return store;
}
test('connector reloads for fresh evidence and rejects ambiguous RMA before reading rows', async () => {
  let reloads = 0; let reads = 0; let body = 'RMA JXTH202609120001';
  const page = { reload: async () => { reloads++; }, locator: () => ({ innerText: async () => body }),
    evaluate: async () => { reads++; return [row]; } };
  const result = await readRmaReceiptSnapshot(page, 'JXTH202609120001');
  assert.equal(result.readBackVerified, true); assert.equal(reloads, 1); assert.equal(reads, 1);
  body += ' JXTH202609120002';
  await assert.rejects(readRmaReceiptSnapshot(page, 'JXTH202609120001'), { code: 'RECEIPT_RECONCILIATION_ORDER_MISMATCH' });
  assert.equal(reads, 1);
});
test('receipt evidence rejects logistics dates, wrong SN, ambiguous rows and negative status', () => {
  assert.equal(receiptEvidenceMatches(order, snapshot), true);
  assert.equal(receiptEvidenceMatches(order, { ...snapshot, rows: [{ sn: order.sn, systemSignedAt: '2026-09-12 10:00:00' }] }), true);
  for (const bad of [
    { ...snapshot, readBackVerified: false }, { ...snapshot, rmaNo: 'OTHER' },
    { ...snapshot, rows: [] }, { ...snapshot, rows: [row, row] },
    ...[{ sn: 'OTHER', systemReceiptStatus: '已签收' }, { sn: order.sn, receiptSignedAt: '2026-09-12 10:00:00' },
      { sn: order.sn, systemReceiptStatus: '未签收', systemSignedAt: '2026-09-12 10:00:00' },
      { sn: order.sn, systemSignedAt: 'not-a-date' }].map(item => ({ ...snapshot, rows: [item] }))
  ]) assert.equal(receiptEvidenceMatches(order, bad), false);
});
test('store checks stale state and preserves uncertainty until exact evidence', async t => {
  const store = await fixture(t);
  await assert.rejects(store.reconcileReceiptFromSnapshot({ ...order, updatedAt: 'old' }, snapshot));
  await assert.rejects(store.reconcileReceiptFromSnapshot(order, { ...snapshot, rows: [] }));
  assert.equal((await store.readAll())[0].recloudReceiptSyncStatus, 'RESULT_UNKNOWN');
  const updated = await store.reconcileReceiptFromSnapshot(order, snapshot);
  assert.equal(updated.recloudReceiptSyncStatus, 'CONFIRMED');
  assert.equal(updated.timeline.at(-1).type, 'RECLOUD_RECEIPT_RECONCILED');
  await assert.rejects(store.reconcileReceiptFromSnapshot(order, snapshot));
});
test('API permits only management and performs readback without receipt submission', async t => {
  const store = await fixture(t); let remote = snapshot; let reads = 0; let detailRma = order.rmaNo;
  const connector = { openRecloud: async () => ({ page: {}, loginRequired: false }),
    queryRmaByLogisticsNo: async () => ({ rmaNo: detailRma }),
    readRmaReceiptSnapshot: async () => { reads++; return remote; },
    confirmSign: async () => assert.fail('must not sign'), uploadRmaAttachments: async () => assert.fail('must not upload') };
  const app = createApp(connector, store, { env: { DRY_RUN: 'true' }, syncService: {},
    getCurrentUser: req => ({ userId: 'LAB', role: req.headers['x-test-role'] || 'ADMIN' }),
    coordinationStore: { assertAvailable: async () => {}, audit: async () => {} }, operationalLogger: { write() {} },
    recloudRecoveryWatchdogEnabled: false, resumePendingRecloudReceipts: false, resumePendingRecloudDetections: false, resumePendingRecloudServiceOrders: false });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const send = role => fetch(`http://127.0.0.1:${server.address().port}/api/repairs/admin/reconcile-receipt`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-role': role }, body: JSON.stringify({ rmaNo: order.rmaNo }) });
  assert.equal((await send('TECHNICIAN')).status, 403); assert.equal(reads, 0);
  detailRma = 'OTHER'; assert.equal((await send('ADMIN')).status, 409); assert.equal(reads, 0);
  detailRma = order.rmaNo; remote = { ...snapshot, rows: [] }; assert.equal((await send('ADMIN')).status, 409);
  remote = snapshot; assert.equal((await send('ADMIN')).status, 200);
  assert.equal((await store.readAll())[0].recloudReceiptSyncStatus, 'CONFIRMED');
  assert.equal((await send('ADMIN')).status, 409);
});
