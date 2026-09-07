const INVENTORY_PAGE_TITLE = "配件库存";
const RECLOUD_PARTS_INVENTORY_URL = "https://crm2.recloud.com.cn/t/dreame/webapp/dreame/?mainNavName=serviceprovider#/vmlist/new_srv_siteinv/wd";
const INVENTORY_HEADERS = Object.freeze({
  warehouseName: "仓库名称",
  warehouseCode: "仓库编码",
  partName: "配件名称",
  partCode: "配件编码",
  quantity: "数量",
  unit: "单位",
  createdAt: "创建时间",
  productLine: "产品线",
});

function normalizeCell(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function inventoryHeaderIndex(headers, label) {
  return headers.findIndex((header) => normalizeCell(header).includes(label));
}

function parseInventoryRow(headers, cells) {
  const value = (label) => {
    const index = inventoryHeaderIndex(headers, label);
    return index >= 0 ? normalizeCell(cells[index]) : "";
  };
  const quantityText = value(INVENTORY_HEADERS.quantity);
  const quantity = Number(quantityText.replace(/,/g, ""));
  return {
    warehouseName: value(INVENTORY_HEADERS.warehouseName),
    warehouseCode: value(INVENTORY_HEADERS.warehouseCode),
    partName: value(INVENTORY_HEADERS.partName),
    partCode: value(INVENTORY_HEADERS.partCode),
    quantity: Number.isFinite(quantity) ? quantity : quantityText,
    unit: value(INVENTORY_HEADERS.unit),
    createdAt: value(INVENTORY_HEADERS.createdAt),
    productLine: value(INVENTORY_HEADERS.productLine),
  };
}

async function firstVisible(locators) {
  for (const locator of locators) {
    if (await locator.isVisible().catch(() => false)) return locator;
  }
  return null;
}

async function openPartsInventory(page) {
  const inventoryHeading = page.getByText(INVENTORY_PAGE_TITLE, { exact: true }).filter({ visible: true }).first();
  const tableReady = page.getByText("仓库名称", { exact: true }).filter({ visible: true }).first();
  if (await inventoryHeading.isVisible().catch(() => false) && await tableReady.isVisible().catch(() => false)) return;

  await page.goto(RECLOUD_PARTS_INVENTORY_URL, { waitUntil: "domcontentloaded", timeout: 20000 });
  await tableReady.waitFor({ state: "visible", timeout: 20000 }).catch(() => {});
  if (!(await tableReady.isVisible().catch(() => false))) {
    const error = new Error("瑞云备件库存页面未加载完成");
    error.code = "RECLOUD_PARTS_INVENTORY_PAGE_NOT_READY";
    throw error;
  }
}

async function queryRecloudPartsInventory(page, keyword, options = {}) {
  const query = normalizeCell(keyword);
  if (!query) {
    const error = new Error("请输入仓库编码或配件编码");
    error.code = "RECLOUD_PARTS_INVENTORY_QUERY_REQUIRED";
    error.status = 400;
    throw error;
  }
  await openPartsInventory(page);
  const input = await firstVisible([
    page.locator('input[placeholder*="仓库编码"][placeholder*="配件编码"]').first(),
    page.locator('input[placeholder*="仓库编码"]').first(),
    page.locator('input[placeholder*="配件编码"]').first(),
  ]);
  if (!input) {
    const error = new Error("瑞云备件库存查询框发生变化");
    error.code = "RECLOUD_PARTS_INVENTORY_SEARCH_NOT_FOUND";
    throw error;
  }
  await input.fill(query);
  await input.press("Enter");
  await page.waitForTimeout(Number(options.settleMs || 900));

  const table = page.locator(".el-table").filter({ hasText: "仓库名称" }).filter({ hasText: "配件编码" }).first();
  if (!(await table.isVisible().catch(() => false))) {
    const error = new Error("瑞云备件库存结果表发生变化");
    error.code = "RECLOUD_PARTS_INVENTORY_TABLE_NOT_FOUND";
    throw error;
  }
  const headers = (await table.locator(".el-table__header-wrapper th").allInnerTexts()).map(normalizeCell);
  const rowLocators = table.locator(".el-table__body-wrapper tbody tr");
  const rowCount = await rowLocators.count();
  const records = [];
  for (let index = 0; index < rowCount; index += 1) {
    const row = rowLocators.nth(index);
    if (!(await row.isVisible().catch(() => false))) continue;
    const cells = await row.locator("td").allInnerTexts();
    const record = parseInventoryRow(headers, cells);
    if (record.partCode || record.partName) records.push(record);
  }
  return {
    query,
    records,
    count: records.length,
    source: "RECLOUD_PARTS_INVENTORY",
    queriedAt: new Date().toISOString(),
  };
}

module.exports = {
  INVENTORY_HEADERS,
  RECLOUD_PARTS_INVENTORY_URL,
  normalizeCell,
  parseInventoryRow,
  queryRecloudPartsInventory,
};
