const { isOwnerAccount, RECLOUD_TEST_USER_ID } = require('../config/business-access-policy');

const RATES = Object.freeze([
  { key: 'floorRepair', product: '洗地机', category: '维修', price: 15 },
  { key: 'floorAbandoned', product: '洗地机', category: '弃修', price: 5 },
  { key: 'robotRepair', product: '扫地机', category: '维修', price: 30 },
  { key: 'robotAbandoned', product: '扫地机', category: '弃修', price: 10 },
]);
const dateFormatter = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const beijingTime = value => dateFormatter.format(new Date(value));
const canViewPayroll = user => isOwnerAccount(user || {});
function payrollMonth(value) {
  const month = value === undefined ? beijingTime(Date.now()).slice(0, 7) : String(value);
  if (!/^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(month)) throw Object.assign(new Error('请选择有效月份'), { status: 400, code: 'PAYROLL_MONTH_INVALID' });
  return month;
}
// A rolling calendar month in Beijing, clamped at the next month's last day.
function nextMonthDeadline(value) {
  const local = new Date(Date.parse(value) + 8 * 60 * 60 * 1000);
  const year = local.getUTCFullYear(), month = local.getUTCMonth() + 1;
  const day = Math.min(local.getUTCDate(), new Date(Date.UTC(year, month + 1, 0)).getUTCDate());
  return Date.UTC(year, month, day, local.getUTCHours(), local.getUTCMinutes(), local.getUTCSeconds(), local.getUTCMilliseconds()) - 8 * 60 * 60 * 1000;
}
const normalizedSn = value => String(value || '').trim().replace(/\s+/g, '').toUpperCase();
const replacementParts = completion => (Array.isArray(completion?.usedParts) ? completion.usedParts : [])
  .filter(part => part && Number.isFinite(Number(part.quantity)) && Number(part.quantity) > 0 && (part.partCode || part.code || part.partName || part.name))
  .map(part => ({ code: String(part.partCode || part.code || ''), name: String(part.partName || part.name || ''), quantity: Number(part.quantity) }));
