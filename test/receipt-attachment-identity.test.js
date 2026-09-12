const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { receiptUploadFiles, receiptAttachmentsMatch } = require('../services/receipt-attachment-identity');
const { JsonReceiptPreparationStore } = require('../database/receipt-preparation-store');
const { createApp } = require('../server');
const file = { id: 'LAB-1', name: 'IMG001.JPG', buffer: Buffer.from('synthetic-image') };
test('stable names bind content, order and attachment identity and preserve extension', () => {
  const name = receiptUploadFiles('LAB', [file])[0].name;
  assert.match(name, /^fd-r-[a-f0-9]{64}\.jpg$/);
  assert.equal(receiptUploadFiles('LAB', [file])[0].name, name);
  for (const changed of [{ ...file, id: 'LAB-2' }, { ...file, buffer: Buffer.from('different') }]) assert.notEqual(receiptUploadFiles('LAB', [changed])[0].name, name);
  assert.notEqual(receiptUploadFiles('OTHER', [file])[0].name, name);
  assert.throws(() => receiptUploadFiles('LAB', [file, file]));
});
test('readback refuses ordinary filenames, duplicate markers, missing files and wrong order', () => {
  const files = receiptUploadFiles('LAB', [file]);
  const snapshot = { rmaNo: 'LAB', readBackVerified: true, attachments: files };
  assert.equal(receiptAttachmentsMatch('LAB', files, snapshot), true);
  for (const change of [{ attachments: [file] }, { attachments: [...files, ...files] }, { attachments: [] }, { rmaNo: 'OTHER' }, { readBackVerified: false }]) {
    assert.equal(receiptAttachmentsMatch('LAB', files, { ...snapshot, ...change }), false);
  }
});
test('reconciliation changes local state only with matching evidence and unchanged order', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fd-attachment-reconcile-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new JsonReceiptPreparationStore(path.join(root, 'orders.json'));
  const order = { rmaNo: 'LAB', updatedAt: 'v1', receiptAttachments: [{ id: file.id, name: file.name }], recloudReceiptConfirmedAt: 'yes', recloudReceiptAttachmentSyncStatus: 'RESULT_UNKNOWN' };
  await store.writeAll([order]);
  const files = receiptUploadFiles('LAB', [file]);
  const snapshot = { rmaNo: 'LAB', readBackVerified: true, attachments: files };
  await assert.rejects(store.reconcileReceiptAttachments({ ...order, updatedAt: 'old' }, files, snapshot));
  await assert.rejects(store.reconcileReceiptAttachments(order, files, { ...snapshot, attachments: [file] }));
  assert.equal((await store.readAll())[0].recloudReceiptAttachmentSyncStatus, 'RESULT_UNKNOWN');
  const updated = await store.reconcileReceiptAttachments(order, files, snapshot);
  assert.equal(updated.recloudReceiptAttachmentSyncStatus, 'CONFIRMED');
  assert.equal(updated.timeline.at(-1).type, 'RECLOUD_RECEIPT_ATTACHMENTS_RECONCILED');
  await assert.rejects(store.reconcileReceiptAttachments(order, files, snapshot));
});
test('management API reads only; mismatch, missing evidence and repeated reconciliation stay safe', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fd-attachment-api-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new JsonReceiptPreparationStore(path.join(root, 'orders.json'));
  const rmaNo = 'LAB';
  await store.writeAll([{ rmaNo, updatedAt: 'v1', receiptAttachments: [{ id: file.id, name: file.name }], recloudReceiptConfirmedAt: 'yes', recloudReceiptAttachmentSyncStatus: 'RESULT_UNKNOWN' }]);
  let remoteRma = rmaNo; let reads = 0;
  let snapshot = { rmaNo, readBackVerified: true, attachments: [file] };
  const connector = { openRecloud: async () => ({ page: {}, loginRequired: false }),
    queryRmaByLogisticsNo: async () => ({ rmaNo: remoteRma }),
    readRmaReceiptAttachmentSnapshot: async () => { reads++; return snapshot; },
    uploadRmaAttachments: async () => assert.fail('read-only must not upload') };
  const app = createApp(connector, store, { env: { DRY_RUN: 'true' }, syncService: {},
    getCurrentUser: req => ({ userId: 'LAB', role: req.headers['x-test-role'] || 'ADMIN' }),
    receiptAttachmentStore: { read: async () => file.buffer },
    coordinationStore: { assertAvailable: async () => {}, audit: async () => {} }, operationalLogger: { write() {} },
    recloudRecoveryWatchdogEnabled: false, resumePendingRecloudReceipts: false, resumePendingRecloudDetections: false, resumePendingRecloudServiceOrders: false });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const send = role => fetch(`http://127.0.0.1:${server.address().port}/api/repairs/admin/reconcile-receipt-attachments`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-role': role }, body: JSON.stringify({ rmaNo }) });
  assert.equal((await send('TECHNICIAN')).status, 403); assert.equal(reads, 0);
  remoteRma = 'OTHER'; assert.equal((await send('ADMIN')).status, 409); assert.equal(reads, 0);
  remoteRma = rmaNo; assert.equal((await send('ADMIN')).status, 409);
  assert.equal((await store.readAll())[0].recloudReceiptAttachmentSyncStatus, 'RESULT_UNKNOWN');
  snapshot.attachments = receiptUploadFiles(rmaNo, [file]);
  assert.equal((await send('ADMIN')).status, 200);
  assert.equal((await send('ADMIN')).status, 409);
});
