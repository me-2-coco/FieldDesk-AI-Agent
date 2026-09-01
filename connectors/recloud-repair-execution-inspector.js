const { RECLOUD_WORK_ORDER_OPERATION_POLICY } = require("../services/recloud-work-order-operation-policy");
const { assessRecloudRepairExecutionReadiness } = require("../services/recloud-repair-execution-readiness");
const { openRepairPartAddDialog } = require("./recloud-repair-part-dialog");

function inspectionError(message, code, missingFields = []) {
  const error = new Error(message);
  error.code = code;
  error.status = 502;
  error.missingFields = missingFields;
  return error;
}

function exactText(value) {
  return new RegExp(`^\\s*${String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`);
}

async function locateInputByLabel(scope, labelText) {
  const labels = scope
    .locator("label:visible, .rt-form-item__label:visible, .el-form-item__label:visible")
    .filter({ hasText: exactText(labelText) });
  if (await labels.count() !== 1) return { labelCount: await labels.count(), inputCount: 0, input: null };
  const item = labels.first().locator(
    "xpath=ancestor::*[contains(@class,'form-item') or contains(@class,'form_item')][1]"
  );
  if (await item.count() !== 1) return { labelCount: 1, inputCount: 0, input: null };
  const inputs = item.first().locator("input:visible, textarea:visible");
  const inputCount = await inputs.count();
  return { labelCount: 1, inputCount, input: inputCount === 1 ? inputs.first() : null };
}

async function inspectCurrentAssignee(page) {
  const labels = page
    .locator("label:visible, .rt-form-item__label:visible, .el-form-item__label:visible")
    .filter({ hasText: exactText("负责人") });
  const labelCount = await labels.count();
  if (labelCount !== 1) return { currentAssigneeCount: labelCount, currentAssignee: "" };
  const item = labels.first().locator(
    "xpath=ancestor::*[contains(@class,'form-item') or contains(@class,'form_item')][1]"
  );
  if (await item.count() !== 1) return { currentAssigneeCount: 0, currentAssignee: "" };
  const controls = item.first().locator("input:visible, textarea:visible");
  if (await controls.count() === 1) {
    return {
      currentAssigneeCount: 1,
      currentAssignee: String(await controls.first().inputValue().catch(() => "")).trim(),
    };
  }
  const text = String(await item.first().innerText().catch(() => ""))
    .replace(/^\s*负责人\s*/, "")
    .trim();
  return { currentAssigneeCount: text ? 1 : 0, currentAssignee: text };
}

async function locateUniqueTargetTechnicianRow(dialog, targetAssignee) {
  const exactName = dialog.getByText(exactText(targetAssignee)).filter({ visible: true });
  const rows = [];
  for (let index = 0; index < await exactName.count(); index += 1) {
    const row = exactName.nth(index).locator("xpath=ancestor::tr[1]");
    if (await row.count() === 1 && await row.isVisible().catch(() => false)) rows.push(row.first());
  }
  return rows;
}

async function inspectAssignmentDialog(page, targetAssignee, options = {}) {
  const reassignButtons = page.getByRole("button", { name: exactText("改派") }).filter({ visible: true });
  const reassignButtonCount = await reassignButtons.count();
  if (reassignButtonCount !== 1 || options.openAssignmentDialog !== true) {
    return {
      reassignButtonCount,
      targetTechnicianRowCount: 0,
      responsibleActionCount: 0,
      assistActionCount: 0,
      responsibleActionText: "",
      assistActionText: "",
      dialogClosed: true,
    };
  }

  const dialogs = page.locator("[role='dialog']:visible, .el-dialog:visible, .rtxpc-dialog:visible");
  const countBefore = await dialogs.count();
  await reassignButtons.first().click();
  if (typeof options.assertSafe === "function") await options.assertSafe();
  const deadline = Date.now() + Number(options.timeoutMs || 5000);
  while (Date.now() < deadline && await dialogs.count() <= countBefore) await page.waitForTimeout?.(100);
  if (await dialogs.count() <= countBefore) {
    throw inspectionError("点击改派后没有出现改派窗口", "RECLOUD_ASSIGNMENT_DIALOG_NOT_FOUND", ["repair.execution.assignmentDialog"]);
  }

  const dialog = dialogs.last();
  let result;
  try {
    const servicePerson = await locateInputByLabel(dialog, "服务人员");
    const servicePersonInputCount = servicePerson.inputCount;
    if (servicePerson.input) {
      await servicePerson.input.fill(String(targetAssignee || "").trim());
      await servicePerson.input.press("Enter");
      await page.waitForTimeout?.(300);
      if (typeof options.assertSafe === "function") await options.assertSafe();
    }
    const rows = await locateUniqueTargetTechnicianRow(dialog, targetAssignee);
    const row = rows.length === 1 ? rows[0] : null;
    const responsible = row ? row.getByRole("button", { name: exactText("负责人") }).filter({ visible: true }) : null;
    const assist = row ? row.getByRole("button", { name: exactText("协助") }).filter({ visible: true }) : null;
    result = {
      reassignButtonCount,
      servicePersonInputCount,
      targetTechnicianRowCount: rows.length,
      responsibleActionCount: responsible ? await responsible.count() : 0,
      assistActionCount: assist ? await assist.count() : 0,
      responsibleActionText: responsible && await responsible.count() === 1 ? "负责人" : "",
      assistActionText: assist && await assist.count() === 1 ? "协助" : "",
    };
  } finally {
    const close = dialog.locator(
      "button[aria-label*='关闭']:visible, button[title*='关闭']:visible, .el-dialog__headerbtn:visible, .rt-dialog__close:visible"
    ).last();
    if (await close.count()) await close.click({ timeout: 3000 }).catch(() => {});
    if (await dialog.isVisible().catch(() => false)) await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout?.(100);
    if (typeof options.assertSafe === "function") await options.assertSafe();
  }
  return { ...result, dialogClosed: !await dialog.isVisible().catch(() => false) };
}

