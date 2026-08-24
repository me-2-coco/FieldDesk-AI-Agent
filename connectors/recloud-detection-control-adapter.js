const { RECLOUD_INSPECTION_FIELD_TARGETS } = require("./recloud-sync-mapping");

function normalizeControlText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function adapterError(message, code, key) {
  const error = new Error(message);
  error.code = code;
  error.status = 502;
  error.fieldKey = key;
  return error;
}

async function uniqueExactCandidate(candidates, value, key) {
  const expected = normalizeControlText(value);
  const matches = [];
  for (const candidate of candidates) {
    const text = normalizeControlText(await candidate.text());
    if (text === expected) matches.push(candidate);
  }
  if (matches.length !== 1) {
    throw adapterError(
      matches.length
        ? `检测字段 ${key} 存在多个完全相同的选项`
        : `检测字段 ${key} 未找到完全匹配的选项`,
      matches.length ? "RECLOUD_DETECTION_OPTION_AMBIGUOUS" : "RECLOUD_DETECTION_OPTION_NOT_FOUND",
      key
    );
  }
  return matches[0];
}

async function uniqueFullPathOrLeafCandidate(candidates, value, key) {
  const expected = normalizeControlText(value);
  const expectedLeaf = normalizeControlText(expected.split("/").at(-1));
  const matches = [];
  const candidateTexts = [];
  for (const candidate of candidates) {
    const text = normalizeControlText(await candidate.text());
    candidateTexts.push(text);
    const leaf = normalizeControlText(text.split("/").at(-1));
    if (text === expected || leaf === expectedLeaf) matches.push(candidate);
  }
  if (matches.length !== 1) {
    const error = adapterError(
      matches.length
        ? `检测字段 ${key} 存在多个同名末级选项`
        : `检测字段 ${key} 未找到完整路径或唯一末级选项`,
      matches.length ? "RECLOUD_DETECTION_OPTION_AMBIGUOUS" : "RECLOUD_DETECTION_OPTION_NOT_FOUND",
      key
    );
    error.expectedValue = expected;
    error.candidateValues = candidateTexts.slice(0, 20);
    throw error;
  }
  return matches[0];
}

function labelPattern(label) {
  return new RegExp(
    String(label).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[（(]/g, "[（(]").replace(/[）)]/g, "[）)]")
  );
}

async function locateUniqueItem(dialog, definition, key) {
  const items = dialog
    .locator(".rt-form-item:visible, .el-form-item:visible")
    .filter({ hasText: labelPattern(definition.target) });
  const count = await items.count();
  if (count !== 1) {
    throw adapterError(
      count ? `检测字段 ${key} 对应多个表单区域` : `检测字段 ${key} 不存在`,
      count ? "RECLOUD_DETECTION_CONTROL_AMBIGUOUS" : "RECLOUD_DETECTION_CONTROL_NOT_FOUND",
      key
    );
  }
  return items.first();
}

async function readInputValue(item) {
  const input = item.locator("textarea:visible, input:visible").last();
  if (!await input.count()) return "";
  return normalizeControlText(await input.inputValue().catch(() => ""));
}

async function readSelectValue(item) {
  const selected = item.locator(
    ".rt-picklist__tags .rt-tag-text:visible, .rtxpc-select__tags .rt-tag-text:visible, " +
    ".el-select__tags .el-tag__content:visible, " +
    ".rt-select__selected-value:visible, .el-select__selected-item:visible"
  );
  if (!await selected.count()) return "";
  return normalizeControlText(await selected.first().innerText().catch(() => ""));
}

async function readRadioValue(item) {
  const selected = item.locator(
    ".rt-radio.is-checked:visible, .el-radio.is-checked:visible, [role='radio'][aria-checked='true']:visible, label:has(input[type='radio']:checked):visible"
  );
  if (!await selected.count()) return "";
  return normalizeControlText(await selected.first().innerText().catch(() => ""));
}

async function visibleCandidates(locator) {
  const candidates = [];
  for (let index = 0; index < await locator.count(); index += 1) {
    const option = locator.nth(index);
    if (!await option.isVisible().catch(() => false)) continue;
    candidates.push({
      text: () => option.innerText(),
      click: () => option.click({ timeout: 3000 }),
    });
  }
  return candidates;
}

