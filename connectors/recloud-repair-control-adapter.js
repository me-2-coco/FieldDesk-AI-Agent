const { RECLOUD_REPAIR_FIELD_TARGETS } = require("./recloud-sync-mapping");

const DIRECT_REPAIR_FIELDS = Object.freeze({
  highestRepairLevel: { control: "TEXT", target: RECLOUD_REPAIR_FIELD_TARGETS.highestRepairLevel.target },
  customerPaidAmount: { control: "NUMBER", target: RECLOUD_REPAIR_FIELD_TARGETS.customerPaidAmount.target },
  logisticsAmount: { control: "NUMBER", target: RECLOUD_REPAIR_FIELD_TARGETS.logisticsAmount.target },
});

function normalizeRepairControlValue(value, control = "TEXT") {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (control !== "NUMBER" || text === "" || text === "--") return text === "--" ? "" : text;
  const numeric = Number(text.replace(/,/g, ""));
  return Number.isFinite(numeric) ? String(numeric) : text;
}

function repairControlError(message, code, key) {
  const error = new Error(message);
  error.code = code;
  error.status = 502;
  error.fieldKey = key;
  return error;
}

function exactTextPattern(value) {
  return new RegExp(`^\\s*${String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`);
}

async function locateUniqueRepairFormItem(scope, definition, key) {
  const labels = scope
    .locator("label:visible, .rt-form-item__label:visible, .el-form-item__label:visible")
    .filter({ hasText: exactTextPattern(definition.target) });
  const labelCount = await labels.count();
  if (labelCount !== 1) {
    throw repairControlError(
      labelCount ? `维修字段 ${key} 标签不唯一` : `维修字段 ${key} 不存在`,
      labelCount ? "RECLOUD_REPAIR_CONTROL_AMBIGUOUS" : "RECLOUD_REPAIR_CONTROL_NOT_FOUND",
      key
    );
  }
  const item = labels.first().locator(
    "xpath=ancestor::*[contains(@class,'form-item') or contains(@class,'form_item')][1]"
  );
  if (await item.count() !== 1) {
    throw repairControlError(
      `维修字段 ${key} 无法定位唯一表单区域`,
      "RECLOUD_REPAIR_CONTROL_INCOMPATIBLE",
      key
    );
  }
  return item.first();
}

async function locateUniqueRepairInput(item, key) {
  const controls = item.locator("input:visible, textarea:visible");
  const count = await controls.count();
  if (count !== 1) {
    throw repairControlError(
      count ? `维修字段 ${key} 存在多个输入框` : `维修字段 ${key} 缺少输入框`,
      count ? "RECLOUD_REPAIR_CONTROL_AMBIGUOUS" : "RECLOUD_REPAIR_CONTROL_INCOMPATIBLE",
      key
    );
  }
  return controls.first();
}

function createRecloudRepairControlAdapter(page, scope, options = {}) {
  function definitionFor(key) {
    const definition = DIRECT_REPAIR_FIELDS[key];
    if (!definition) {
      throw repairControlError(
        `维修字段 ${key} 不是直接表单字段`,
        "RECLOUD_REPAIR_CONTROL_EXCLUDED",
        key
      );
    }
    return definition;
  }

  return {
    async assertSafe() {
      if (typeof options.assertSafe === "function") await options.assertSafe();
    },
    async read(key) {
      const definition = definitionFor(key);
      const item = await locateUniqueRepairFormItem(scope, definition, key);
      const input = await locateUniqueRepairInput(item, key);
      return normalizeRepairControlValue(await input.inputValue(), definition.control);
    },
    async write(key, value) {
      const definition = definitionFor(key);
      const item = await locateUniqueRepairFormItem(scope, definition, key);
      const input = await locateUniqueRepairInput(item, key);
      if (!await input.isEditable().catch(() => false)) {
        throw repairControlError(
          `维修字段 ${key} 当前不可编辑`,
          "RECLOUD_REPAIR_CONTROL_READ_ONLY",
          key
        );
      }
      await input.fill(normalizeRepairControlValue(value, definition.control));
      await page.waitForTimeout?.(50);
    },
  };
}

async function inspectDirectRepairControls(scope) {
  const controls = [];
  for (const [key, definition] of Object.entries(DIRECT_REPAIR_FIELDS)) {
    const labels = scope
      .locator("label:visible, .rt-form-item__label:visible, .el-form-item__label:visible")
      .filter({ hasText: exactTextPattern(definition.target) });
    const labelCount = await labels.count();
    let inputCount = 0;
    let editable = false;
    if (labelCount === 1) {
      const item = labels.first().locator(
        "xpath=ancestor::*[contains(@class,'form-item') or contains(@class,'form_item')][1]"
      );
      if (await item.count() === 1) {
        const inputs = item.first().locator("input:visible, textarea:visible");
        inputCount = await inputs.count();
        editable = inputCount === 1 && await inputs.first().isEditable().catch(() => false);
      }
    }
    controls.push({ key, target: definition.target, labelCount, inputCount, editable });
  }
  return controls;
}

module.exports = {
  DIRECT_REPAIR_FIELDS,
  normalizeRepairControlValue,
  locateUniqueRepairFormItem,
  locateUniqueRepairInput,
  inspectDirectRepairControls,
  createRecloudRepairControlAdapter,
};
