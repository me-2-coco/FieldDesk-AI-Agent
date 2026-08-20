function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

const FIELD_MAP = Object.freeze({
  申诉状态: "appealStatus",
  复议结果: "reviewResult",
  督办单号: "sourceId",
  关联寄修单: "rmaNo",
  关联服务单: "serviceOrderNo",
  督办类型: "type",
  督办子类: "subtype",
  客服备注: "content",
  服务站: "serviceStation",
  处理状态: "status",
  创建时间: "createdAt",
  响应时间: "respondedAt",
  开始处理时间: "startedAt",
  完成时间: "completedAt",
  督办处理记录: "processingRecord",
  创建者: "createdBy",
});

const CENTRAL_SUPERVISION_URL = "https://crm2.recloud.com.cn/t/dreame/webapp/dreame/?mainNavName=serviceprovider#/vmlist/dreame_customercomplaint/station";

function parseSupervisionRows(headers = [], rows = []) {
  const normalizedHeaders = headers.map(normalizeText);
  return rows.map((cells) => {
    const record = {};
    normalizedHeaders.forEach((header, index) => {
      const key = FIELD_MAP[header];
      if (key) record[key] = normalizeText(cells[index]);
    });
    return record;
  }).filter((record) => record.sourceId || record.content);
}

async function readTableRows(table) {
  const rows = table.locator("tbody tr, [role='row']");
  const result = [];
  const count = await rows.count();
  for (let index = 0; index < count; index += 1) {
    const cells = rows.nth(index).locator("td, [role='cell'], [role='gridcell']");
    const cellCount = await cells.count();
    if (!cellCount) continue;
    const values = [];
    for (let cellIndex = 0; cellIndex < cellCount; cellIndex += 1) {
      values.push(await cells.nth(cellIndex).innerText().catch(() => ""));
    }
    result.push(values);
  }
  return result;
}

async function readSupervisionOrders(page) {
  const tab = page.getByRole("tab", { name: "督办单", exact: true }).first();
  if (!(await tab.isVisible().catch(() => false))) {
    const error = new Error("瑞云寄修单详情中未找到督办单标签");
    error.code = "RECLOUD_SUPERVISION_TAB_NOT_FOUND";
    throw error;
  }
  await tab.click();

  const panel = page.getByRole("tabpanel", { name: "督办单", exact: true }).first();
  await panel.waitFor({ state: "visible" });
  const tables = panel.locator("table");
  const tableCount = await tables.count();
  let headerIndex = -1;
  let headers = [];
  for (let index = 0; index < tableCount; index += 1) {
    const current = tables.nth(index);
    const currentHeaders = await current
      .locator("th, [role='columnheader']")
      .allInnerTexts()
      .catch(() => []);
    if (currentHeaders.map(normalizeText).includes("督办单号")) {
      headerIndex = index;
      headers = currentHeaders;
      break;
    }
  }
  if (headerIndex < 0) {
    const error = new Error("瑞云督办单表格结构已变化");
    error.code = "RECLOUD_SUPERVISION_TABLE_CHANGED";
    throw error;
  }

  const rows = [];
  for (let index = headerIndex; index < tableCount; index += 1) {
    rows.push(...await readTableRows(tables.nth(index)));
  }
  return parseSupervisionRows(headers, rows);
}

function isBlankReference(value) {
  return !normalizeText(value) || /^-+$/.test(normalizeText(value));
}

function filterPendingRmaSupervisionOrders(records = []) {
  return records.filter((record) => (
    !isBlankReference(record.rmaNo) &&
    isBlankReference(record.serviceOrderNo) &&
    (!record.status || /未处理|待处理/.test(record.status))
  ));
}

function filterRmaSupervisionOrders(records = []) {
  return records.filter((record) => (
    !isBlankReference(record.rmaNo) &&
    isBlankReference(record.serviceOrderNo)
  ));
}

async function readCentralSupervisionTable(page) {
  const tables = page.locator("table");
  await tables.first().waitFor({ state: "visible" });
  const tableCount = await tables.count();
  let headerIndex = -1;
  let headers = [];
  for (let index = 0; index < tableCount; index += 1) {
    const current = tables.nth(index);
    const currentHeaders = await current.locator("th, [role='columnheader']").allInnerTexts().catch(() => []);
    const normalized = currentHeaders.map(normalizeText);
    if (normalized.includes("督办单号") && normalized.includes("关联寄修单")) {
      headerIndex = index;
      headers = currentHeaders;
      break;
    }
  }
  if (headerIndex < 0) {
    const error = new Error("瑞云中央督办单表格结构已变化");
    error.code = "RECLOUD_CENTRAL_SUPERVISION_TABLE_CHANGED";
    throw error;
  }
  // 瑞云的虚拟表格会把表头与可见数据行拆成相邻 table。只读表头所在
  // table 会得到 0 行，因此从表头开始合并同一列表区域内的后续表格。
  const records = [];
  const seen = new Set();
  for (let index = headerIndex; index < tableCount; index += 1) {
    const parsed = parseSupervisionRows(headers, await readTableRows(tables.nth(index)));
    for (const record of parsed) {
      const key = record.sourceId || `${record.rmaNo}|${record.content}`;
      if (seen.has(key)) continue;
      seen.add(key);
      records.push(record);
    }
  }
  return records;
}

async function readRmaSupervisionOrderStatuses(page) {
  await page.goto(CENTRAL_SUPERVISION_URL);
  const statuses = ["未处理", "已响应", "处理中", "已完成"];
  const records = [];
  for (const status of statuses) {
    const tab = page.getByText(status, { exact: true }).first();
    await tab.waitFor({ state: "visible" });
    await tab.click();
    await page.waitForTimeout(250);
    const current = await readCentralSupervisionTable(page);
    records.push(...filterRmaSupervisionOrders(current).map((record) => ({
      ...record,
      status: record.status || status,
    })));
  }
  return records;
}

async function readPendingRmaSupervisionOrders(page) {
  await page.goto(CENTRAL_SUPERVISION_URL);
  const pendingTab = page.getByText("未处理", { exact: true }).first();
  await pendingTab.waitFor({ state: "visible" });
  await pendingTab.click();

  const tables = page.locator("table");
  await tables.first().waitFor({ state: "visible" });
  const tableCount = await tables.count();
  let targetTable = null;
  let headers = [];
  for (let index = 0; index < tableCount; index += 1) {
    const current = tables.nth(index);
    const currentHeaders = await current
      .locator("th, [role='columnheader']")
      .allInnerTexts()
      .catch(() => []);
    const normalized = currentHeaders.map(normalizeText);
    if (normalized.includes("督办单号") && normalized.includes("关联寄修单")) {
      targetTable = current;
      headers = currentHeaders;
      break;
    }
  }
  if (!targetTable) {
    const error = new Error("瑞云中央督办单表格结构已变化");
    error.code = "RECLOUD_CENTRAL_SUPERVISION_TABLE_CHANGED";
    throw error;
  }
  const records = parseSupervisionRows(headers, await readTableRows(targetTable));
  return filterPendingRmaSupervisionOrders(records);
}

module.exports = {
  CENTRAL_SUPERVISION_URL,
  FIELD_MAP,
  filterPendingRmaSupervisionOrders,
  filterRmaSupervisionOrders,
  parseSupervisionRows,
  readPendingRmaSupervisionOrders,
  readRmaSupervisionOrderStatuses,
  readSupervisionOrders,
};