async function chooseDropdownValue(page, item, value, key, searchable) {
  const expected = normalizeControlText(value);
  const input = item.locator("input:visible, [role='combobox']:visible").last();
  if (!await input.count()) {
    throw adapterError(`检测字段 ${key} 缺少可操作输入控件`, "RECLOUD_DETECTION_CONTROL_INCOMPATIBLE", key);
  }
  if (!expected) {
    if (searchable) await input.fill("");
    if (!await readSelectValue(item)) return;
    await input.click({ timeout: 3000 });
    const clear = item.locator(
      ".rt-xpc-picklist-clearicon:visible, .rt-picklist__clear:visible, " +
      ".rtxpc-select__clear:visible, .el-select__clear:visible, .rt-select__clear:visible"
    );
    if (await clear.count() !== 1) {
      throw adapterError(`检测字段 ${key} 无法安全清空`, "RECLOUD_DETECTION_CONTROL_INCOMPATIBLE", key);
    }
    await clear.first().click({ timeout: 3000 });
    return;
  }
  await input.click({ timeout: 3000 });
  if (searchable && typeof input.fill === "function") {
    await input.fill(normalizeControlText(expected.split("/").at(-1)));
  }
  await page.waitForTimeout?.(300);
  const optionLocator = page.locator(
    ".rt-select-dropdown:visible [role='option']:visible, .el-select-dropdown:visible [role='option']:visible, " +
    ".rt-cascader-dropdown:visible li:visible, .el-cascader__dropdown:visible li:visible, " +
    "[role='list']:visible > *:visible, [role='listbox']:visible > *:visible"
  );
  const candidates = await visibleCandidates(optionLocator);
  let hasExactCandidate = false;
  for (const candidate of candidates) {
    if (normalizeControlText(await candidate.text()) === expected) {
      hasExactCandidate = true;
      break;
    }
  }
  if (!hasExactCandidate && typeof page.getByRole === "function") {
    candidates.push(...await visibleCandidates(page.getByRole("list").getByText(expected, { exact: true })));
  }
  const option = searchable
    ? await uniqueFullPathOrLeafCandidate(candidates, expected, key)
    : await uniqueExactCandidate(candidates, expected, key);
  await option.click();
  await page.waitForTimeout?.(100);
}

async function chooseRadioValue(item, value, key) {
  const expected = normalizeControlText(value);
  const locator = item.locator("label:visible, [role='radio']:visible");
  const candidate = await uniqueExactCandidate(await visibleCandidates(locator), expected, key);
  await candidate.click();
}

function createRecloudDetectionControlAdapter(page, dialog) {
  async function definitionFor(key) {
    const definition = RECLOUD_INSPECTION_FIELD_TARGETS[key];
    if (!definition || definition.status === "EXCLUDED") {
      throw adapterError(`检测字段 ${key} 不允许预填`, "RECLOUD_DETECTION_CONTROL_EXCLUDED", key);
    }
    return definition;
  }

  return {
    async read(key) {
      const definition = await definitionFor(key);
      const item = await locateUniqueItem(dialog, definition, key);
      if (definition.control === "RADIO") return readRadioValue(item);
      if (definition.control === "SELECT") return readSelectValue(item);
      return readInputValue(item);
    },
    async write(key, value) {
      const definition = await definitionFor(key);
      const item = await locateUniqueItem(dialog, definition, key);
      if (definition.control === "RADIO") return chooseRadioValue(item, value, key);
      if (definition.control === "SELECT") return chooseDropdownValue(page, item, value, key, false);
      if (definition.control === "SEARCH_INPUT") return chooseDropdownValue(page, item, value, key, true);
      if (definition.control === "TEXT_INPUT") {
        const input = item.locator("textarea:visible, input:visible").last();
        if (!await input.count()) {
          throw adapterError(`检测字段 ${key} 缺少文本控件`, "RECLOUD_DETECTION_CONTROL_INCOMPATIBLE", key);
        }
        await input.fill(String(value ?? ""));
        return;
      }
      throw adapterError(`检测字段 ${key} 控件类型不受支持`, "RECLOUD_DETECTION_CONTROL_INCOMPATIBLE", key);
    },
  };
}

module.exports = {
  normalizeControlText,
  uniqueExactCandidate,
  uniqueFullPathOrLeafCandidate,
  readSelectValue,
  chooseDropdownValue,
  createRecloudDetectionControlAdapter,
};
