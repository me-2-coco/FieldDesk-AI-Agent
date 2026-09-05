function normalizeHeader(value) {
  return String(value || "").replace(/\s+/g, "").trim();
}

function partsReaderError(message, code, missingFields = []) {
  const error = new Error(message);
  error.code = code;
  error.status = 502;
  error.missingFields = missingFields;
  return error;
}

async function locateRepairPartsSection(page) {
  const headings = page.getByText("服务单更换件明细", { exact: true }).filter({ visible: true });
  const headingCount = await headings.count();
  if (headingCount !== 1) {
    throw partsReaderError(
      headingCount ? "服务单更换件明细区域不唯一" : "没有找到服务单更换件明细区域",
      headingCount ? "RECLOUD_REPAIR_PARTS_SECTION_AMBIGUOUS" : "RECLOUD_REPAIR_PARTS_SECTION_NOT_FOUND",
      ["repair.partsSection"]
    );
  }
  const codeHeaders = page.getByRole("columnheader", { name: "新件编码", exact: true }).filter({ visible: true });
  if (await codeHeaders.count() !== 1) {
    throw partsReaderError(
      "服务单更换件明细无法定位唯一的新件编码列",
      "RECLOUD_REPAIR_PARTS_TABLE_NOT_FOUND",
      ["repair.partsTable"]
    );
  }
  const table = codeHeaders.first().locator("xpath=ancestor::*[self::table or @role='table'][1]");
  if (await table.count() !== 1) {
    throw partsReaderError("新件编码列不属于唯一表格", "RECLOUD_REPAIR_PARTS_TABLE_NOT_FOUND", ["repair.partsTable"]);
  }
  const grid = table.first().locator(
    "xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' el-table ') or contains(concat(' ', normalize-space(@class), ' '), ' rt-table ')][1]"
  );
  return await grid.count() === 1 ? grid.first() : table.first();
}

async function inspectRepairPartsTable(page) {
  const section = await locateRepairPartsSection(page);
  const { headers } = await readWidestHeaderRow(section);
  return {
    headers: [...new Set(headers)].slice(0, 30),
    rowCount: await section.getByRole("row").filter({ visible: true }).count(),
  };
}

async function readWidestHeaderRow(section) {
  const rows = section.getByRole("row").filter({ visible: true });
  let headers = [];
  for (let index = 0; index < await rows.count(); index += 1) {
    const current = (await rows.nth(index).getByRole("columnheader").filter({ visible: true }).allInnerTexts()).map(normalizeHeader);
    if (current.length > headers.length) headers = current;
  }
  return { headers, columnCount: headers.length };
}

function findHeaderIndex(headers, aliases) {
  const normalized = headers.map(normalizeHeader);
  for (const alias of aliases) {
    const matches = normalized
      .map((header, index) => header === normalizeHeader(alias) ? index : -1)
      .filter((index) => index >= 0);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) return -1;
  }
  return -1;
}

async function readExistingRepairParts(page) {
  const section = await locateRepairPartsSection(page);
  const { headers, columnCount } = await readWidestHeaderRow(section);
  const codeIndex = findHeaderIndex(headers, ["新件编码", "配件编码", "物料编码"]);
  const quantityIndex = findHeaderIndex(headers, ["数量", "配件数量", "更换数量"]);
  const nameIndex = findHeaderIndex(headers, ["新件名称", "配件名称", "物料名称"]);
  const missingFields = [codeIndex < 0 && "repair.parts.codeColumn", quantityIndex < 0 && "repair.parts.quantityColumn"].filter(Boolean);
  if (missingFields.length) {
    throw partsReaderError(
      `服务单更换件明细列结构已变化：${JSON.stringify(headers)}`,
      "RECLOUD_REPAIR_PARTS_SCHEMA_CHANGED",
      missingFields
    );
  }
  const result = [];
  const rows = section.getByRole("row").filter({ visible: true });
  for (let rowIndex = 0; rowIndex < await rows.count(); rowIndex += 1) {
    const cells = rows.nth(rowIndex).getByRole("cell").filter({ visible: true });
    const cellCount = await cells.count();
    if (columnCount && cellCount < Math.max(codeIndex, quantityIndex) + 1) continue;
    if (codeIndex >= cellCount || quantityIndex >= cellCount) continue;
    const partCode = String(await cells.nth(codeIndex).innerText()).trim().toUpperCase();
    const quantityText = String(await cells.nth(quantityIndex).innerText()).trim();
    const quantity = Number(quantityText);
    if (!partCode || !Number.isInteger(quantity) || quantity <= 0) continue;
    result.push({
      partCode,
      partName: nameIndex >= 0 && nameIndex < cellCount ? String(await cells.nth(nameIndex).innerText()).trim() : "",
      quantity,
    });
  }
  return result;
}

module.exports = {
  normalizeHeader,
  findHeaderIndex,
  locateRepairPartsSection,
  inspectRepairPartsTable,
  readWidestHeaderRow,
  readExistingRepairParts,
};
