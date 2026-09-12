const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server');
const { JsonReceiptPreparationStore } = require('../database/receipt-preparation-store');

for (const mode of ['no-evidence', 'receipt-local-failure', 'attachment-local-failure']) {
  test(`${mode}: uncertain results block repeat submission`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fielddesk-receipt-result-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const store = new JsonReceiptPreparationStore(path.join(root, 'orders.json'));
    const rmaNo = 'JXTH-LAB-RESULT'; let signs = 0; let uploads = 0;
    await store.writeAll([{ rmaNo, sn: 'LAB-SN', logisticsNo: 'LAB-LOGISTICS', operatorId: 'LAB', status: 'RECEIVED_PENDING_INSPECTION',
      updatedAt: new Date().toISOString(), receiptCompletedAt: new Date().toISOString(),
      recloudReceiptSyncStatus: 'FAILED', recloudProjectVerificationConfirmedAt: new Date().toISOString(),
      receiptAttachments: [{ id: 'LAB-PHOTO', name: 'lab.jpg' }], timeline: [] }]);
    if (mode === 'receipt-local-failure') store.markRecloudReceiptConfirmed = async () => { throw Object.assign(Error('synthetic disk failure'), { code: 'EIO' }); };
    if (mode === 'attachment-local-failure') store.markRecloudReceiptAttachmentsConfirmed = async () => { throw Object.assign(Error('synthetic disk failure'), { code: 'EIO' }); };
    const connector = { openRecloud: async () => ({ page: {}, loginRequired: false }),
      queryRmaByLogisticsNo: async () => ({ rmaNo, projectCode: 'LAB', ...(mode === 'no-evidence' ? {} : { pickupStatus: '已取件' }) }),
      hasVisibleReceiptAction: async () => mode !== 'no-evidence',
      confirmSign: async () => { signs++; return { confirmed: true }; },
      uploadRmaAttachments: async () => { uploads++; return { uploaded: ['lab.jpg'] }; } };
    const app = createApp(connector, store, { env: { DRY_RUN: 'true', RECLOUD_RECEIPT_WRITE_ENABLED: 'true', RECLOUD_WRITE_RMA_ALLOWLIST: rmaNo },
      getCurrentUser: () => ({ userId: 'LAB', role: 'ADMIN' }), syncService: {},
      receiptAttachmentStore: { read: async () => Buffer.from('test') },
      recloudRecoveryWatchdogEnabled: false, resumePendingRecloudReceipts: false, resumePendingRecloudDetections: false, resumePendingRecloudServiceOrders: false });
    const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
    t.after(() => new Promise(r => server.close(r)));
    const send = endpoint => fetch(`http://127.0.0.1:${server.address().port}${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rmaNo }) });
    assert.equal((await send('/api/repairs/recloud-receipt/retry')).status, 200);
    const field = mode === 'attachment-local-failure' ? 'recloudReceiptAttachmentSyncStatus' : 'recloudReceiptSyncStatus';
    let saved;
    for (let i = 0; i < 200; i++) { saved = (await store.readAll())[0]; if (saved[field] === 'RESULT_UNKNOWN') break; await new Promise(r => setTimeout(r, 10)); }
    assert.equal(saved[field], 'RESULT_UNKNOWN');
    const before = { signs, uploads };
    await send(mode === 'attachment-local-failure' ? '/api/admin/recloud/receipt-attachments/retry' : '/api/repairs/recloud-receipt/retry');
    await new Promise(r => setTimeout(r, 30));
    assert.deepEqual({ signs, uploads }, before);
    if (mode === 'no-evidence') assert.deepEqual(before, { signs: 0, uploads: 0 });
  });
}
