const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { createApp } = require('../server');
const { JsonReceiptPreparationStore } = require('../database/receipt-preparation-store');
const { LocalRepairAttachmentStore } = require('../database/repair-attachment-store');
const { JsonRecloudSyncOutbox } = require('../database/recloud-sync-outbox');
const { RecloudSyncService } = require('../services/recloud-sync-service');

test('real draft attachment readback and queue-failure retry keep one completion intent', { timeout: 15000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fielddesk-completion-api-'));
  const servers = [];
  t.after(async () => { for (const server of servers) await new Promise(resolve => server.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); });
  const file = path.join(dir, 'orders.json');
  const store = new JsonReceiptPreparationStore(file);
  await store.writeAll([{ id: 'LAB-COMPLETION', rmaNo: 'LAB-COMPLETION', sn: 'LABSYNTHETIC0001',
    status: 'INSPECTION_COMPLETED_PENDING_REPAIR', treatmentMode: 'DEBUGGING', technicianWarranty: '保内',
    reportedFault: '模拟故障原文',
    operatorId: 'LOCAL-ADMIN', technicianId: 'LOCAL-ADMIN', faultCategory: '模拟 / 模拟 / 模拟',
    inspectionUpdatedAt: new Date().toISOString(), modelAuthorization: { repairFees: { small: 1 } },
  }]);
  const attachments = new LocalRepairAttachmentStore(path.join(dir, 'uploads'));
  const outbox = new JsonRecloudSyncOutbox(path.join(dir, 'outbox.json'));
  const sync = new RecloudSyncService(outbox, {}, { scheduler: () => {} });
  let failQueue = false;
  async function start(receipts) {
    const app = createApp({}, receipts, { env: { DRY_RUN: 'true', FIELDDESK_AUTH_MODE: 'local' },
      getCurrentUser: () => ({ userId: 'LOCAL-ADMIN', role: 'ADMIN', displayName: '模拟管理员' }),
      attachmentStore: attachments, inventoryStore: { usedPartsForOrder: async () => [] },
      feishuModelCatalog: { authorize: async () => assert.fail('external lookup') },
      syncService: { enqueueOrderNode: (...args) => { if (failQueue) throw new Error('synthetic queue disk failure'); return sync.enqueueOrderNode(...args); } },
      recloudRecoveryWatchdogEnabled: false, resumePendingRecloudReceipts: false,
      resumePendingRecloudDetections: false, resumePendingRecloudServiceOrders: false,
      operationalLogger: { write: () => {} },
    });
    const server = app.listen(0, '127.0.0.1'); servers.push(server); await once(server, 'listening');
    return `http://127.0.0.1:${server.address().port}`;
  }
  let origin = await start(store);
  const post = async (suffix, body) => {
    const response = await fetch(`${origin}/api/repairs/completion/${suffix}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const bytes = Buffer.alloc(1024 * 1024, 8);
  const uploaded = await post('attachments', { rmaNo: 'LAB-COMPLETION', name: 'synthetic.png', mimeType: 'image/png', data: bytes.toString('base64') });
  assert.equal(uploaded.status, 200);
  const payload = { rmaNo: 'LAB-COMPLETION', detectionResult: '维修', repairMeasure: '模拟故障原文# 模拟处理', attachments: [uploaded.body.data] };
  const mismatch = await post('submit', { ...payload, repairMeasure: '机器故障# 模拟处理' });
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.body.code, 'REPORTED_FAULT_MISMATCH');
  assert.equal((await outbox.readAll()).length, 0);
  assert.equal((await post('draft', payload)).status, 200);
  origin = await start(new JsonReceiptPreparationStore(file));
  const download = await fetch(`${origin}/api/repairs/LAB-COMPLETION/attachments/repair/${uploaded.body.data.id}`);
  assert.equal(download.status, 200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
  const invalid = await post('submit', { ...payload, attachments: [] });
  assert.equal(invalid.status, 400);
  assert.equal((await store.readAll())[0].status, 'REPAIR_COMPLETION_DRAFT');
  failQueue = true;
  const failed = await post('submit', payload);
  assert.equal(failed.status, 503);
  assert.equal(failed.body.code, 'REPAIR_COMPLETION_QUEUE_FAILED');
  const intent = (await store.readAll())[0].repairCompletion.submittedAt;
  assert.ok(intent);
  assert.equal((await outbox.readAll()).length, 0);
  failQueue = false;
  assert.equal((await post('submit', payload)).status, 200);
  assert.equal((await post('submit', payload)).status, 200);
  assert.equal((await store.readAll())[0].repairCompletion.submittedAt, intent);
  assert.equal((await outbox.readAll()).length, 1);
  assert.equal((await post('draft', payload)).status, 409);
});
