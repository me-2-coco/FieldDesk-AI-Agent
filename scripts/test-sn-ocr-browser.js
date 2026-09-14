// Run with the frontend dev server on port 5178. Synthetic data only.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto('http://127.0.0.1:5178');
    const png = await page.evaluate(async () => {
      const { default: React } = await import('/node_modules/.vite/deps/react.js');
      const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
      const { default: Photo } = await import('/src/components/SnPhotoOcr.jsx');
      const { snTextCandidates } = await import('/src/shared/snOcr.js');
      if (snTextCandidates('S/N: W1234567LAB7654321 W1234567LAB7654321').length !== 1) throw Error('dedupe');
      if (snTextCandidates('202609141745 1234567890123').length) throw Error('numeric false positive');
      window.confirmed = '';
      ReactDOM.createRoot(document.body.appendChild(document.createElement('div'))).render(React.createElement(Photo, { onBack() {}, onConfirm(value) { window.confirmed = value; } }));
      const canvas = document.createElement('canvas'); canvas.width = 1200; canvas.height = 300;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 1200, 300);
      ctx.fillStyle = 'black'; ctx.font = '48px monospace'; ctx.fillText('S/N: W1234567LAB7654321', 40, 160);
      return canvas.toDataURL().split(',')[1];
    });
    await page.getByLabel('拍照或选择 SN 照片').setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
    await page.getByRole('button', { name: '识别文字', exact: true }).click();
    await page.getByText('请对照照片逐位核对', { exact: false }).waitFor({ timeout: 90000 });
    assert.equal(await page.getByLabel('SN（请核对，可修改）').inputValue(), 'W1234567LAB7654321');
    assert.equal(await page.evaluate(() => window.confirmed), '');
    await page.getByLabel('SN（请核对，可修改）').fill('W1234567LAB7654322');
    await page.getByRole('button', { name: '确认并填入 SN' }).click();
    assert.equal(await page.evaluate(() => window.confirmed), 'W1234567LAB7654322');
    console.log('PASS: local OCR, editable SN and explicit confirmation');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
