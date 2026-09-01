function measureAdapterError(message, code, key = "repairMeasure") {
  const error = new Error(message);
  error.code = code;
  error.status = 502;
  error.fieldKey = key;
  return error;
}

function rankRepairMeasureRows(headingBox, rowBoxes) {
  if (!headingBox) return [];
  return (Array.isArray(rowBoxes) ? rowBoxes : [])
    .map((box, index) => ({
      index,
      box,
      distance: box ? box.y - (headingBox.y + headingBox.height) : Number.POSITIVE_INFINITY,
    }))
    .filter((item) => item.box && item.distance >= 0 && item.distance <= 260)
    .sort((left, right) => left.distance - right.distance || right.box.width - left.box.width);
}

function chooseUniqueRepairMeasureRow(headingBox, rowBoxes) {
  const ranked = rankRepairMeasureRows(headingBox, rowBoxes);
  if (!ranked.length) {
    throw measureAdapterError(
      "故障模式及责任判定区域没有已有数据行",
      "RECLOUD_REPAIR_MEASURE_ROW_NOT_FOUND"
    );
  }
  if (
    ranked.length > 1 &&
    Math.abs(ranked[0].distance - ranked[1].distance) <= 2 &&
    Math.abs(ranked[0].box.width - ranked[1].box.width) <= 2
  ) {
    throw measureAdapterError(
      "故障模式及责任判定区域的数据行不唯一",
      "RECLOUD_REPAIR_MEASURE_ROW_AMBIGUOUS"
    );
  }
  return ranked[0];
}

async function locateRepairMeasureStructure(page) {
  const headings = page.getByText("故障模式及责任判定", { exact: true }).filter({ visible: true });
  const headingCount = await headings.count();
  if (headingCount !== 1) {
    throw measureAdapterError(
      headingCount ? "故障模式及责任判定标题不唯一" : "没有找到故障模式及责任判定区域",
      headingCount ? "RECLOUD_REPAIR_MEASURE_SECTION_AMBIGUOUS" : "RECLOUD_REPAIR_MEASURE_SECTION_NOT_FOUND"
    );
  }
  const heading = headings.first();
  await heading.scrollIntoViewIfNeeded();
  const headingBox = await heading.boundingBox();
  const rows = page.locator("tbody tr:visible");
  const rowBoxes = [];
  for (let index = 0; index < await rows.count(); index += 1) {
    rowBoxes.push(await rows.nth(index).boundingBox().catch(() => null));
  }
  const selected = chooseUniqueRepairMeasureRow(headingBox, rowBoxes);
  return { heading, row: rows.nth(selected.index), rowBox: selected.box, candidateCount: rankRepairMeasureRows(headingBox, rowBoxes).length };
}

async function waitForNewTextarea(page, countBefore, timeoutMs = 2500) {
  const textareas = page.locator("textarea:visible:not([disabled])");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await textareas.count() > countBefore) return textareas;
    await page.waitForTimeout?.(100);
  }
  return null;
}

async function openRepairMeasureEditor(page, options = {}) {
  const structure = await locateRepairMeasureStructure(page);
  const textareas = page.locator("textarea:visible:not([disabled])");
  const countBefore = await textareas.count();
  const clickOptions = {
    force: true,
    position: { x: Math.max(12, structure.rowBox.width - 36), y: structure.rowBox.height / 2 },
    delay: 120,
  };
  await structure.row.dblclick(clickOptions);
  let opened = await waitForNewTextarea(page, countBefore, options.timeoutMs);
  if (!opened) {
    await structure.row.dispatchEvent("dblclick");
    opened = await waitForNewTextarea(page, countBefore, options.timeoutMs);
  }
  if (!opened) {
    throw measureAdapterError(
      "双击已有故障记录后没有打开维修措施编辑框",
      "RECLOUD_REPAIR_MEASURE_EDITOR_NOT_FOUND"
    );
  }
  const candidates = [];
  for (let index = 0; index < await opened.count(); index += 1) {
    const field = opened.nth(index);
    if (!await field.isEditable().catch(() => false)) continue;
    const box = await field.boundingBox().catch(() => null);
    if (box) candidates.push({ field, area: box.width * box.height, index });
  }
  candidates.sort((left, right) => right.area - left.area || right.index - left.index);
  if (!candidates.length || (candidates[1] && candidates[0].area === candidates[1].area)) {
    throw measureAdapterError(
      candidates.length ? "维修措施编辑框不唯一" : "没有找到可编辑的维修措施文本框",
      candidates.length ? "RECLOUD_REPAIR_MEASURE_CONTROL_AMBIGUOUS" : "RECLOUD_REPAIR_MEASURE_CONTROL_NOT_FOUND"
    );
  }
  return candidates[0].field;
}

function createRecloudRepairMeasureAdapter(field, options = {}) {
  return {
    async assertSafe() {
      if (typeof options.assertSafe === "function") await options.assertSafe();
    },
    async read(key) {
      if (key !== "repairMeasure") throw measureAdapterError(`维修措施适配器不支持字段 ${key}`, "RECLOUD_REPAIR_CONTROL_EXCLUDED", key);
      return String(await field.inputValue()).trim();
    },
    async write(key, value) {
      if (key !== "repairMeasure") throw measureAdapterError(`维修措施适配器不支持字段 ${key}`, "RECLOUD_REPAIR_CONTROL_EXCLUDED", key);
      if (!await field.isEditable().catch(() => false)) {
        throw measureAdapterError("维修措施当前不可编辑", "RECLOUD_REPAIR_CONTROL_READ_ONLY", key);
      }
      await field.fill(String(value ?? ""));
    },
  };
}

module.exports = {
  rankRepairMeasureRows,
  chooseUniqueRepairMeasureRow,
  locateRepairMeasureStructure,
  openRepairMeasureEditor,
  createRecloudRepairMeasureAdapter,
};