async function inspectPartAddDialog(page, options = {}) {
  if (options.inspectPartAddDialog !== true) {
    return { partAddButtonCount: 0, directPartCodeInputCount: 0, partDialogClosed: true };
  }
  let dialog = null;
  let result = { partAddButtonCount: 0, directPartCodeInputCount: 0, partDialogClosed: false };
  try {
    dialog = await openRepairPartAddDialog(page, {
      assertSafe: options.assertSafe,
      timeoutMs: options.timeoutMs,
    });
    const newPartName = await locateInputByLabel(dialog, "新件名称");
    result = {
      partAddButtonCount: 1,
      directPartCodeInputCount: newPartName.inputCount,
      partDialogClosed: false,
    };
  } finally {
    if (dialog) {
      const close = dialog.locator(
        "button[aria-label*='关闭']:visible, button[title*='关闭']:visible, .el-dialog__headerbtn:visible, .rt-dialog__close:visible"
      ).last();
      if (await close.count()) await close.click({ timeout: 3000 }).catch(() => {});
      if (await dialog.isVisible().catch(() => false)) await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout?.(100);
      if (typeof options.assertSafe === "function") await options.assertSafe();
    }
  }
  return {
    ...result,
    partDialogClosed: dialog ? !await dialog.isVisible().catch(() => false) : true,
  };
}

async function inspectMainAttachmentUpload(page) {
  const headings = page.getByText("附件", { exact: true }).filter({ visible: true });
  const headingCount = await headings.count();
  if (headingCount !== 1) return { mainAttachmentHeadingCount: headingCount, mainAttachmentUploadCount: 0 };
  const panel = headings.first().locator(
    "xpath=ancestor::*[.//button[normalize-space(.)='上传附件']][1]"
  );
  if (await panel.count() !== 1) return { mainAttachmentHeadingCount: 1, mainAttachmentUploadCount: 0 };
  return {
    mainAttachmentHeadingCount: 1,
    mainAttachmentUploadCount: await panel.first().getByRole("button", { name: exactText("上传附件") }).filter({ visible: true }).count(),
  };
}

async function inspectRepairExecutionControls(page, targetAssignee, options = {}) {
  if (options.dryRun !== true || options.writeEnabled !== false) {
    throw inspectionError("维修执行控件体检只允许严格只读模式", "RECLOUD_REPAIR_EXECUTION_INSPECTION_UNSAFE");
  }
  const assignee = await inspectCurrentAssignee(page);
  const assignment = await inspectAssignmentDialog(page, targetAssignee, options);
  const partDialog = await inspectPartAddDialog(page, options);
  const mainAttachment = await inspectMainAttachmentUpload(page);
  const partHeadings = page.getByText("服务单更换件明细", { exact: true }).filter({ visible: true });
  const reportAttachmentHeadings = page.getByText("附件（检测报告）", { exact: true }).filter({ visible: true });
  const completeButtons = page.getByRole("button", { name: exactText("完工") }).filter({ visible: true });
  const submitButtons = page.getByRole("button", { name: exactText("提交") }).filter({ visible: true });
  const inspection = {
    ...assignee,
    ...assignment,
    ...partDialog,
    ...mainAttachment,
    partHeadingCount: await partHeadings.count(),
    partEntryMode: RECLOUD_WORK_ORDER_OPERATION_POLICY.partEntryMode,
    partEntryTarget: RECLOUD_WORK_ORDER_OPERATION_POLICY.partEntryTarget,
    reportAttachmentHeadingCount: await reportAttachmentHeadings.count(),
    attachmentTarget: RECLOUD_WORK_ORDER_OPERATION_POLICY.attachmentTarget,
    forbiddenAttachmentTarget: RECLOUD_WORK_ORDER_OPERATION_POLICY.forbiddenAttachmentTarget,
    completeButtonCount: await completeButtons.count(),
    submitButtonCount: await submitButtons.count(),
    excludedTargets: [...RECLOUD_WORK_ORDER_OPERATION_POLICY.excludedTargets],
    mutationRequestDetected: options.guardState?.mutationRequestDetected === true,
    blockedRequestCount: Number(options.guardState?.blockedRequestCount || 0),
    writeEnabled: false,
    recloudModified: false,
  };
  return { inspection, readiness: assessRecloudRepairExecutionReadiness(inspection) };
}

module.exports = {
  exactText,
  inspectCurrentAssignee,
  locateUniqueTargetTechnicianRow,
  inspectAssignmentDialog,
  inspectPartAddDialog,
  inspectMainAttachmentUpload,
  inspectRepairExecutionControls,
};
