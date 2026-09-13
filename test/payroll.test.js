const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { buildPayroll, exportPayroll, payrollMonth } = require('../shared/payroll');
const { createApp } = require('../server');
const accounts = [5, 6, 4].map(n => ({ userId: `FieldDesk000${n}`, displayName: `合成师傅${n}`, role: 'TECHNICIAN', active: true }));
const order = (rmaNo, overrides = {}) => ({ rmaNo, technicianId: 'FieldDesk0005', productLine: '洗地机', sn: '0000123', treatmentMode: 'REPAIR', repairCompletion: { submittedAt: '2026-08-31T16:00:00Z' }, ...overrides });
const report = orders => buildPayroll(orders, accounts, { month: '2026-09' });

test('four rates; debugging and inspection count as normal; per-person detail reconciles', () => {
  const data = report([
    order('A'), order('B', { treatmentMode: 'ABANDONED' }),
    order('C', { productLine: '扫地机', technicianId: 'FieldDesk0006' }),
    order('D', { productLine: '扫地机', treatmentMode: 'ABANDONED', technicianId: 'FieldDesk0006' }),
    order('E', { treatmentMode: 'DEBUGGING' }), order('F', { treatmentMode: 'INSPECTION_ONLY' }),
  ]);
  assert.deepEqual(data.summary.counts, { floorRepair: 3, floorAbandoned: 1, robotRepair: 1, robotAbandoned: 1 });
  assert.equal(data.summary.amount, 90); assert.equal(data.summary.total, 6);
  assert.equal(data.summary.repair, 4); assert.equal(data.summary.abandoned, 2);
  for (const person of data.people) {
    const rows = data.rows.filter(row => row.technicianId === person.technicianId);
    assert.equal(person.total, rows.length);
    assert.equal(person.amount, rows.reduce((sum, row) => sum + row.amount, 0));
  }
});

test('Beijing month is submission time, inclusive start/exclusive next month, never sync or drafts', () => {
  const at = (rma, date) => order(rma, { repairCompletion: { submittedAt: date } });
  const data = report([at('BEFORE', '2026-08-31T15:59:59.999Z'), at('START', '2026-08-31T16:00:00Z'), at('END', '2026-09-30T15:59:59.999Z'), at('AFTER', '2026-09-30T16:00:00Z'),
    order('DRAFT', { status: 'REPAIR_COMPLETION_DRAFT', repairCompletion: { savedAt: '2026-09-10T00:00:00Z' } }),
    order('LEGACY', { status: 'COMPLETED', completedAt: '2026-09-10T00:00:00Z', repairCompletion: {} }),
    order('DELAY', { recloudCompletionSync: { confirmedAt: '2026-10-01T00:00:00Z' } }),
  ]);
  assert.deepEqual(data.rows.map(r => r.rmaNo).sort(), ['DELAY', 'END', 'START']);
  assert.equal(data.rows.find(r => r.rmaNo === 'START').completedTime, '2026-09-01 00:00:00');
  assert.equal(buildPayroll([at('LEAP', '2028-02-29T15:59:59Z')], accounts, { month: '2028-02' }).summary.total, 1);
  assert.equal(buildPayroll([at('YEAR', '2026-12-31T16:00:00Z')], accounts, { month: '2027-01' }).summary.total, 1);
  for (const value of ['2026-13', '2026-00', '', 'xx', '2026-1', '2026-09&includeTest=true']) assert.throws(() => payrollMonth(value), /月份/);
});

test('duplicate RMA normalized, cross-month duplicates excluded, conflicts held instead of paid', () => {
  const data = report([order('a'), order(' A '), order('B', { repairCompletion: { submittedAt: '2026-08-15T00:00:00Z' } }), order('B'), order('C'), order('C', { technicianId: 'FieldDesk0006' })]);
  assert.equal(data.summary.amount, 15); assert.equal(data.summary.total, 1);
  assert.equal(data.duplicates.length, 3); assert.equal(data.pending.length, 1);
  assert.match(data.duplicates.find(r => r.rmaNo === 'B').reason, /2026-08-15/);
  assert.match(data.pending[0].reason, /不一致/);
  assert.ok(data.duplicates.every(r => r.amount === 0));
});

