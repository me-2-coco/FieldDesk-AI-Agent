const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { readRmaAttachmentItems } = require('../connectors/recloud-rma-attachment-snapshot');
const { receiptAttachmentsMatch } = require('../services/receipt-attachment-identity');
(async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<section id="attachments"><div class="file-detail"><div class="item-name">fd-r-test.jpg</div></div><div class="rtxpc-file-detail"><div class="item-name">fd-r-second.jpg</div><div class="uploadTime-and-operation"><span>12KB</span></div></div><div class="file-detail" style="display:none"><div class="item-name">hidden.jpg</div></div><div class="file-detail"><span>incomplete row</span></div></section>');
    const start = Date.now();
    const rows = await page.locator('#attachments').evaluate(readRmaAttachmentItems);
    assert.ok(Date.now() - start < 2000, 'missing metadata must not wait for locator timeout');
    assert.deepEqual(rows, [{ name: 'fd-r-test.jpg', sizeText: '' }, { name: 'fd-r-second.jpg', sizeText: '12KB' }, { name: '', sizeText: '' }]);
    const files = [{ name: 'fd-r-test.jpg' }];
    const snapshot = { rmaNo: 'LAB-ONLY', readBackVerified: true, attachments: rows };
    assert.equal(receiptAttachmentsMatch('LAB-ONLY', files, snapshot), true);
    assert.equal(receiptAttachmentsMatch('OTHER', files, snapshot), false);
    assert.equal(receiptAttachmentsMatch('LAB-ONLY', files, { ...snapshot, attachments: [...rows, rows[0]] }), false);
    assert.equal(receiptAttachmentsMatch('LAB-ONLY', files, { ...snapshot, attachments: [] }), false);
    console.log('PASS: single attachment snapshot, missing metadata, hidden rows, identity and duplicate checks');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
