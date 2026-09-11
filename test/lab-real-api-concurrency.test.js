const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { AccountStore } = require('../database/account-store');
const { JsonReceiptPreparationStore, createReceiptPreparation } = require('../database/receipt-preparation-store');
const { createApp } = require('../server');
const { LocalRepairAttachmentStore } = require('../database/repair-attachment-store');

test('60 real account sessions concurrently persist workflow positions without cross-order access', { timeout: 30000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fielddesk-real-api-load-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const password = crypto.randomBytes(12).toString('hex');
  const passwordHash = crypto.createHash('sha256').update(password).digest('hex');
  const accounts = new AccountStore({ filePath: path.join(dir, 'accounts.json') });
  await accounts.backend.update(data => { data.users = Array.from({ length: 60 }, (_, i) => ({
    userId: `LAB-TECH-${i}`, displayName: `模拟师傅${i}`, role: 'TECHNICIAN',
    repairSpecialties: ['扫地机'], active: true, passwordHash, allowBearer: false,
  })); });
  const store = new JsonReceiptPreparationStore(path.join(dir, 'orders.json'));
  await store.writeAll(Array.from({ length: 60 }, (_, i) => ({ ...createReceiptPreparation({
    rmaNo: `LAB-ORDER-${i}`, operatorId: `LAB-TECH-${i}`, productLine: '扫地机',
  }), status: 'INSPECTION_COMPLETED_PENDING_REPAIR', treatmentMode: 'DEBUGGING', technicianWarranty: '保内',
    inspectionUpdatedAt: new Date().toISOString(), modelAuthorization: { repairFees: { small: 1 } },
  })));
  const attachments = new LocalRepairAttachmentStore(path.join(dir, 'uploads'));
  let externalCalls = 0;
  const connector = new Proxy({}, { get: () => () => { externalCalls++; throw new Error('external access forbidden'); } });
  const app = createApp(connector, store, {
    env: { FIELDDESK_AUTH_MODE: 'accounts', DRY_RUN: 'true' }, accountStore: accounts,
    recloudRecoveryWatchdogEnabled: false, resumePendingRecloudReceipts: false,
    resumePendingRecloudDetections: false, resumePendingRecloudServiceOrders: false,
    operationalLogger: { write: () => {} }, syncService: {},
    attachmentStore: attachments, inventoryStore: { usedPartsForOrder: async () => [] },
    feishuModelCatalog: connector, feishuPartsCatalog: connector,
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const times = [];
  const begin = performance.now();
  let uploadedCount = 0, draftCount = 0, downloadedCount = 0;
  await Promise.all(Array.from({ length: 60 }, async (_, i) => {
    const login = await fetch(`${origin}/api/auth/login`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: `LAB-TECH-${i}`, password }),
    });
    assert.equal(login.status, 200);
    await login.json();
    const cookie = login.headers.get('set-cookie').split(';')[0];
    // Mix actual attachment storage and draft writes with workflow reads/writes.
    if (i % 3 !== 2) {
      let attached = [];
      if (i % 3 === 0) {
        const bytes = Buffer.alloc(1024 * 1024, i);
        const upload = await fetch(`${origin}/api/repairs/completion/attachments`, { method: 'POST',
          headers: { Cookie: cookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ rmaNo: `LAB-ORDER-${i}`, name: 'synthetic.png', mimeType: 'image/png', data: bytes.toString('base64') }),
        });
        assert.equal(upload.status, 200);
        attached = [(await upload.json()).data]; uploadedCount++;
      }
      const draft = await fetch(`${origin}/api/repairs/completion/draft`, { method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ rmaNo: `LAB-ORDER-${i}`, detectionResult: '维修', repairMeasure: `模拟处理-${i}`, attachments: attached }),
      });
      assert.equal(draft.status, 200); await draft.json(); draftCount++;
      if (attached.length) {
        const download = await fetch(`${origin}/api/repairs/LAB-ORDER-${i}/attachments/repair/${attached[0].id}`, { headers: { Cookie: cookie } });
        assert.equal(download.status, 200);
        assert.deepEqual(Buffer.from(await download.arrayBuffer()), Buffer.alloc(1024 * 1024, i)); downloadedCount++;
      }
    }
    for (let round = 0; round < 10; round++) {
      const start = performance.now();
      const saved = await fetch(`${origin}/api/repairs/resume-step`, { method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ rmaNo: `LAB-ORDER-${i}`, resumeStep: round % 2 ? 'repairDecision' : 'repairWarranty' }),
      });
      assert.equal(saved.status, 200);
      assert.equal((await saved.json()).success, true);
      const read = await fetch(`${origin}/api/repairs/LAB-ORDER-${i}/local-state`, { headers: { Cookie: cookie } });
      assert.equal(read.status, 200);
      assert.equal((await read.json()).data.exists, true);
      times.push(performance.now() - start);
    }
    const denied = await fetch(`${origin}/api/repairs/resume-step`, { method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ rmaNo: `LAB-ORDER-${(i + 1) % 60}`, resumeStep: 'partsApplication' }),
    });
    assert.equal(denied.status, 403);
    await denied.json();
  }));
  const reopened = new JsonReceiptPreparationStore(store.filePath);
  const orders = await reopened.readAll();
  assert.equal(orders.length, 60);
  assert.ok(orders.every(order => order.resumeStep === 'repairDecision'));
  for (let i = 0; i < 60; i++) {
    const order = orders.find(row => row.rmaNo === `LAB-ORDER-${i}`);
    if (i % 3 !== 2) {
      assert.equal(order.repairCompletion.repairMeasure, `模拟处理-${i}`);
      assert.equal(order.repairCompletion.attachments.length, i % 3 === 0 ? 1 : 0);
    }
  }
  assert.equal(uploadedCount, 20); assert.equal(downloadedCount, 20); assert.equal(draftCount, 40);
  assert.equal(externalCalls, 0);
  times.sort((a, b) => a - b);
  t.diagnostic(JSON.stringify({ accounts: 60, writes: 600, reads: 600, forbiddenWrites: 60,
    elapsedMs: Math.round(performance.now() - begin), pairP95Ms: Math.round(times[Math.floor(times.length * .95)]),
    uploads: uploadedCount, byteVerifiedDownloads: downloadedCount, drafts: draftCount,
    heapUsedMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024), externalCalls }));
});
