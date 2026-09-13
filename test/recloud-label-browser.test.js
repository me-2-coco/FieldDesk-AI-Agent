const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { locateLabelSelection } = require('../connectors/recloud-old-part-labels');
const { readExistingRepairParts } = require('../connectors/recloud-repair-parts-reader');
test('parts reader expands five-row pagination before deciding what is missing', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => route.abort());
    const rows = n => Array.from({ length: n }, (_, i) => `<tr><td>P${i}</td><td>1</td></tr>`).join('');
    await page.setContent(`<div>服务单更换件明细</div><div class="rt-table-content"><div class="el-table"><table><thead><tr><th>新件编码</th><th>数量</th></tr></thead><tbody>${rows(5)}</tbody></table></div><div class="el-pagination">共 7 条记录<button onclick="document.querySelector('#choice').hidden=false">5条/页</button></div></div><div id="choice" hidden onclick="document.querySelector('tbody').innerHTML=this.dataset.rows;this.hidden=true" data-rows='${rows(7)}'>50条/页</div>`);
    assert.equal((await readExistingRepairParts(page)).length, 7);
    await page.locator('.el-pagination').evaluate(el => el.firstChild.textContent = '共 8 条记录');
    await assert.rejects(readExistingRepairParts(page), /Timeout|数量|timeout/i);
  } finally { await browser.close(); }
});
test('real browser: hidden input is selected and restored through its visible label', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => route.abort());
    await page.setContent(`<table><tr><td><label role="checkbox" style="display:inline-block;padding:12px;background:#ddd"><span>选择配件</span><input type="checkbox" style="display:none"></label></td></tr></table>`);
    const input = page.locator('input');
    assert.equal(await input.isVisible(), false);
    const selection = await locateLabelSelection(page.locator('td'));
    await selection.setChecked(true);
    assert.equal(await input.isChecked(), true);
    await selection.setChecked(true);
    assert.equal(await input.isChecked(), true);
    await selection.setChecked(false);
    assert.equal(await input.isChecked(), false);
  } finally { await browser.close(); }
});
