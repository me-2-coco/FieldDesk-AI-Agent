const { inspectCurrentAssignee, locateUniqueTargetTechnicianRow } = require("./recloud-repair-execution-inspector");
const { openRepairPartAddDialog } = require("./recloud-repair-part-dialog");
const { readExistingRepairParts } = require("./recloud-repair-parts-reader");

function adapterError(message, code, phase) {
  const error = new Error(message);
  error.code = code;
  error.status = 502;
  error.phase = phase;
  return error;
}

function exactText(value) {
  return new RegExp(`^\\s*${String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`);
}

async function uniqueVisible(locator, message, code, phase) {
  const count = await locator.count();
  if (count !== 1) throw adapterError(`${message}（匹配 ${count} 个）`, code, phase);
  return locator.first();
}

async function openServiceReport(page, timeoutMs = 15000) {
  const partsHeading = page.getByText("服务单更换件明细", { exact: true }).filter({ visible: true });
  if (await partsHeading.count() === 1) return;
  const tabs = page.getByText("服务报告", { exact: true }).filter({ visible: true });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && await tabs.count() !== 1) {
    if (await partsHeading.count() === 1) return;
    await page.waitForTimeout?.(200);
  }
  const tab = await uniqueVisible(
    tabs,
    "无法唯一定位瑞云服务报告",
    "RECLOUD_SERVICE_REPORT_TAB_AMBIGUOUS",
    "PAGE"
  );
  const selected = await tab.getAttribute("aria-selected").catch(() => "");
  if (selected !== "true") {
    await tab.click({ timeout: 5000 });
    await page.waitForTimeout?.(500);
  }
}

async function locateDialogInput(dialog, labelText) {
  const labels = dialog
    .locator("label:visible, .rt-form-item__label:visible, .el-form-item__label:visible")
    .filter({ hasText: exactText(labelText) });
  if (await labels.count() !== 1) return null;
  const item = labels.first().locator("xpath=ancestor::*[contains(@class,'form-item') or contains(@class,'form_item')][1]");
  if (await item.count() !== 1) return null;
  const input = item.first().locator("input:visible, textarea:visible");
  return await input.count() === 1 ? input.first() : null;
}

async function waitForDialog(page, countBefore, timeoutMs = 7000) {
  const dialogs = page.locator("[role='dialog']:visible, .el-dialog:visible, .rt-dialog:visible, .rt-dialog__wrapper:visible");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await dialogs.count() > countBefore) return dialogs.last();
    await page.waitForTimeout?.(100);
  }
  throw adapterError("瑞云操作窗口未打开", "RECLOUD_REPAIR_DIALOG_NOT_FOUND", "PAGE");
}

async function selectFirstRequiredOption(page, input) {
  await input.click({ timeout: 3000 });
  await input.press("ArrowDown").catch(() => {});
  await input.press("Enter").catch(() => {});
  await page.waitForTimeout?.(250);
}

