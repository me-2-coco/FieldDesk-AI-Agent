const { inspectCurrentAssignee, locateUniqueTargetTechnicianRow } = require("./recloud-repair-execution-inspector");
const { openRepairPartAddDialog } = require("./recloud-repair-part-dialog");
const { readExistingRepairParts } = require("./recloud-repair-parts-reader");
const { readExistingRepairAttachments } = require("./recloud-repair-attachments-reader");
const path = require("path");
const crypto = require("crypto");

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

async function readApprovalFlow(dialog, flowInput) {
  const selectedValues = await dialog.locator([
    ".rt-picklist__tags .rt-tag-text:visible",
    ".rtxpc-select__tags .rt-tag-text:visible",
    ".el-select__tags .el-tag__content:visible",
    ".rt-select__selected-value:visible",
    ".el-select__selected-item:visible",
  ].join(", ")).allInnerTexts().catch(() => []);
  const uniqueValues = [...new Set(selectedValues.map((value) => String(value || "").replace(/\s+/g, " ").trim()).filter(Boolean))];
  if (uniqueValues.length > 1) {
    throw adapterError("瑞云签核流程存在多个已选值", "RECLOUD_REPAIR_APPROVAL_FLOW_AMBIGUOUS", "SUBMIT");
  }
  if (uniqueValues.length === 1) return uniqueValues[0];
  return String(await flowInput.inputValue().catch(() => "")).replace(/\s+/g, " ").trim();
}

