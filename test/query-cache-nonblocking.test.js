const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server');

test('known incomplete order returns before unavailable Recloud detail enrichment', async t => {
  const connector = { async openRecloud() { throw Object.assign(new Error('offline'), { code: 'TEST_OFFLINE' }); } };
  const receiptStore = { readAll: async () => [], listOrdersForUser: async () => [] };
  const pendingReceiptStore = { readAll: async () => [{ rmaNo: 'JXTH-TEST-CACHE', logisticsNo: 'SF1234567890000', productLine: '扫地机', reportedFault: '' }] };
  const server = createApp(connector, receiptStore, { pendingReceiptStore }).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(() => server.close());
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/crm/repairs/query`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ queryValue: 'SF1234567890000' }),
  });
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.data.rmaNo, 'JXTH-TEST-CACHE');
  assert.equal(result.data.cached, true);
  assert.equal(result.data.detailRefreshPending, true);
});