const partSignature = row => JSON.stringify(row.parts.map(p => [p.code, p.name, p.quantity]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
const emptyTotals = () => ({ repair: 0, abandoned: 0, total: 0, amount: 0, grossAmount: 0, deduction: 0, repeatRepairs: 0, completedTotal: 0, pending: 0, duplicates: 0, counts: Object.fromEntries(RATES.map(rate => [rate.key, 0])) });

// This report is read-only: payroll is based solely on the original FieldDesk submission,
// independent of the subsequent Recloud sync/shipping status and dates.
function buildPayroll(orders, accounts, filters = {}) {
  const month = payrollMonth(filters.month);
  const includeTest = filters.includeTest === true;
  const accountMap = new Map(accounts.map(a => [a.userId, a]));
  const isTest = id => id === RECLOUD_TEST_USER_ID || /TEST/i.test(accountMap.get(id)?.accountPurpose || '') || /^LOCAL-/.test(id);
  const groups = new Map(), missing = [];
  for (const [index, order] of orders.entries()) {
    const at = order.repairCompletion?.submittedAt;
    if (!at || !Number.isFinite(Date.parse(at))) continue;
    const technicianId = String(order.technicianId || order.operatorId || '').trim();
    const product = String(order.productLine || order.specialty || '').trim();
    const category = order.treatmentMode === 'ABANDONED' || (!order.treatmentMode && /弃修/.test(order.repairCompletion?.repairMeasure || '')) ? '弃修' : '维修';
    const rate = RATES.find(r => r.product === product && r.category === category);
    const row = {
      rowId: String(index), rmaNo: String(order.rmaNo || '').trim().toUpperCase(),
      technicianId, technicianName: accountMap.get(technicianId)?.displayName || order.technicianName || order.operatorName || technicianId || '未归属师傅',
      product, model: order.productModel || order.model || '', sn: normalizedSn(order.sn), parts: replacementParts(order.repairCompletion),
      completedAt: new Date(at).toISOString(), completedTime: beijingTime(at), category,
      treatment: order.treatmentLabel || ({ REPAIR: '维修', ABANDONED: '弃修', DEBUGGING: '调试', INSPECTION_ONLY: '只检测不维修', ON_HOLD: '挂单', TRANSFER_TO_HEADQUARTERS: '转总部' }[order.treatmentMode]) || category,
      rateKey: rate?.key || '', unitPrice: rate?.price ?? null, amount: rate?.price ?? null,
      reason: !normalizedSn(order.sn) ? '缺少机器SN，无法核对重复维修' : !technicianId ? '缺少师傅账号' : !rate ? '机型分类未确认，无法确定单价' : ['ON_HOLD', 'TRANSFER_TO_HEADQUARTERS'].includes(order.treatmentMode) ? '当前为挂单或转总部，请核对完工记录' : '',
    };
    if (!row.rmaNo) { missing.push({ ...row, reason: '缺少寄修单号，无法去重' }); continue; }
    if (!groups.has(row.rmaNo)) groups.set(row.rmaNo, []);
    groups.get(row.rmaNo).push(row);
  }
  const rows = [], pending = [], duplicates = [], repeatRepairs = [], canonical = [];
  let excludedTest = 0;
  const inMonth = row => row.completedTime.slice(0, 7) === month;
  const included = row => {
    if (!inMonth(row)) return false;
    if (!includeTest && isTest(row.technicianId)) { excludedTest++; return false; }
    return true;
  };
  for (const group of groups.values()) {
    group.sort((a, b) => a.completedAt.localeCompare(b.completedAt) || a.rowId.localeCompare(b.rowId));
    const first = group[0];
    const conflict = group.some(row => row.technicianId !== first.technicianId || row.product !== first.product || row.category !== first.category || row.sn !== first.sn || partSignature(row) !== partSignature(first));
    canonical.push({ ...first, reason: conflict ? '同一寄修单的师傅、机型、SN、维修分类或配件不一致，暂不计薪' : first.reason });
    for (const row of group.slice(1)) if (included(row)) duplicates.push({ ...row, amount: 0, firstCompletedTime: first.completedTime, firstTechnicianId: first.technicianId, reason: `同一寄修单只计一次；首次提交 ${first.completedTime}，账号 ${first.technicianId || '未归属'}${conflict ? '；记录冲突，整单待核对' : ''}` });
  }
  // Build SN history before filtering the payroll month. Excluded test accounts
  // cannot make a formal technician's repair ineligible for payment.
  const history = new Map();
  canonical.sort((a, b) => a.completedAt.localeCompare(b.completedAt) || a.rmaNo.localeCompare(b.rmaNo));
  for (const row of canonical) {
    if (!includeTest && isTest(row.technicianId)) { if (inMonth(row)) excludedTest++; continue; }
    const previous = row.sn ? history.get(row.sn) : null;
    const withinMonth = previous && Date.parse(row.completedAt) <= nextMonthDeadline(previous.completedAt);
    const repeat = withinMonth && row.parts.length > 0;
    let reason = row.reason;
    if (repeat && !reason && previous.reason) reason = '同SN前次工单待核对，暂不能确认重复维修结算';
    if (inMonth(row)) {
      if (reason) pending.push({ ...row, amount: null, reason });
      else if (repeat) repeatRepairs.push({ ...row, amount: 0, deduction: row.unitPrice,
        previousRmaNo: previous.rmaNo, previousCompletedTime: previous.completedTime,
        previousTechnicianId: previous.technicianId, previousTechnicianName: previous.technicianName,
        repeatDeadline: beijingTime(nextMonthDeadline(previous.completedAt)),
        reason: `同SN在前次完工后一个月内再次维修，且本次更换了配件；前单 ${previous.rmaNo}，前次完工 ${previous.completedTime}，本次不结算，不倒扣前次工资`,
      });
      else rows.push(row);
    }
    if (row.sn) history.set(row.sn, { ...row, reason });
  }
  for (const row of missing) if (included(row)) pending.push({ ...row, amount: null });
  const peopleMap = new Map();
  const person = row => {
    if (!peopleMap.has(row.technicianId)) peopleMap.set(row.technicianId, { technicianId: row.technicianId, technicianName: row.technicianName, ...emptyTotals() });
    return peopleMap.get(row.technicianId);
  };
  for (const account of accounts) if (account.role === 'TECHNICIAN' && account.active !== false && (includeTest || !isTest(account.userId))) person({ technicianId: account.userId, technicianName: account.displayName || account.userId });
  const summary = emptyTotals();
  for (const row of rows) for (const target of [summary, person(row)]) {
    target[row.category === '弃修' ? 'abandoned' : 'repair']++;
    target.total++; target.completedTotal++; target.amount += row.amount; target.grossAmount += row.amount; target.counts[row.rateKey]++;
  }
  for (const row of repeatRepairs) for (const target of [summary, person(row)]) {
    target.repeatRepairs++; target.completedTotal++; target.deduction += row.deduction; target.grossAmount += row.deduction;
  }
  for (const row of pending) { summary.pending++; person(row).pending++; }
  for (const row of duplicates) { summary.duplicates++; person(row).duplicates++; }
  for (const list of [rows, pending, duplicates, repeatRepairs]) list.sort((a, b) => b.completedAt.localeCompare(a.completedAt) || a.rmaNo.localeCompare(b.rmaNo));
  return { month, timezone: 'Asia/Shanghai', generatedAt: new Date().toISOString(), includeTest, excludedTest, rates: RATES, summary,
    people: [...peopleMap.values()].sort((a, b) => a.technicianId.localeCompare(b.technicianId)), rows, pending, duplicates, repeatRepairs };
}

async function exportPayroll(data) {
  const ExcelJS = require('exceljs');
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'FieldDesk';
  workbook.calcProperties.fullCalcOnLoad = true;
  const summary = workbook.addWorksheet('工资汇总');
  summary.columns = [
    { header: '月份', key: 'month', width: 13 }, { header: '师傅账号', key: 'technicianId', width: 22 }, { header: '师傅', key: 'technicianName', width: 20 },
    ...RATES.flatMap(rate => [{ header: `${rate.product}${rate.category}台数`, key: rate.key, width: 20 }, { header: '单价（元）', key: `${rate.key}Price`, width: 14 }]),
    { header: '计薪维修台数', key: 'repair', width: 14 }, { header: '计薪弃修台数', key: 'abandoned', width: 14 }, { header: '计薪台数', key: 'total', width: 14 },
    { header: '应结工资（元）', key: 'amount', width: 20 }, { header: '待核对（不计薪）', key: 'pending', width: 22 }, { header: '重复记录（已排除）', key: 'duplicates', width: 24 },
    { header: '扣除前工资（元）', key: 'grossAmount', width: 22 }, { header: '重复维修扣除（元）', key: 'deduction', width: 24 },
    { header: '重复维修次数', key: 'repeatRepairs', width: 20 }, { header: '完工次数（含重复维修）', key: 'completedTotal', width: 28 },
  ];
  for (const p of data.people) {
    const values = { ...p, ...p.counts, month: data.month };
    RATES.forEach(rate => { values[`${rate.key}Price`] = rate.price; });
    const row = summary.addRow(values), n = row.number;
    row.getCell('amount').value = { formula: `R${n}-S${n}`, result: p.amount };
  }
  const total = summary.addRow({ technicianName: '合计', ...data.summary, ...data.summary.counts });
  for (const key of ['repair', 'abandoned', 'total', 'amount', 'pending', 'duplicates', 'grossAmount', 'deduction', 'repeatRepairs', 'completedTotal', ...RATES.map(r => r.key)]) {
    const col = summary.getColumn(key).letter;
    total.getCell(key).value = { formula: data.people.length ? `SUM(${col}2:${col}${total.number - 1})` : '0', result: data.summary[key] ?? data.summary.counts[key] };
  }
  total.font = { bold: true };
  for (const key of ['amount', 'grossAmount', 'deduction']) summary.getColumn(key).numFmt = '#,##0.00';
  const detailColumns = [
    ['technicianId', '师傅账号', 22], ['technicianName', '师傅', 20], ['rmaNo', '寄修单号', 28], ['sn', '机器SN', 28], ['product', '机型分类', 14], ['model', '产品型号', 24],
    ['category', '计薪分类', 14], ['treatment', '实际维修类型', 22], ['completedTime', '提交完工时间（北京时间）', 28], ['unitPrice', '单价（元）', 14], ['amount', '计薪金额（元）', 18], ['reason', '核对说明', 66],
    ['partsText', '本次更换配件及数量', 48], ['previousRmaNo', '前次寄修单号', 28], ['previousCompletedTime', '前次完工时间（北京时间）', 30],
    ['previousTechnicianId', '前次师傅账号', 24], ['previousTechnicianName', '前次师傅', 22], ['repeatDeadline', '一个月期限（北京时间）', 30], ['deduction', '重复维修未结算金额（元）', 30],
  ].map(([key, header, width]) => ({ key, header, width }));
  for (const [name, records] of [['计薪工单明细', data.rows], ['重复维修（不计薪）', data.repeatRepairs], ['重复记录（不计薪）', data.duplicates], ['待核对（不计薪）', data.pending]]) {
    const sheet = workbook.addWorksheet(name); sheet.columns = detailColumns.map(c => ({ ...c }));
    records.forEach(row => sheet.addRow({ ...row, partsText: row.parts.map(p => `${p.name || p.code}${p.name && p.code ? `（${p.code}）` : ''} × ${p.quantity}`).join('；') }));
    sheet.getColumn('deduction').numFmt = '#,##0.00';
    sheet.getColumn('unitPrice').numFmt = '#,##0.00'; sheet.getColumn('amount').numFmt = '#,##0.00';
  }
  const notes = workbook.addWorksheet('核算说明');
  notes.columns = [{ header: '项目', key: 'label', width: 26 }, { header: '说明', key: 'value', width: 110 }];
  notes.addRows([
    { label: '归属月份', value: `${data.month}；北京时间月初00:00至次月月初00:00（不含）` },
    { label: '时间依据', value: '仅按 FieldDesk 提交完工时间；不采用瑞云同步时间、发货时间或草稿保存时间。' },
    { label: '单价', value: '洗地机维修15元、弃修5元；扫地机维修30元、弃修10元。调试、只检测不维修等非弃修完工类型按维修计薪。' },
    { label: '去重', value: '同一寄修单仅首次提交计一次；重复记录单列。师傅、机型、SN、计薪分类或配件冲突时整单暂不计薪。' },
    { label: '重复维修', value: '以SN识别机器，与电话及寄修单号是否相同无关。同SN前次提交完工后一个月内再次完工且本次更换配件，本次不计薪；未更换配件正常计薪。跨月份、跨师傅均检查；按本次师傅扣除，不倒扣前次工资。' },
    { label: '一个月期限', value: '以最近一次不同寄修单的提交完工时间起，到次月同日同一时刻（含）；次月无对应日期取月末。每次实际维修都更新前次记录，同单重复数据不更新。' },
    { label: '金额核对', value: '扣除前工资－重复维修扣除＝应结工资。计薪台数及四类计薪台数已经排除重复维修，不再重复扣款。重复维修明细保留前后工单和本次更换配件。' },
    { label: '待核对', value: '待核对记录不计入当前工资合计，修正源工单后刷新重算。金额为空表示尚不能确定，不代表工资为0元。' },
    { label: '测试账号', value: data.includeTest ? '包含测试账号，仅供试算。' : `不含测试账号；本月排除 ${data.excludedTest} 条测试记录。` },
    { label: '生成时间', value: beijingTime(data.generatedAt) },
    { label: '报表性质', value: '当前工单数据实时核算表，未锁账，未标记工资发放；数据变动后重新导出。' },
  ]);
  for (const sheet of workbook.worksheets) {
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: sheet === summary ? Math.max(1, sheet.rowCount - 1) : sheet.rowCount, column: sheet.columnCount } };
    sheet.getRow(1).height = 32;
    sheet.getRow(1).eachCell(cell => { cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2469BE' } }; cell.alignment = { vertical: 'middle', wrapText: true }; });
    sheet.pageSetup = { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
  }
  return workbook.xlsx.writeBuffer();
}
module.exports = { canViewPayroll, payrollMonth, buildPayroll, exportPayroll };
