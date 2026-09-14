const test = require('node:test');
const assert = require('node:assert/strict');
const { readRmaReceiptSnapshot } = require('../connectors/recloud');
function mockPage(texts) {
  let index = 0, reads = 0;
  return {
    reload: async () => {},
    locator: selector => selector === 'body' ? { innerText: async () => texts[Math.min(index++, texts.length - 1)] } : { count: async () => 0 },
    waitForTimeout: async () => new Promise(resolve => setTimeout(resolve, 1)),
    evaluate: async () => { reads++; return [{ sn: 'TEST-SN', systemReceiptStatus: '已签收' }]; },
    get reads() { return reads; }
  };
}
test('receipt read-back waits for SPA order loading', async () => {
  const page = mockPage(['加载中', 'RMA JXTH123 产品序列号']);
  const result = await readRmaReceiptSnapshot(page, 'JXTH123', { timeoutMs: 50, pollIntervalMs: 1 });
  assert.equal(result.readBackVerified, true);
  assert.equal(result.rmaNo, 'JXTH123');
  assert.equal(page.reads, 1);
});
test('wrong or ambiguous order never produces receipt evidence', async () => {
  for (const body of ['RMA JXTH999 产品序列号', 'RMA JXTH123 产品序列号 JXTH999']) {
    const page = mockPage([body]);
    await assert.rejects(() => readRmaReceiptSnapshot(page, 'JXTH123', { timeoutMs: 3, pollIntervalMs: 1 }), { code: 'RECEIPT_RECONCILIATION_ORDER_MISMATCH' });
    assert.equal(page.reads, 0);
  }
});
