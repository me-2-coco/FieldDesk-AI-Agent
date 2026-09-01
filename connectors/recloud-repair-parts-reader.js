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
  const section = headings.first().locator("xpath=ancestor::*[.//table][1]");
  if (await section.count() !== 1) {
    throw partsReaderError(
      "服务单更换件明细无法定位唯一表格",
      "RECLOUD_REPAIR_PARTS_TABLE_NOT_FOUND",
      ["repair.partsTable"]
    );
  }
  return section.first();
}

async function inspectRepairPartsTable(page) {
  const section = await locateRepairPartsSection(page);
  const headers = (await section.locator("thead th:visible").allInnerTexts())
    .map(normalizeHeader)
    .filter(Boolean);
  return {
    headers: [...new Set(headers)].slice(0, 30),
    rowCount: await section.locator("tbody tr:visible").count(),
  };
}

function findHeaderIndex(headers, aliases) {
  const normalized = headers.map(normalizeHeader);
  const matches = normalized
    .map((header, index) => aliases.includes(header) ? index : -1)
    .filter((index) => index >= 0);
  return matches.length === 1 ? matches[0] : -1;
}

async function readExistingRepairParts(page) {
  const section = await locateRepairPartsSection(page);
  const headers = (await section.locator("thead th:visible").allInnerTexts()).map(normalizeHeader);
  const codeIndex = findHeaderIndex(headers, ["新件编码", "配件编码", "物料编码"]);
  const quantityIndex = findHeaderIndex(headers, ["数量", "配件数量", "更换数量"]);
  const nameIndex = findHeaderIndex(headers, ["新件名称", "配件名称", "物料名称"]);
  const missingFields = [codeIndex < 0 && "repair.parts.codeColumn", quantityIndex < 0 && "repair.parts.quantityColumn"].filter(Boolean);
  if (missingFields.length) {
    throw partsReaderError("服务单更换件明细列结构已变化", "RECLOUD_REPAIR_PARTS_SCHEMA_CHANGED", missingFields);
  }
  const result = [];
  const rows = section.locator("tbody tr:visible");
  for (let rowIndex = 0; rowIndex < await rows.count(); rowIndex += 1) {
    const cells = rows.nth(rowIndex).locator("td:visible");
    const cellCount = await cells.count();
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
  readExistingRepairParts,
};
