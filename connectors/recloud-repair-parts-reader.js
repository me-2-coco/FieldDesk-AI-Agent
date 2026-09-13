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

async function readExistingRepairParts(page, options = {}) {
  const section = await locateRepairPartsSection(page);
  const container = section.locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' rt-table-content ')][1]");
  let total;
  if (await container.count() === 1) {
    const pager = container.locator('.el-pagination');
    if (await pager.count() === 1) {
      const match = (await pager.innerText()).match(/共\s*(\d+)\s*条记录/);
      if (!match) throw partsReaderError('配件总数无法核对', 'RECLOUD_REPAIR_PART_PRECHECK_FAILED');
      total = Number(match[1]);
      if (total > 50) throw partsReaderError('配件超过单页核对上限，禁止按缺件新增', 'RECLOUD_REPAIR_PART_PRECHECK_FAILED');
      const size = pager.getByRole('button', { name: /条\/页/ });
      if (total > 0 && !/50\s*条\/页/.test(await size.innerText())) {
        await size.click({ timeout: 5000 });
        await page.locator('.rt-dropdown-item-text').filter({ hasText: /^\s*50\s*条\/页\s*$/, visible: true }).click({ timeout: 5000 });
      }
      if (total > 0) await section.locator('tbody tr').nth(total - 1).waitFor({ state: 'visible', timeout: 10000 });
    }
  }
  const { headers, columnCount } = await readWidestHeaderRow(section);
  const codeIndex = findHeaderIndex(headers, ["新件编码", "配件编码", "物料编码"]);
  const quantityIndex = findHeaderIndex(headers, ["数量", "配件数量", "更换数量"]);
  const nameIndex = findHeaderIndex(headers, ["新件名称", "配件名称", "物料名称"]);
  const returnIndex = findHeaderIndex(headers, ["是否返厂"]);
  if (options.requireReturnFlag && returnIndex < 0) throw partsReaderError('瑞云是否返厂列缺失，不能跳过标签', 'RECLOUD_RETURN_FLAG_UNKNOWN');
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
    let returnRequired;
    if (options.requireReturnFlag) {
      if (returnIndex >= cellCount) throw partsReaderError('瑞云返厂标记未加载', 'RECLOUD_RETURN_FLAG_UNKNOWN');
      const cell = cells.nth(returnIndex);
      const value = String(await cell.innerText()).trim();
      const checks = cell.locator("input[type='checkbox']");
      const count = await checks.count();
      const checked = count === 1 ? await checks.isChecked() : undefined;
      returnRequired = resolveReturnFlag(value, count, checked);
    }
    result.push({
      partCode,
      partName: nameIndex >= 0 && nameIndex < cellCount ? String(await cells.nth(nameIndex).innerText()).trim() : "",
      quantity,
      ...(options.requireReturnFlag ? { returnRequired } : {}),
    });
  }
  if (total !== undefined && result.length !== total) {
    throw partsReaderError('配件读取数量与瑞云总数不一致，禁止新增', 'RECLOUD_REPAIR_PART_PRECHECK_FAILED');
  }
  return result;
}

function resolveReturnFlag(text, checkboxCount, checked) {
  const value = text === '是' ? true : text === '否' ? false : undefined;
  if (checkboxCount > 1 || (value !== undefined && checkboxCount === 1 && value !== checked)) {
    throw partsReaderError('瑞云返厂标记冲突，不能跳过标签', 'RECLOUD_RETURN_FLAG_UNKNOWN');
  }
  if (value !== undefined) return value;
  if (!text && checkboxCount === 1 && typeof checked === 'boolean') return checked;
  throw partsReaderError('瑞云返厂标记不明确，不能跳过标签', 'RECLOUD_RETURN_FLAG_UNKNOWN');
}

function selectRemoteReturnParts(expected, remote) {
  const codes = new Set();
  return expected.flatMap(part => {
    const code = String(part.partCode || part.code || '').trim().toUpperCase();
    const matches = remote.filter(row => String(row.partCode || '').trim().toUpperCase() === code);
    if (!code || codes.has(code) || matches.length !== 1 || Number(matches[0].quantity) !== Number(part.quantity)
      || typeof matches[0].returnRequired !== 'boolean') {
      throw partsReaderError('瑞云配件编码、数量或返厂标记无法唯一核对', 'RECLOUD_RETURN_PARTS_MISMATCH');
    }
    codes.add(code);
    return matches[0].returnRequired ? [{ ...part, returnRequired: true }] : [];
  });
}

module.exports = {
  normalizeHeader,
  findHeaderIndex,
  locateRepairPartsSection,
  inspectRepairPartsTable,
  readWidestHeaderRow,
  readExistingRepairParts,
  resolveReturnFlag,
  selectRemoteReturnParts,
};
