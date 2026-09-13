const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { locateLabelSelection } = require('../connectors/recloud-old-part-labels');
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