function createRecloudRepairPageAdapter(page) {
  return {
    async readAssignee() {
      const assignee = await inspectCurrentAssignee(page);
      return assignee.currentAssignee;
    },

    async readRemoteState() {
      const assignee = await inspectCurrentAssignee(page);
      await openServiceReport(page);
      let parts = [];
      try {
        parts = await readExistingRepairParts(page);
      } catch (error) {
        if (error.code !== "RECLOUD_REPAIR_PARTS_TABLE_NOT_FOUND") throw error;
      }
      return { assignee: assignee.currentAssignee, parts };
    },

    async assignResponsible(plan) {
      // 瑞云只有首次进入服务单时允许“改派”。严禁使用“派单”，也不
      // 提供退出后重新进单补派/补改派的降级路径。
      const button = await uniqueVisible(
        page.getByRole("button", { name: exactText("改派") }).filter({ visible: true }),
        "无法唯一定位瑞云改派按钮",
        "RECLOUD_ASSIGNMENT_BUTTON_AMBIGUOUS",
        "ASSIGNMENT"
      );
      const dialogs = page.locator("[role='dialog']:visible, .el-dialog:visible, .rt-dialog:visible, .rt-dialog__wrapper:visible");
      const before = await dialogs.count();
      await button.click({ timeout: 5000 });
      const dialog = await waitForDialog(page, before);
      const input = await locateDialogInput(dialog, "服务人员");
      if (!input) throw adapterError("改派窗口缺少服务人员搜索框", "RECLOUD_ASSIGNMENT_INPUT_NOT_FOUND", "ASSIGNMENT");
      await input.fill(plan.servicePerson);
      await input.press("Enter");
      await page.waitForTimeout?.(500);
      const rows = await locateUniqueTargetTechnicianRow(dialog, plan.servicePerson);
      if (rows.length !== 1) {
        throw adapterError(`瑞云中没有唯一匹配的师傅：${plan.servicePerson}`, "RECLOUD_ASSIGNMENT_TARGET_NOT_UNIQUE", "ASSIGNMENT");
      }
      const responsible = await uniqueVisible(
        rows[0].getByRole("button", { name: exactText("负责人") }).filter({ visible: true }),
        "目标师傅行缺少负责人按钮",
        "RECLOUD_ASSIGNMENT_RESPONSIBLE_NOT_FOUND",
        "ASSIGNMENT"
      );
      await responsible.click({ timeout: 5000 });
      await dialog.waitFor({ state: "hidden", timeout: 8000 }).catch(() => {});
      await page.waitForTimeout?.(500);
    },

    async confirmWarrantyConversion(options = {}) {
      if (options.requested !== true) return { skipped: true, reason: "NOT_REQUESTED" };
      const productTab = await uniqueVisible(
        page.getByText("产品信息", { exact: true }).filter({ visible: true }),
        "无法唯一定位产品信息页签",
        "RECLOUD_PRODUCT_TAB_AMBIGUOUS",
        "WARRANTY_CONVERSION"
      );
      await productTab.click({ timeout: 5000 });
      await page.waitForTimeout?.(350);
      const buttons = page.getByRole("button", { name: exactText("保外转保内") }).filter({ visible: true });
      if (await buttons.count() === 0) return { alreadyCompleted: true };
      throw adapterError(
        "保外转保内已申请，但真实申请窗口字段尚未完成映射，已停止自动点击以避免误提交",
        "RECLOUD_WARRANTY_CONVERSION_FORM_NOT_MAPPED",
        "WARRANTY_CONVERSION"
      );
    },

    async addParts(additions) {
      await openServiceReport(page);
      for (const part of additions) {
        const dialog = await openRepairPartAddDialog(page, { timeoutMs: 7000 });
        const productInput = await locateDialogInput(dialog, "服务单产品明细");
        const partInput = await locateDialogInput(dialog, "新件名称");
        const quantityInput = await locateDialogInput(dialog, "数量");
        if (!productInput || !partInput || !quantityInput) {
          throw adapterError("配件窗口必填控件发生变化", "RECLOUD_REPAIR_PART_FORM_CHANGED", "PARTS");
        }
        await selectFirstRequiredOption(page, productInput);
        await partInput.fill(part.partCode);
        await page.waitForTimeout?.(500);
        await partInput.press("ArrowDown");
        await partInput.press("Enter");
        await page.waitForTimeout?.(500);
        await quantityInput.fill(String(part.quantity));
        const save = await uniqueVisible(
          dialog.getByRole("button", { name: exactText("保存") }).filter({ visible: true }),
          "配件窗口保存按钮不唯一",
          "RECLOUD_REPAIR_PART_SAVE_AMBIGUOUS",
          "PARTS"
        );
        await save.click({ timeout: 5000 });
        await dialog.waitFor({ state: "hidden", timeout: 10000 });
        await page.waitForTimeout?.(500);
      }
    },
  };
}

module.exports = { createRecloudRepairPageAdapter };
