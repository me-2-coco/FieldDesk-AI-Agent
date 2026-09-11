const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createApp } = require('../server');

test('reconciliation requires owner, exact SN and explicit signed confirmation', async t => {
  let marks = 0;
  const order = { rmaNo: 'TEST-RMA', sn: 'TEST-SN', operatorId: 'owner', recloudReceiptSyncStatus: 'RESULT_UNKNOWN' };
  const app = createApp({}, {
    readAll: async () => [order],
    markRecloudReceiptConfirmed: async () => { marks++; return { ...order, recloudReceiptConfirmedAt: 'confirmed', recloudProjectVerificationStatus: 'CONFIRMED', recloudReceiptAttachmentSyncStatus: 'CONFIRMED' }; },
  }, {
    env: { DRY_RUN: 'true' }, syncService: {},
    getCurrentUser: req => ({ userId: req.headers['x-test-user'] || 'owner', role: 'TECHNICIAN' }),
    coordinationStore: { assertAvailable: async () => {}, audit: async () => {} },
    operationalLogger: { write() {} },
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const send = (body, user = 'owner') => fetch(`http://127.0.0.1:${server.address().port}/api/repairs/recloud-receipt/reconcile-confirmed`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-user': user }, body: JSON.stringify({ rmaNo: 'TEST-RMA', ...body }),
  });
  assert.equal((await send({ sn: 'TEST-SN', confirmedSigned: true }, 'other')).status, 403);
  assert.equal((await send({ sn: 'WRONG', confirmedSigned: true })).status, 409);
  assert.equal((await send({ sn: 'TEST-SN' })).status, 409);
  assert.equal(marks, 0);
  assert.equal((await send({ sn: 'TEST-SN', confirmedSigned: true })).status, 200);
  assert.equal(marks, 1);
});

test('sales sample confirmation is exact-scoped and followed by receipt verification', () => {
  const source = fs.readFileSync(require.resolve('../connectors/recloud'), 'utf8');
  const block = source.slice(source.indexOf('const sampleConfirmation ='), source.indexOf('const sampleConfirmation =') + 1300);
  assert.match(block, /hasText: \/该SN码对应大货销售样机\//);
  assert.match(block, /name: "确认签收", exact: true/);
  assert.match(block, /if \(await sampleConfirmation.isVisible\(\)\)/);
  assert.match(block, /hasVisibleReceiptAction/);
});