async function clickApprovalFlowInput(flowInput) {
  try {
    await flowInput.click({ timeout: 3000 });
  } catch (error) {
    if (!String(error?.message || error).includes("intercepts pointer events")) throw error;
    await flowInput.click({ timeout: 3000, force: true });
  }
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

async function locateFormItemByText(scope, labelText) {
  const labels = scope
    .locator("label:visible, .rt-form-item__label:visible, .el-form-item__label:visible")
    .filter({ hasText: exactText(labelText) });
  if (await labels.count() !== 1) return null;
  const item = labels.first().locator("xpath=ancestor::*[contains(@class,'form-item')][1]");
  return await item.count() === 1 ? item.first() : null;
}

async function selectPicklistValue(page, item, value) {
  const input = item?.locator("input:visible").first();
  if (!input || await input.count() !== 1) {
    throw adapterError("瑞云下拉框结构发生变化", "RECLOUD_REPAIR_PICKLIST_CHANGED", "FIELDS");
  }
  await input.click({ timeout: 3000 });
  await page.waitForTimeout?.(150);
  const option = page.locator(".rtxpc-select-dropdown__item:visible, .el-select-dropdown__item:visible")
    .filter({ hasText: exactText(value) });
  const target = await uniqueVisible(option, `瑞云下拉框缺少“${value}”`, "RECLOUD_REPAIR_PICKLIST_OPTION_AMBIGUOUS", "FIELDS");
  await target.click({ timeout: 3000 });
}

function attachmentPath(rmaNo, fileName) {
  const digest = crypto.createHash("sha256").update(String(rmaNo || "").trim()).digest("hex");
  return path.join(__dirname, "..", "database", "uploads", "repairs", digest, path.basename(fileName));
}

function enrichExpectedAttachmentMetadata(attachments, expectedAttachments) {
  const expected = new Map((expectedAttachments || []).map((item) => [
    String(item.fileName || item.name || "").toLowerCase(),
    item,
  ]));
  return (attachments || []).map((item) => {
    const local = expected.get(String(item.fileName || "").toLowerCase());
    return local
      ? { ...item, size: Number(local.size || item.size), mimeType: local.mimeType || item.mimeType }
      : item;
  });
}

function createRecloudRepairPageAdapter(page, context = {}) {
  return {
    async readAssignee() {
      const assignee = await inspectCurrentAssignee(page);
      return assignee.currentAssignee;
    },

    async readRemoteState() {
      console.info("RECLOUD_REPAIR_REMOTE_READ: body_start");
      const bodyText = String(await page.locator("body").innerText().catch(() => ""));
      if (context.rmaNo && !bodyText.includes(String(context.rmaNo))) {
        throw adapterError("当前瑞云页面不是待同步的维修单", "RECLOUD_REPAIR_ORDER_MISMATCH", "PAGE");
      }
      console.info("RECLOUD_REPAIR_REMOTE_READ: assignee_start");
      const assignee = await inspectCurrentAssignee(page);
      console.info("RECLOUD_REPAIR_REMOTE_READ: assignee_ready");
      console.info("RECLOUD_REPAIR_REMOTE_READ: report_start");
      await openServiceReport(page);
      console.info("RECLOUD_REPAIR_REMOTE_READ: report_ready");
      let parts = [];
      try {
        console.info("RECLOUD_REPAIR_REMOTE_READ: parts_start");
        parts = await readExistingRepairParts(page);
        console.info("RECLOUD_REPAIR_REMOTE_READ: parts_ready");
      } catch (error) {
        if (error.code !== "RECLOUD_REPAIR_PARTS_TABLE_NOT_FOUND") throw error;
      }
      console.info("RECLOUD_REPAIR_REMOTE_READ: attachments_start");
      const attachments = await readExistingRepairAttachments(page).catch(() => []);
      console.info("RECLOUD_REPAIR_REMOTE_READ: attachments_ready");
      return {
        assignee: assignee.currentAssignee,
        parts,
        attachments: enrichExpectedAttachmentMetadata(attachments, context.payload?.attachments),
      };
    },

    async readRemoteAttachments() {
      await openServiceReport(page);
      const attachments = await readExistingRepairAttachments(page).catch(() => []);
      return enrichExpectedAttachmentMetadata(attachments, context.payload?.attachments);
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
      const searchButtons = dialog.getByRole("button", { name: exactText("搜索") }).filter({ visible: true });
      if (await searchButtons.count() === 1) await searchButtons.first().click({ timeout: 5000 });
      else await input.press("Enter");
      await page.waitForTimeout?.(500);
      const rows = await locateUniqueTargetTechnicianRow(dialog, plan.servicePerson);
      if (rows.length !== 1) {
        throw adapterError(`瑞云中没有唯一匹配的师傅：${plan.servicePerson}`, "RECLOUD_ASSIGNMENT_TARGET_NOT_UNIQUE", "ASSIGNMENT");
      }
      let responsibleCandidates = rows[0]
        .getByRole("button", { name: exactText("负责人") })
        .filter({ visible: true });
      if (await responsibleCandidates.count() === 0) {
        responsibleCandidates = rows[0]
          .locator(".common-span:visible")
          .filter({ hasText: exactText("负责人") });
      }
      const responsible = await uniqueVisible(
        responsibleCandidates,
        "目标师傅行缺少负责人按钮",
        "RECLOUD_ASSIGNMENT_RESPONSIBLE_NOT_FOUND",
        "ASSIGNMENT"
      );
      await responsible.click({ timeout: 5000 });
      await page.waitForTimeout?.(200);
      if (await dialog.isVisible().catch(() => false)) {
        const confirms = dialog.getByRole("button", { name: exactText("确定") }).filter({ visible: true });
        const confirm = await uniqueVisible(
          confirms,
          "改派窗口确定按钮不唯一",
          "RECLOUD_ASSIGNMENT_CONFIRM_AMBIGUOUS",
          "ASSIGNMENT"
        );
        await confirm.click({ timeout: 5000 });
      }
      await dialog.waitFor({ state: "hidden", timeout: 8000 });
      await page.waitForTimeout?.(500);
    },

    async confirmWarrantyConversion(options = {}) {
      const productTab = await uniqueVisible(
        page.getByText("产品信息", { exact: true }).filter({ visible: true }),
        "无法唯一定位产品信息页签",
        "RECLOUD_PRODUCT_TAB_AMBIGUOUS",
        "WARRANTY_CONVERSION"
      );
      await productTab.click({ timeout: 5000 });
      await page.waitForTimeout?.(350);
      const serialNumber = String(context.sn || "").trim().toUpperCase();
      if (!serialNumber) {
        throw adapterError("缺少当前产品 SN，不能安全操作保外转保内", "RECLOUD_WARRANTY_CONVERSION_SN_REQUIRED", "WARRANTY_CONVERSION");
      }
      const serialNumberCell = page.getByText(serialNumber, { exact: true }).filter({ visible: true });
      const productRows = page
        .getByRole("row")
        .filter({ has: serialNumberCell })
        .filter({ visible: true });
      const productRow = await uniqueVisible(
        productRows,
        "无法按 SN 唯一定位瑞云产品行",
        "RECLOUD_WARRANTY_CONVERSION_PRODUCT_AMBIGUOUS",
        "WARRANTY_CONVERSION"
      );
      // 瑞云表格会把“操作”列复制到 fixed-right 浮层。主体行中的按钮虽然
      // 可见，但会被浮层副本挡住；应优先点击真正位于 fixed-right 中的按钮。
      // 仍然先用 SN 锁定唯一产品行，避免误操作同单的其他产品。
      const rowButton = await uniqueVisible(
        productRow.getByRole("button", { name: exactText("保外转保内") }).filter({ visible: true }),
        "当前产品行缺少保外转保内按钮",
        "RECLOUD_WARRANTY_CONVERSION_BUTTON_AMBIGUOUS",
        "WARRANTY_CONVERSION"
      );
      const fixedButtons = page
        .locator(".rtxpc-table__fixed-right:visible, .el-table__fixed-right:visible")
        .getByRole("button", { name: exactText("保外转保内") })
        .filter({ visible: true });
      const button = await fixedButtons.count() === 1 ? fixedButtons.first() : rowButton;
      await button.click({ timeout: 5000 });
      const dialog = page.getByRole("dialog", { name: exactText("保外转保内确认") }).filter({ visible: true });
      const confirmation = await uniqueVisible(
        dialog,
        "保外转保内确认窗口不唯一",
        "RECLOUD_WARRANTY_CONVERSION_DIALOG_AMBIGUOUS",
        "WARRANTY_CONVERSION"
      );
      const choice = options.requested === true ? "是" : "否";
      const choiceButton = await uniqueVisible(
        confirmation.getByRole("button", { name: exactText(choice) }).filter({ visible: true }),
        `保外转保内确认窗口缺少“${choice}”按钮`,
        "RECLOUD_WARRANTY_CONVERSION_CHOICE_AMBIGUOUS",
        "WARRANTY_CONVERSION"
      );
      await choiceButton.click({ timeout: 5000 });
      await confirmation.waitFor({ state: "hidden", timeout: 8000 });
      await page.waitForTimeout?.(300);
      return { confirmed: true, choice, requested: options.requested === true };
    },

    async addParts(additions) {
      await openServiceReport(page);
      const missingParts = [];
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
        await page.waitForTimeout?.(400);
        const immediateMessages = await page
          .locator(".el-message:visible, .el-notification:visible, [role='alert']:visible")
          .allInnerTexts()
          .catch(() => []);
        const immediateMessage = immediateMessages
          .map((item) => String(item || "").replace(/\s+/g, " ").trim())
          .filter(Boolean)
          .join("；");
        if (/(?:库存|可用数量|可用库存).*(?:不足|为\s*0|没有|无)|(?:无库存|缺货|库存不足)/.test(immediateMessage)) {
          missingParts.push({
            partCode: String(part.partCode || "").trim(),
            partName: String(part.partName || "").trim(),
            quantity: Number(part.quantity || 0),
            reason: immediateMessage || "瑞云库存不足",
          });
          if (await dialog.isVisible().catch(() => false)) {
            const close = dialog.locator(".el-dialog__headerbtn:visible, button[aria-label='Close']:visible");
            if (await close.count() === 1) await close.first().click({ timeout: 3000 });
            else await page.keyboard.press("Escape");
            await dialog.waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
          }
          continue;
        }
        try {
          await dialog.waitFor({ state: "hidden", timeout: 10000 });
        } catch (error) {
          // 瑞云的配件关系窗口在部分环境中“保存”后不会自动关闭。
          // 先检查明确的表单错误；没有错误时只关闭窗口，随后由编排器
          // 重新读取服务报告中的配件明细决定是否真的保存成功。
          const validationText = await dialog
            .locator(".el-form-item__error:visible, [role='alert']:visible")
            .allInnerTexts()
            .catch(() => []);
          const validationMessage = validationText
            .map((item) => String(item || "").replace(/\s+/g, " ").trim())
            .filter(Boolean)
            .join("；");
          if (/(?:库存|可用数量|可用库存).*(?:不足|为\s*0|没有|无)|(?:无库存|缺货|库存不足)/.test(validationMessage)) {
            missingParts.push({
              partCode: String(part.partCode || "").trim(),
              partName: String(part.partName || "").trim(),
              quantity: Number(part.quantity || 0),
              reason: validationMessage || "瑞云库存不足",
            });
            const close = dialog.locator(".el-dialog__headerbtn:visible, button[aria-label='Close']:visible");
            if (await close.count() === 1) await close.first().click({ timeout: 3000 });
            else await page.keyboard.press("Escape");
            await dialog.waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
            continue;
          }
          if (validationMessage) {
            throw adapterError(
              `瑞云配件保存校验失败：${validationMessage}`,
              "RECLOUD_REPAIR_PART_SAVE_VALIDATION_FAILED",
              "PARTS"
            );
          }
          const close = dialog.locator(".el-dialog__headerbtn:visible, button[aria-label='Close']:visible");
          if (await close.count() === 1) await close.first().click({ timeout: 3000 });
          else await page.keyboard.press("Escape");
          try {
            await dialog.waitFor({ state: "hidden", timeout: 5000 });
          } catch (closeError) {
            // 仅记录当前可见弹窗的文字，便于识别瑞云新增的二次确认；
            // 不在这里继续点击任何未知按钮。
            const visibleDialogText = await page
              .locator("[role='dialog']:visible, .el-dialog:visible, .ant-modal:visible")
              .allInnerTexts()
              .catch(() => []);
            const summary = visibleDialogText
              .map((item) => String(item || "").replace(/\s+/g, " ").trim())
              .filter(Boolean)
              .join(" | ")
              .slice(0, 1000);
            throw adapterError(
              `瑞云配件 ${part.partCode} 保存后窗口未关闭，无法安全复核结果${summary ? `：${summary}` : ""}`,
              "RECLOUD_REPAIR_PART_SAVE_RESULT_UNKNOWN",
              "PARTS"
            );
          }
        }
        await page.waitForTimeout?.(500);
      }
      return { missingParts };
    },

    async applyRepairFields(plan) {
      await openServiceReport(page);
      const serialNumber = String(context.sn || "").trim().toUpperCase();
      const fault = context.payload || {};
      const value = String(plan.safeWrites.find((item) => item.key === "repairMeasure")?.value || "").trim();
      const alreadyAppliedRows = page.getByRole("row")
        .filter({ hasText: serialNumber })
        .filter({ hasText: value })
        .filter({ visible: true });
      if (
        await alreadyAppliedRows.count() === 1
        && /(?:^|\s)否(?:\s|$)/.test(String(await alreadyAppliedRows.first().innerText()))
      ) {
        return { alreadyApplied: true };
      }
      const rows = page.getByRole("row")
        // 瑞云“产品明细”单元格显示为“型号_SN”，不能用整格等于 SN。
        .filter({ hasText: serialNumber })
        .filter({ has: page.getByText(String(fault.faultLevel1 || ""), { exact: true }) })
        .filter({ visible: true });
      const row = await uniqueVisible(rows, "无法唯一定位瑞云故障记录", "RECLOUD_REPAIR_FAULT_ROW_AMBIGUOUS", "FIELDS");
      await row.dblclick({ timeout: 5000 });
      const dialog = await uniqueVisible(
        page.getByRole("dialog")
          .filter({ has: page.getByText("故障模式及责任判定", { exact: true }) })
          .filter({ visible: true }),
        "维修措施编辑窗口不唯一",
        "RECLOUD_REPAIR_MEASURE_DIALOG_AMBIGUOUS",
        "FIELDS"
      );
      const troubleshooting = await locateFormItemByText(dialog, "是否是排障问题");
      if (!troubleshooting) throw adapterError("缺少是否是排障问题", "RECLOUD_REPAIR_TROUBLESHOOTING_NOT_FOUND", "FIELDS");
      await selectPicklistValue(page, troubleshooting, "否");
      const measure = dialog.getByRole("textbox", { name: exactText("维修措施") }).filter({ visible: true });
      const measureInput = await uniqueVisible(measure, "维修措施输入框不唯一", "RECLOUD_REPAIR_MEASURE_CONTROL_AMBIGUOUS", "FIELDS");
      await measureInput.fill(value);
      const save = await uniqueVisible(dialog.getByRole("button", { name: exactText("保存") }).filter({ visible: true }), "维修措施保存按钮不唯一", "RECLOUD_REPAIR_MEASURE_SAVE_AMBIGUOUS", "FIELDS");
      await save.click({ timeout: 5000 });
      await dialog.waitFor({ state: "hidden", timeout: 10000 });
    },

    async verifyRepairFields(plan) {
      await openServiceReport(page);
      const expected = String(plan.safeWrites.find((item) => item.key === "repairMeasure")?.value || "").trim();
      const rows = page.getByRole("row")
        .filter({ hasText: String(context.sn || "").trim().toUpperCase() })
        .filter({ hasText: expected })
        .filter({ visible: true });
      if (await rows.count() !== 1) return false;
      return /(?:^|\s)否(?:\s|$)/.test(String(await rows.first().innerText()));
    },

    async uploadAttachments(plan) {
      await openServiceReport(page);
      if (!plan.additions.length) return { uploadedCount: 0 };
      const headings = page.getByText("附件", { exact: true }).filter({ visible: true });
      const heading = await uniqueVisible(headings, "瑞云主附件区域不唯一", "RECLOUD_REPAIR_ATTACHMENT_SECTION_AMBIGUOUS", "ATTACHMENTS");
      const panel = heading.locator("xpath=ancestor::*[.//button[normalize-space(.)='上传附件']][1]");
      if (await panel.count() !== 1) throw adapterError("无法定位瑞云主附件上传按钮", "RECLOUD_REPAIR_ATTACHMENT_UPLOAD_NOT_FOUND", "ATTACHMENTS");
      const uploadEntry = await uniqueVisible(panel.getByRole("button", { name: exactText("上传附件") }).filter({ visible: true }), "瑞云主附件上传按钮不唯一", "RECLOUD_REPAIR_ATTACHMENT_UPLOAD_AMBIGUOUS", "ATTACHMENTS");
      await uploadEntry.click({ timeout: 5000 });
      const dialog = await uniqueVisible(
        page.getByRole("dialog").filter({ has: page.getByText("上传附件", { exact: true }) }).filter({ visible: true }),
        "附件上传窗口不唯一",
        "RECLOUD_REPAIR_ATTACHMENT_DIALOG_AMBIGUOUS",
        "ATTACHMENTS"
      );
      const fileInput = dialog.locator("input[type='file']");
      if (await fileInput.count() !== 1) throw adapterError("附件文件选择框不唯一", "RECLOUD_REPAIR_ATTACHMENT_INPUT_AMBIGUOUS", "ATTACHMENTS");
      await fileInput.setInputFiles(plan.additions.map((item) => attachmentPath(context.rmaNo, item.fileName)));
      const upload = await uniqueVisible(dialog.getByRole("button", { name: /^\s*上\s*传\s*$/ }).filter({ visible: true }), "附件上传确认按钮不唯一", "RECLOUD_REPAIR_ATTACHMENT_CONFIRM_AMBIGUOUS", "ATTACHMENTS");
      await upload.click({ timeout: 5000 });
      await dialog.waitFor({ state: "hidden", timeout: 30000 });
      await page.waitForTimeout?.(500);
      return { uploadedCount: plan.additions.length };
    },

    async clickComplete() {
      const submitReady = page.getByRole("button", { name: exactText("提交") }).filter({ visible: true });
      if (await submitReady.count() === 1) return { alreadyComplete: true };
      const button = await uniqueVisible(page.getByRole("button", { name: exactText("完工") }).filter({ visible: true }), "瑞云完工按钮不唯一", "RECLOUD_REPAIR_COMPLETE_AMBIGUOUS", "COMPLETE");
      await button.click({ timeout: 5000 });
      const dialogs = page.locator("[role='dialog']:visible, .el-dialog:visible, .ant-modal:visible");
      const deadline = Date.now() + 7000;
      while (Date.now() < deadline && await dialogs.count() === 0 && await submitReady.count() === 0) {
        await page.waitForTimeout?.(200);
      }
      if (await submitReady.count() === 1) return { directSubmitReady: true };
      const dialog = await uniqueVisible(dialogs, "瑞云完工确认窗口不唯一", "RECLOUD_REPAIR_COMPLETE_DIALOG_AMBIGUOUS", "COMPLETE");
      const dialogText = String(await dialog.innerText());
      if (!dialogText.includes("是否进行总部完工")) {
        throw adapterError(
          `瑞云完工确认内容发生变化：${dialogText.replace(/\s+/g, " ").trim().slice(0, 500)}`,
          "RECLOUD_REPAIR_COMPLETE_DIALOG_CHANGED",
          "COMPLETE"
        );
      }
      await dialog.getByRole("button", { name: exactText("确定") }).click({ timeout: 5000 });
    },

    async waitForSubmitReady(options = {}) {
      const deadline = Date.now() + Number(options.timeoutMs || 30000);
      while (Date.now() < deadline) {
        if (await page.getByRole("button", { name: exactText("提交") }).filter({ visible: true }).count() === 1) return true;
        await page.waitForTimeout?.(Number(options.pollIntervalMs || 500));
      }
      return false;
    },

    async printOldPartLabels() {
      // 标签打印是线下打印动作，不影响瑞云完工数据；由网点按需打印。
      return { deferredToOutlet: true };
    },

    async clickSubmit(options = {}) {
      if (options.stopImmediately !== true) throw adapterError("最终提交必须设置立即停止", "RECLOUD_REPAIR_SUBMIT_POLICY_INVALID", "SUBMIT");
      const button = await uniqueVisible(page.getByRole("button", { name: exactText("提交") }).filter({ visible: true }), "瑞云提交按钮不唯一", "RECLOUD_REPAIR_SUBMIT_AMBIGUOUS", "SUBMIT");
      await button.click({ timeout: 5000 });
      const dialog = await uniqueVisible(page.getByRole("dialog", { name: exactText("签核流程") }).filter({ visible: true }), "瑞云签核流程窗口不唯一", "RECLOUD_REPAIR_APPROVAL_DIALOG_AMBIGUOUS", "SUBMIT");
      const expectedFlow = String(options.approvalFlow || "").trim();
      const flowInput = await uniqueVisible(
        dialog.locator("input:visible"),
        "瑞云签核流程选择框不唯一",
        "RECLOUD_REPAIR_APPROVAL_FLOW_CONTROL_AMBIGUOUS",
        "SUBMIT"
      );
      let selectedFlow = await readApprovalFlow(dialog, flowInput);
      if (selectedFlow !== expectedFlow) {
        await clickApprovalFlowInput(flowInput);
        await page.waitForTimeout?.(300);
        const flowOption = await uniqueVisible(
          page.locator(".el-select-dropdown__item:visible, .rtxpc-select-dropdown__item:visible, [role='option']:visible")
            .filter({ hasText: exactText(expectedFlow) }),
          "瑞云签核流程选项不唯一",
          "RECLOUD_REPAIR_APPROVAL_FLOW_OPTION_AMBIGUOUS",
          "SUBMIT"
        );
        await flowOption.click({ timeout: 3000 });
        selectedFlow = await readApprovalFlow(dialog, flowInput);
      }
      if (selectedFlow !== expectedFlow) {
        throw adapterError("瑞云签核流程不是预期流程", "RECLOUD_REPAIR_APPROVAL_FLOW_MISMATCH", "SUBMIT");
      }
      const submit = await uniqueVisible(dialog.getByRole("button", { name: exactText("提交") }).filter({ visible: true }), "签核流程提交按钮不唯一", "RECLOUD_REPAIR_APPROVAL_SUBMIT_AMBIGUOUS", "SUBMIT");
      if (!await submit.isEnabled()) throw adapterError("签核流程提交按钮不可用", "RECLOUD_REPAIR_APPROVAL_SUBMIT_DISABLED", "SUBMIT");
      await submit.click({ timeout: 5000 });
    },
  };
}

module.exports = { clickApprovalFlowInput, createRecloudRepairPageAdapter, readApprovalFlow };
