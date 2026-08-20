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
  parseSupervisionRows,
  readPendingRmaSupervisionOrders,
  readSupervisionOrders,
};
