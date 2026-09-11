const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const express = require('express');
const { chromium } = require('playwright');
const { once } = require('node:events');

(async () => {
  const source = path.resolve(__dirname, '..');
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'fielddesk-upload-ui-')));
  await fs.cp(path.join(source, 'frontend/src'), path.join(root, 'src'), { recursive: true });
  await fs.symlink(path.join(source, 'frontend/node_modules'), path.join(root, 'node_modules'));
  await fs.copyFile(path.join(source, 'test/fixtures/upload-page-main.jsx'), path.join(root, 'main.jsx'));
  await fs.writeFile(path.join(root, 'index.html'), '<html><body><div id="root"></div><script type="module" src="/main.jsx"></script></body></html>');
  const { build } = await import(pathToFileURL(path.join(source, 'frontend/node_modules/vite/dist/node/index.js')));
  const { default: react } = await import(pathToFileURL(path.join(source, 'frontend/node_modules/@vitejs/plugin-react/dist/index.js')));
  await build({ root, configFile: false, plugins: [react()], logLevel: 'error', define: { 'import.meta.env.VITE_API_BASE_URL': '""' } });
  const app = express();
  app.use(express.json());
  let failSecond = true, draft = null, submits = 0;
  const uploads = [];
  const order = { rmaNo: 'LAB-UI-ONLY', technicianWarranty: '保内', faultCategory: '产品质量 / 模拟故障 / 模拟部件', reportedFault: '模拟故障' };
  app.use('/api', (req, res) => {
    const ok = data => res.json({ success: true, data });
    if (req.path === '/repairs/completion/context') return ok({ order: { ...order, repairCompletion: draft }, usedParts: [], pricing: { partsFee: 0, fee: 0, subtotal: 0 } });
    if (req.path === '/repairs/completion/attachments') {
      uploads.push(req.body.name);
      if (req.body.name === 'second.png' && failSecond) return res.status(500).json({ success: false, message: '模拟第二张上传失败' });
      return ok({ id: req.body.name, fileName: req.body.name, name: req.body.name, mimeType: 'image/png', size: 68 });
    }
    if (req.path === '/repairs/completion/draft') { draft = req.body; return ok({ repairCompletion: draft, message: '草稿保存成功' }); }
    if (req.path === '/repairs/completion/submit') {
      submits++;
      if (submits === 1) return res.status(409).json({ success: false, message: '模拟提交校验失败' });
      return ok({ repairCompletion: req.body, message: '模拟提交成功' });
    }
    if (req.method === 'GET' && req.path.includes('/attachments/')) return res.type('png').send(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=', 'base64'));
    if (req.path.includes('supervision')) return ok([]);
    return ok({});
  });
  app.use(express.static(path.join(root, 'dist')));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
    await page.goto(origin);
    const buffer = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=', 'base64');
    const files = ['first.png', 'second.png'].map(name => ({ name, mimeType: 'image/png', buffer }));
    await page.locator('#repair-attachments').setInputFiles(files);
    await page.getByText(/模拟第二张上传失败/).waitFor();
    assert.equal(await page.locator('.attachment-preview-item').count(), 1);
    await page.getByRole('button', { name: '保存草稿', exact: true }).click();
    await page.getByText('草稿保存成功', { exact: true }).waitFor();
    assert.deepEqual(draft.attachments.map(item => item.name), ['first.png']);
    assert.ok(!('localPreviewFile' in draft.attachments[0]));
    await page.reload();
    await page.getByRole('button', { name: '移除first.png', exact: true }).waitFor();
    failSecond = false;
    await page.locator('#repair-attachments').setInputFiles(files);
    await page.getByText('附件上传完成', { exact: true }).waitFor();
    assert.equal(await page.locator('.attachment-preview-item').count(), 2);
    await page.getByRole('button', { name: '提交完工', exact: true }).click();
    await page.getByRole('button', { name: '确认完工', exact: true }).click();
    await page.getByText(/完工未提交成功：.*模拟提交校验失败/).waitFor();
    assert.equal(await page.locator('.attachment-preview-item').count(), 2);
    assert.equal(await page.locator('body').getAttribute('data-destination'), null);
    await page.getByRole('button', { name: '提交完工', exact: true }).click();
    await page.getByRole('button', { name: '确认完工', exact: true }).click();
    await page.waitForFunction(() => document.body.dataset.destination === 'repair');
    assert.equal(submits, 2);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(root, 'upload-recovered.png'), fullPage: true });
    console.log(JSON.stringify({ success: true, assertions: ['partial batch retained', 'draft excludes File objects', 'reload restores saved attachment', 'retry deduplicates', 'failed submit preserves page', 'confirmed success navigates back'], uploads, submits, root }));
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