test('unknown products/missing identifiers need review; test accounts visibly excluded by default', () => {
  const orders = [order('A', { productLine: '未知' }), order('B', { technicianId: '' }), order(''), order('TEST', { technicianId: 'FieldDesk0004' })];
  const data = report(orders);
  assert.equal(data.summary.total, 0); assert.equal(data.pending.length, 3); assert.equal(data.excludedTest, 1);
  assert.ok(data.pending.every(r => r.amount === null));
  assert.equal(buildPayroll(orders, accounts, { month: '2026-09', includeTest: true }).summary.amount, 15);
  assert.equal(report([order('DISABLED')]).summary.amount, 15);
  assert.equal(buildPayroll([order('DISABLED')], accounts.map(a => ({ ...a, active: false })), { month: '2026-09' }).people[0].total, 1);
});

test('WPS workbook has complete detail, filters, formula results, safe string IDs and correct total', async () => {
  const data = report([order('=SYNTHETIC'), order('A'), order('A'), order('UNKNOWN', { productLine: '未知' })]);
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(await exportPayroll(data));
  assert.equal(workbook.worksheets.length, 5);
  const sheet = workbook.getWorksheet('工资汇总');
  assert.equal(sheet.getCell('O2').value.result, 30);
  assert.equal(sheet.getCell(`O${sheet.rowCount}`).value.result, 30);
  assert.ok(sheet.autoFilter); assert.equal(sheet.views[0].state, 'frozen');
  const details = workbook.getWorksheet('计薪工单明细');
  assert.equal(details.rowCount, 3); assert.equal(details.getCell('D2').value, '0000123');
  assert.equal(details.getCell('C2').value, '=SYNTHETIC');
  assert.equal(workbook.getWorksheet('重复记录（不计薪）').rowCount, 2);
  assert.equal(workbook.getWorksheet('待核对（不计薪）').rowCount, 2);
  assert.ok(workbook.worksheets.every(s => s.autoFilter));
});

test('payroll read/export owner only, rejects spoof query and headers before reading data', async t => {
  let user = { userId: 'OTHER', role: 'ADMIN' }, reads = 0;
  const app = createApp({}, { readAll: async () => { reads++; return [order('HTTP')]; } }, {
    syncService: {}, getCurrentUser: () => user, accountStore: { list: async () => accounts }, operationalLogger: { write() {} },
  });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}/api/finance/payroll`;
  for (const role of ['ADMIN', 'TECHNICIAN', 'INFORMATION_CLERK', 'WAREHOUSE']) {
    user = { userId: 'OTHER', role };
    for (const suffix of ['', '/export']) {
      const response = await fetch(`${base}${suffix}?month=2026-09&userId=FieldDesk0001&includeTest=true`, { headers: { 'x-fielddesk-local-user': 'FieldDesk0001' } });
      assert.equal(response.status, 403); assert.match(response.headers.get('cache-control'), /no-store/);
    }
  }
  assert.equal(reads, 0);
  user = { userId: 'FieldDesk0001', role: 'ADMIN' };
  const response = await fetch(`${base}?month=2026-09`);
  assert.equal(response.status, 200); assert.equal((await response.json()).data.summary.amount, 15);
  const download = await fetch(`${base}/export?month=2026-09`);
  assert.equal(download.status, 200); assert.match(download.headers.get('content-type'), /spreadsheetml/);
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(Buffer.from(await download.arrayBuffer())); assert.equal(wb.getWorksheet('计薪工单明细').rowCount, 2);
  assert.equal((await fetch(`${base}?month=2026-13`)).status, 400);
});
