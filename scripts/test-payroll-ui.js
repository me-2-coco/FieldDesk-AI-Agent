// Run after npm run build --prefix frontend. Uses synthetic data and an isolated HTTP server.
const path = require('node:path');
const fs = require('node:fs');
const root = path.resolve(__dirname, '..');
const output = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'fielddesk-payroll-ui-'));
const { chromium } = require(root + '/node_modules/playwright');
const express = require(root + '/node_modules/express');
const { buildPayroll, exportPayroll } = require(root + '/shared/payroll');
const assert = require('node:assert/strict');
const accounts = [{ userId: 'FieldDesk0005', displayName: '合成师傅甲', role: 'TECHNICIAN' }, { userId: 'FieldDesk0006', displayName: '合成师傅乙', role: 'TECHNICIAN' }];
const orders = [0, 1, 2, 3].map((n) => ({ rmaNo: 'SYNTHETIC-' + n, technicianId: n < 2 ? 'FieldDesk0005' : 'FieldDesk0006', productLine: n < 2 ? '洗地机' : '扫地机', sn: '00000000' + n, treatmentMode: n % 2 ? 'ABANDONED' : 'REPAIR', repairCompletion: { submittedAt: '2026-09-05T00:00:00Z' } }));
orders.push({ ...orders[0] });
orders.push({ ...orders[1], rmaNo: 'UNKNOWN', productLine: '未分类' });
(async () => {
 const app = express(); let exportMonth;
 app.get(/^\/api\//, async (req, res) => {
   if (req.path.startsWith('/api/finance/payroll')) {
     const data = buildPayroll(orders, accounts, { month: req.query.month, includeTest: req.query.includeTest === 'true' });
     if (req.path.endsWith('/export')) { exportMonth = req.query.month; res.set('Content-Disposition', 'attachment; filename="test-payroll.xlsx"'); return res.send(Buffer.from(await exportPayroll(data))); }
     return res.json({ success: true, data });
   }
   if (req.path === '/api/home/todos') return res.json({ success: true, data: { groups: [], items: [] } });
   res.json({ success: true, data: [] });
 });
 app.use(express.static(root + '/frontend/dist'));
 const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
 const browser = await chromium.launch({ headless: true });
 try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1080 }, acceptDownloads: true });
  await context.addInitScript(() => { localStorage.setItem('isLoggedIn', 'true'); localStorage.setItem('fieldDeskAuthenticatedUser', JSON.stringify({ id: 'FieldDesk0001', name: '合成负责人', role: 'admin' })); });
  const page = await context.newPage(); const errors = [];
  page.on('pageerror', error => { errors.push(error.message); console.log('UI_ERROR', error.message); });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole('button', { name: '我的', exact: true }).click();
  await page.getByRole('button', { name: '工资核算', exact: true }).click();
  await page.getByLabel('核算月份').fill('2026-09');
  await page.getByRole('heading', { name: '师傅工资表' }).waitFor();
  await page.getByLabel('筛选师傅').selectOption('FieldDesk0005');
  await page.getByRole('heading', { name: '合成师傅甲的明细' }).waitFor();
  assert.equal(await page.getByRole('tab', { name: '已计薪（2）', exact: true }).count(), 1);
  await page.getByRole('tab', { name: '重复已排除（1）' }).click();
  assert.equal(await page.locator('td.payroll-reason').count(), 1);
  await page.getByLabel('搜索工单明细').fill('NO_MATCH');
  await page.getByText('没有符合条件的记录。').waitFor();
  await page.getByLabel('搜索工单明细').fill('');
  await page.getByRole('tab', { name: '已计薪（2）', exact: true }).click();
  await page.screenshot({ path: path.join(output, 'desktop.png'), fullPage: true });
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出工资表（WPS / Excel）' }).click();
  const download = await downloadEvent; await download.saveAs(path.join(output, 'ui-export.xlsx'));
  assert.equal(exportMonth, '2026-09');
  const ExcelJS = require(root + '/node_modules/exceljs'); const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(path.join(output, 'ui-export.xlsx'));
  assert.equal(wb.getWorksheet('计薪工单明细').rowCount, 5); // All technicians, despite the selected drilldown.
  await page.getByLabel('核算月份').fill('2026-08');
  await page.getByText('共计 0 台', { exact: true }).waitFor();
  await page.getByLabel('核算月份').fill('2026-09');
  await page.getByText('共计 4 台', { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(output, 'mobile.png'), fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  assert.deepEqual(errors, []);
  const ordinary = await browser.newContext();
  await ordinary.addInitScript(() => { localStorage.setItem('isLoggedIn', 'true'); localStorage.setItem('fieldDeskAuthenticatedUser', JSON.stringify({ id: 'FieldDesk0007', name: '合成管理员', role: 'admin' })); });
  const other = await ordinary.newPage(); await other.goto(`http://127.0.0.1:${server.address().port}`); await other.getByRole('button', { name: '我的', exact: true }).click();
  assert.equal(await other.getByRole('button', { name: '工资核算', exact: true }).count(), 0);
  console.log('PASS: owner entry, month selection, person filter, duplicate/search drilldown, complete monthly XLSX export, responsive layout, ordinary admin hidden');
 } finally { await browser.close(); server.closeAllConnections(); server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
