const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { readRmaReceiptSnapshot } = require('../connectors/recloud');
const { receiptEvidenceMatches } = require('../services/receipt-reconciliation-evidence');

test('receipt snapshot binds split tables and does not confirm a pending row', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<h1>RMA JXTH123</h1><div class="grid">
      <div><table><tr><th>产品序列号</th><th>签收数量</th><th>操作</th></tr></table></div>
      <div><table><tr><td>TEST-SN</td><td>--</td><td>签收</td></tr></table></div>
      </div><table><tr><td>UNRELATED-SN</td><td>1</td><td>维修</td></tr></table>`);
    const adapter = { reload: async () => {}, locator: (...args) => page.locator(...args), evaluate: (...args) => page.evaluate(...args), waitForTimeout: (...args) => page.waitForTimeout(...args) };
    const result = await readRmaReceiptSnapshot(adapter, 'JXTH123');
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].sn, 'TEST-SN');
    assert.equal(result.rows[0].systemReceiptStatus, '待签收');
    assert.equal(receiptEvidenceMatches({ rmaNo:'JXTH123',sn:'TEST-SN' },result), false);
    await page.locator('.grid td').nth(1).evaluate(e => e.textContent='1');
    await page.locator('.grid td').nth(2).evaluate(e => e.textContent='');
    const signed = await readRmaReceiptSnapshot(adapter,'JXTH123');
    assert.equal(receiptEvidenceMatches({rmaNo:'JXTH123',sn:'TEST-SN'},signed),true);
    for(const changed of [{receiptQuantity:'--'},{receiptQuantity:'2'},{receiptActionKnown:false},{receiptActionVisible:true},{sn:'OTHER'},{systemReceiptStatus:'待签收'}]) {
      assert.equal(receiptEvidenceMatches({rmaNo:'JXTH123',sn:'TEST-SN'},{...signed,rows:[{...signed.rows[0],...changed}]}),false);
    }
  } finally { await browser.close(); }
});
