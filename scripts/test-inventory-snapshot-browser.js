const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { readInventoryTableSnapshot, parseInventoryRow } = require('../connectors/recloud-parts-inventory');
(async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(`<div class="el-table"><div class="el-table__header-wrapper"><table><tr><th>配件编码</th><th>数量</th></tr></table></div><div class="el-table__body-wrapper"><table><tbody>${Array.from({length:100},(_,i)=>`<tr><td>TEST${i}</td><td>${i}</td></tr>`).join('')}<tr style="display:none"><td>HIDDEN</td><td>999</td></tr></tbody></table></div></div>`);
    const snapshot = await page.locator('.el-table').evaluate(readInventoryTableSnapshot);
    const rows = snapshot.rows.map(cells => parseInventoryRow(snapshot.headers, cells));
    assert.equal(rows.length,100);
    assert.equal(rows[0].quantity,0);
    assert.equal(rows[99].partCode,'TEST99');
    assert.equal(rows[99].quantity,99);
    console.log('PASS: one snapshot reads 100 rows, preserves zero stock and excludes hidden rows');
  } finally { await browser.close(); }
})().catch(error => {console.error(error);process.exitCode=1;});
