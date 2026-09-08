const { inspectCurrentAssignee, locateUniqueTargetTechnicianRow } = require("./recloud-repair-execution-inspector");
const { openRepairPartAddDialog } = require("./recloud-repair-part-dialog");
const { readExistingRepairParts } = require("./recloud-repair-parts-reader");
const { readExistingRepairAttachments } = require("./recloud-repair-attachments-reader");
const { createRecloudRepairControlAdapter, normalizeRepairControlValue } = require("./recloud-repair-control-adapter");
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

async function clickAfterLoadingSettles(page, button, options = {}) {
  const deadline = Date.now() + Number(options.timeoutMs || 30_000);
  const successCheck = typeof options.successCheck === "function" ? options.successCheck : null;
  const loadingMasks = page.locator([
    ".rt-loading-mask:visible",
    ".el-loading-mask:visible",
    ".ant-spin-spinning:visible",
  ].join(", "));
  let lastError = null;
  while (Date.now() < deadline) {
    // 瑞云有时已经接收点击，但 Playwright 仍会因为随后出现的 loading
    // 遮罩把本次 click 判成超时。优先核验业务终态，避免把成功操作整轮重试。
    if (successCheck && await successCheck().catch(() => false)) {
      return { clicked: false, alreadySucceeded: true };
    }
    if (await loadingMasks.count() > 0) {
      await page.waitForTimeout?.(Number(options.pollIntervalMs || 250));
      continue;
    }
    try {
      await button.click({ timeout: Math.min(5000, Math.max(500, deadline - Date.now())) });
      return { clicked: true, alreadySucceeded: false };
    } catch (error) {
      lastError = error;
      if (successCheck && await successCheck().catch(() => false)) {
        return { clicked: false, alreadySucceeded: true };
      }
      if (!String(error?.message || error).includes("intercepts pointer events")) throw error;
      await page.waitForTimeout?.(Number(options.pollIntervalMs || 250));
    }
  }
  if (successCheck && await successCheck().catch(() => false)) {
    return { clicked: false, alreadySucceeded: true };
  }
  throw adapterError(
    `瑞云加载遮罩长时间未释放：${String(lastError?.message || "").slice(0, 300)}`,
    "RECLOUD_REPAIR_LOADING_MASK_TIMEOUT",
    "SUBMIT"
  );
}

async function waitForRepairSubmissionConfirmed(page, options = {}) {
  const deadline = Date.now() + Number(options.timeoutMs || 15_000);
  const pollIntervalMs = Number(options.pollIntervalMs || 200);
  while (Date.now() < deadline) {
    if (await isRecloudRepairFullySubmitted(page)) return true;
    await page.waitForTimeout?.(pollIntervalMs);
  }
  return isRecloudRepairFullySubmitted(page);
}

async function openServiceReport(page, timeoutMs = 15000) {
  await dismissBlockingRepairMessageBoxes(page, { settleMs: 0 });
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
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      // Model-specific notices can be mounted after the service-order page has
      // already rendered. Clear them immediately before each tab-click retry.
      await dismissBlockingRepairMessageBoxes(page, { settleMs: 0 });
      try {
        await tab.click({ timeout: 5000 });
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (!String(error?.message || error).includes("intercepts pointer events")) throw error;
        await page.waitForTimeout?.(150);
      }
    }
    if (lastError) throw lastError;
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
    if (await dialogs.count() > countBefore) {
      // Keep the locator bound to the dialog that was opened by this action.
      // A model notice may appear immediately afterwards; `last()` would then
      // dynamically switch to that notice and make the assignment flow wait
      // for or validate the wrong window.
      return dialogs.nth(countBefore);
    }
    await page.waitForTimeout?.(100);
  }
  throw adapterError("瑞云操作窗口未打开", "RECLOUD_REPAIR_DIALOG_NOT_FOUND", "PAGE");
}

async function dismissBlockingRepairMessageBoxes(page, options = {}) {
  const selector = ".el-message-box__wrapper:visible, .rt-message-box__wrapper:visible";
  const maxDialogs = Number(options.maxDialogs || 3);
  let dismissed = 0;
  await page.waitForTimeout?.(Number(options.settleMs || 250));
  for (let attempt = 0; attempt < maxDialogs; attempt += 1) {
    const dialogs = page.locator(selector);
    if (await dialogs.count() === 0) break;
    const dialog = dialogs.last();
    const dialogText = String(await dialog.innerText().catch(() => ""))
      .replace(/\s+/g, " ")
      .trim();
    // 部分机型进入服务单时会弹出“特殊服务项目”提示。业务规则要求
    // 只点击右上角叉关闭，不能点击正文中的“确定”或“取消”。
    const closeControls = dialog.locator([
      "button[aria-label='Close']:visible",
      "button[aria-label*='关闭']:visible",
      "button[title*='关闭']:visible",
      ".el-message-box__headerbtn:visible",
      ".rt-message-box__headerbtn:visible",
      ".el-message-box__close:visible",
      ".rt-message-box__close:visible",
    ].join(", "));
    const count = await closeControls.count();
    if (count !== 1) {
      throw adapterError(
        `维修建单后出现提示框，但右上角关闭按钮不唯一（匹配 ${count} 个）：${dialogText.slice(0, 160)}`,
        "RECLOUD_REPAIR_MESSAGE_CLOSE_AMBIGUOUS",
        "ASSIGNMENT"
      );
    }
    try {
      // The close glyph is animated and can continuously fail Playwright's
      // stability check even though it is the only verified close control.
      await closeControls.first().click({
        timeout: Number(options.clickTimeout || 5000),
        force: true,
      });
    } catch (error) {
      // Recloud sometimes removes the notice while the click is in flight.
      // Treat that as success only when the exact notice text is no longer
      // present; otherwise preserve the error and stop safely.
      await page.waitForTimeout?.(150);
      const remainingTexts = await page.locator(selector).allInnerTexts().catch(() => []);
      const originalStillVisible = remainingTexts.some((value) =>
        String(value || "").replace(/\s+/g, " ").trim() === dialogText
      );
      if (originalStillVisible) throw error;
    }
    // `dialogs.last()` is a live locator. Recloud can replace the notice that
    // was just closed with another message box immediately, which makes a
    // `waitFor(hidden)` on that live locator silently retarget the new notice
    // and time out even though the original one did close. Give the UI a short
    // turn to reveal the next notice, then let the loop close it separately.
    await page.waitForTimeout?.(Number(options.afterCloseMs || 250));
    dismissed += 1;
  }
  if (await page.locator(selector).count() > 0) {
    throw adapterError(
      "维修建单后的提示框未能全部关闭，已停止改派",
      "RECLOUD_REPAIR_BLOCKING_MESSAGE_REMAINING",
      "ASSIGNMENT"
    );
  }
  if (dismissed > 0) console.info(`RECLOUD_REPAIR_MESSAGE_BOX: dismissed=${dismissed}`);
  return dismissed;
}

async function selectFirstRequiredOption(page, input) {
  await input.click({ timeout: 3000 });
  await input.press("ArrowDown").catch(() => {});
  await input.press("Enter").catch(() => {});
  await page.waitForTimeout?.(250);
}

const RECLOUD_PART_OPTION_SELECTOR = [
  ".rtxpc-autocomplete-suggestion li:visible",
  ".el-autocomplete-suggestion li:visible",
  ".rtxpc-select-dropdown__item:visible",
  ".el-select-dropdown__item:visible",
  "[role='option']:visible",
].join(", ");

async function locateAutocompleteLookup(page, input) {
  const popperClass = String(await input?.getAttribute?.("popperclass").catch(() => "") || "");
  const uniqueClass = popperClass.split(/\s+/).find((token) => /^el-autocomplete-suggestion_[A-Za-z0-9_-]+$/.test(token));
  const popover = uniqueClass
    ? page.locator(`.${uniqueClass}:visible`)
    : page.locator([
      ".rtxpc-autocomplete-suggestion:visible",
      ".el-autocomplete-suggestion:visible",
      ".rtxpc-select-dropdown:visible",
      ".el-select-dropdown:visible",
      "[role='listbox']:visible",
    ].join(", "));
  const rawOptions = uniqueClass
    ? popover.locator("li:visible, [role='option']:visible")
    : page.locator(RECLOUD_PART_OPTION_SELECTOR);
  return {
    popover,
    // Recloud mounts an empty <li> while the remote lookup is loading. It is
    // not a candidate and must not make the lookup finish early.
    options: rawOptions.filter({ hasText: /\S/ }),
  };
}

function parseRecloudPartOptionText(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  const codeToken = (text.match(/[A-Z0-9][A-Z0-9._/-]{5,}/gi) || [])
    .find((token) => /\d/.test(token));
  if (!codeToken) return null;
  const code = codeToken.replace(/[，,;；]$/, "").toUpperCase();
  const name = text.replace(codeToken, "").replace(/^[\s|｜:：-]+|[\s|｜:：-]+$/g, "").trim();
  return { code, name: name || code, source: "RECLOUD_SERVICE_ORDER" };
}

async function waitForPartLookup(page, partCodeInput, requestedPartCode = "", options = {}) {
  const timeoutMs = Number(options.timeoutMs || 2200);
  const deadline = Date.now() + timeoutMs;
  const expected = String(requestedPartCode || "").trim().toUpperCase();
  const lookup = await locateAutocompleteLookup(page, options.lookupInput);
  const optionsLocator = lookup.options;
  // Only trust an empty-state rendered inside the currently open lookup
  // popover. Other service-report sections may independently show “暂无数据”
  // and must never be mistaken for a parts shortage.
  const explicitEmpty = lookup.popover
    .getByText(/^(暂无数据|无数据|没有匹配数据|暂无匹配结果)$/)
    .filter({ visible: true });
  while (Date.now() < deadline) {
    const selectedCode = String(await partCodeInput?.inputValue?.().catch(() => "") || "").trim().toUpperCase();
    if (selectedCode && (!expected || selectedCode === expected)) {
      return { selectedCode, optionCount: await optionsLocator.count().catch(() => 0), explicitEmpty: false };
    }
    const optionCount = await optionsLocator.count().catch(() => 0);
    if (optionCount > 0) return { selectedCode, optionCount, explicitEmpty: false };
    if (await explicitEmpty.count().catch(() => 0)) return { selectedCode, optionCount: 0, explicitEmpty: true };
    await page.waitForTimeout?.(80);
  }
  return {
    selectedCode: String(await partCodeInput?.inputValue?.().catch(() => "") || "").trim().toUpperCase(),
    optionCount: await optionsLocator.count().catch(() => 0),
    explicitEmpty: Boolean(await explicitEmpty.count().catch(() => 0)),
  };
}

async function waitForSelectedPartCode(page, partCodeInput, requestedPartCode = "", options = {}) {
  const deadline = Date.now() + Number(options.timeoutMs || 1200);
  const expected = String(requestedPartCode || "").trim().toUpperCase();
  while (Date.now() < deadline) {
    const selectedCode = String(await partCodeInput?.inputValue?.().catch(() => "") || "").trim().toUpperCase();
    if (selectedCode && (!expected || selectedCode === expected)) return selectedCode;
    await page.waitForTimeout?.(80);
  }
  return String(await partCodeInput?.inputValue?.().catch(() => "") || "").trim().toUpperCase();
}

async function waitForRecloudPartPrice(page, salesPriceInput, options = {}) {
  if (!salesPriceInput) return null;
  const deadline = Date.now() + Number(options.timeoutMs || 1200);
  while (Date.now() < deadline) {
    const value = String(await salesPriceInput.inputValue().catch(() => "") || "").trim();
    const price = value === "" ? NaN : Number(value);
    if (Number.isFinite(price) && price >= 0) return price;
    await page.waitForTimeout?.(80);
  }
  return null;
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
  const inputType = typeof input.getAttribute === "function"
    ? String(await input.getAttribute("type").catch(() => "") || "").toLowerCase()
    : "";
  if (inputType === "autocomplete") {
    // Recloud lookup fields only commit the backing record id after keyboard
    // selection. `fill()` alone changes the caption but leaves validation in
    // the invalid state, which looks correct visually yet cannot be saved.
    await input.fill(value);
    await page.waitForTimeout?.(600);
    await input.press("ArrowDown");
    await input.press("Enter");
    await page.waitForTimeout?.(250);
    return;
  }
  await page.waitForTimeout?.(300);
  // Recloud renders some fields as select dropdowns and others as remote
  // autocomplete lookups. Both must be supported here because the fault
  // classification fields use the latter.
  const option = page.locator([
    ".rtxpc-select-dropdown__item:visible",
    ".el-select-dropdown__item:visible",
    ".rtxpc-autocomplete-suggestion li:visible",
    ".el-autocomplete-suggestion li:visible",
    "[role='option']:visible",
  ].join(", "))
    .filter({ hasText: exactText(value) });
  const firstOption = option.first();
  if (typeof firstOption.waitFor === "function") {
    await firstOption.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
  }
  const target = await uniqueVisible(option, `瑞云下拉框缺少“${value}”`, "RECLOUD_REPAIR_PICKLIST_OPTION_AMBIGUOUS", "FIELDS");
  await target.click({ timeout: 3000 });
}

async function readPicklistValue(item) {
  const selected = item?.locator(".rt-picklist__tags .rt-tag-text:visible, .el-select__tags .el-tag:visible");
  if (selected && typeof selected.allInnerTexts === "function") {
    const selectedValues = [...new Set((await selected.allInnerTexts())
      .map((value) => String(value || "").replace(/\s+/g, " ").trim())
      .filter(Boolean))];
    if (selectedValues.length === 1) return selectedValues[0];
    if (selectedValues.length > 1) {
      throw adapterError("瑞云下拉框存在多个选中值", "RECLOUD_REPAIR_PICKLIST_SELECTED_AMBIGUOUS", "FIELDS");
    }
  }
  const input = item?.locator("input:visible").first();
  if (!input || await input.count() !== 1) return "";
  const inputValue = String(await input.inputValue()).trim();
  if (inputValue) return inputValue;
  // Remote lookup controls can keep their selected caption in `tip-text`
  // while leaving the search input value empty.
  if (typeof input.getAttribute !== "function") return "";
  return String(await input.getAttribute("tip-text").catch(() => "") || "").trim();
}

async function ensurePicklistValue(page, item, value, label) {
  const expected = String(value || "").trim();
  if (!expected) return false;
  const input = item?.locator("input:visible").first();
  if (!input || await input.count() !== 1) {
    throw adapterError(`瑞云${label || "下拉"}结构发生变化`, "RECLOUD_REPAIR_PICKLIST_CHANGED", "FIELDS");
  }
  const current = await readPicklistValue(item);
  if (current === expected) return false;
  await selectPicklistValue(page, item, expected);
  await page.waitForTimeout?.(250);
  const confirmed = await readPicklistValue(item);
  if (confirmed !== expected) {
    throw adapterError(
      `瑞云${label || "下拉"}写入后复核失败`,
      "RECLOUD_REPAIR_PICKLIST_POSTVERIFY_FAILED",
      "FIELDS"
    );
  }
  return true;
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

async function isRecloudRepairFullySubmitted(page) {
  const completedBadge = page.getByText("已完工", { exact: true }).filter({ visible: true });
  const pendingSubmit = page.getByRole("button", { name: exactText("提交") }).filter({ visible: true });
  return await completedBadge.count() === 1 && await pendingSubmit.count() === 0;
}

function createRecloudRepairPageAdapter(page, context = {}) {
  let initialBlockingMessageSweepCompleted = false;
  const dismissRepairNotices = async () => {
    await dismissBlockingRepairMessageBoxes(page, {
      // Some model-specific notices are mounted a few seconds after the
      // service-order page appears. Wait for that delayed first notice once;
      // subsequent reads only dismiss notices that are already visible.
      settleMs: context.fastPartsInteraction === true
        ? 0
        : initialBlockingMessageSweepCompleted ? 0 : 3500,
    });
    initialBlockingMessageSweepCompleted = true;
  };
  return {
    async waitForTimeout(timeoutMs) {
      await page.waitForTimeout?.(Number(timeoutMs || 0));
    },

    async readAssignee() {
      await dismissRepairNotices();
      const assignee = await inspectCurrentAssignee(page);
      return assignee.currentAssignee;
    },

    async readRemoteState() {
      await dismissRepairNotices();
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
      const expectsDetectionReport = (context.payload?.attachments || []).some((item) => item?.source === "INSPECTION_REPORT");
      const detectionReportAttachments = expectsDetectionReport
        ? await readExistingRepairAttachments(page, "附件（检测报告）").catch(() => [])
        : [];
      console.info("RECLOUD_REPAIR_REMOTE_READ: attachments_ready");
      return {
        assignee: assignee.currentAssignee,
        parts,
        attachments: enrichExpectedAttachmentMetadata(attachments, context.payload?.attachments),
        detectionReportAttachments: enrichExpectedAttachmentMetadata(detectionReportAttachments, context.payload?.attachments),
        // “已完工”只代表完工资料已经保存。只要页面仍显示“提交”，
        // 签核流程就还没有完成，必须继续走最终提交，不能提前报成功。
        completed: await isRecloudRepairFullySubmitted(page),
      };
    },

    async readRemoteAttachments(options = {}) {
      await dismissRepairNotices();
      await openServiceReport(page);
      const target = String(options.target || "附件").trim();
      const attachments = await readExistingRepairAttachments(page, target).catch(() => []);
      return enrichExpectedAttachmentMetadata(attachments, context.payload?.attachments);
    },

    async readParts() {
      await dismissRepairNotices();
      await openServiceReport(page);
      return readExistingRepairParts(page).catch((error) => {
        if (error.code === "RECLOUD_REPAIR_PARTS_TABLE_NOT_FOUND") return [];
        throw error;
      });
    },

    async assignResponsible(plan) {
      // 师傅点击下一步后执行“改派”。严禁使用“派单”；重试时仍须
      // 重新读取当前负责人并保证只对目标服务单做幂等改派。
      // 建单完成后瑞云偶尔会保留特殊服务项目提示；必须先点右上角叉
      // 关闭，否则其遮罩会拦截“改派”按钮并造成固定 5 秒超时。
      await dismissBlockingRepairMessageBoxes(page);
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
      // “保外转保内”是服务单进入维修后的必经确认项，而不是仅在表格
      // 当前显示“保外”时才执行。即使产品行已经显示“保内”，仍要打开
      // 确认窗口并按 FieldDesk 选择明确提交“是/否”，不能以显示值代替确认。
      // 瑞云表格会把“操作”列复制到 fixed-right 浮层。主体行中的按钮虽然
      // 可见，但会被浮层副本挡住；应优先点击真正位于 fixed-right 中的按钮。
      // 仍然先用 SN 锁定唯一产品行，避免误操作同单的其他产品。
      const productRowText = String(await productRow.innerText().catch(() => ""));
      const productRowValues = productRowText.split(/\s+/).filter(Boolean);
      const rowButtons = productRow
        .getByRole("button", { name: exactText("保外转保内") })
        .filter({ visible: true });
      const fixedButtons = page
        .locator(".rtxpc-table__fixed-right:visible, .el-table__fixed-right:visible")
        .getByRole("button", { name: exactText("保外转保内") })
        .filter({ visible: true });
      const fixedCount = await fixedButtons.count();
      const rowCount = await rowButtons.count();
      if (fixedCount > 1 || (fixedCount === 0 && rowCount > 1)) {
        throw adapterError(
          `保外转保内按钮不唯一（固定列 ${fixedCount} 个，主体行 ${rowCount} 个）`,
          "RECLOUD_WARRANTY_CONVERSION_BUTTON_AMBIGUOUS",
          "WARRANTY_CONVERSION"
        );
      }
      if (fixedCount === 0 && rowCount === 0) {
        if (productRowValues.includes("保内")) {
          console.info("RECLOUD_WARRANTY_CONVERSION: already_explicitly_confirmed");
          return { confirmed: true, alreadyExplicitlyConfirmed: true };
        }
        throw adapterError(
          "当前产品行缺少保外转保内按钮",
          "RECLOUD_WARRANTY_CONVERSION_BUTTON_AMBIGUOUS",
          "WARRANTY_CONVERSION"
        );
      }
      const button = fixedCount === 1 ? fixedButtons.first() : rowButtons.first();
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

    async searchParts(keyword, options = {}) {
      await dismissRepairNotices();
      await openServiceReport(page);
      const query = String(keyword || "").trim();
      if (query.length < 2) {
        throw adapterError("至少输入 2 个字符后再查询瑞云配件", "RECLOUD_REPAIR_PART_QUERY_TOO_SHORT", "PARTS");
      }
      const dialog = await openRepairPartAddDialog(page, { timeoutMs: 5000 });
      try {
        const productInput = await locateDialogInput(dialog, "服务单产品明细");
        const partInput = await locateDialogInput(dialog, "新件名称");
        const partCodeInput = await locateDialogInput(dialog, "新件编码");
        const salesPriceInput = await locateDialogInput(dialog, "销售价");
        if (!productInput || !partInput || !partCodeInput) {
          throw adapterError("配件窗口查询控件发生变化", "RECLOUD_REPAIR_PART_FORM_CHANGED", "PARTS");
        }
        await selectFirstRequiredOption(page, productInput);
        await partInput.fill(query);
        const lookup = await waitForPartLookup(page, partCodeInput, "", {
          timeoutMs: Number(options.timeoutMs || 2400),
          lookupInput: partInput,
        });
        const partLookup = await locateAutocompleteLookup(page, partInput);
        const optionTexts = lookup.optionCount > 0
          ? await partLookup.options.allInnerTexts().catch(() => [])
          : [];
        const items = [];
        const seen = new Set();
        for (const optionText of optionTexts) {
          const item = parseRecloudPartOptionText(optionText);
          if (!item || seen.has(item.code)) continue;
          seen.add(item.code);
          items.push(item);
          if (items.length >= Math.max(1, Math.min(50, Number(options.limit || 30)))) break;
        }
        // The current Recloud build renders only the part name in lookup
        // suggestions. Its authoritative full material code and price are
        // populated into disabled fields only after a suggestion is selected.
        // Select name-only suggestions inside this unsaved preflight dialog,
        // read the populated values, and never click Save here.
        if (items.length === 0 && lookup.optionCount > 0 && !lookup.selectedCode) {
          const maxItems = Math.max(1, Math.min(10, Number(options.limit || 10)));
          const candidateCount = Math.min(lookup.optionCount, maxItems);
          for (let index = 0; index < candidateCount; index += 1) {
            if (index > 0) {
              await partInput.fill("");
              await partInput.fill(query);
              const reopened = await waitForPartLookup(page, partCodeInput, "", {
                timeoutMs: 1200,
                lookupInput: partInput,
              });
              if (reopened.optionCount <= index) break;
            }
            const optionLocator = (await locateAutocompleteLookup(page, partInput)).options;
            const optionName = String(await optionLocator.nth(index).innerText().catch(() => "") || "").replace(/\s+/g, " ").trim();
            await optionLocator.nth(index).click({ timeout: 3000 });
            const selectedCode = await waitForSelectedPartCode(page, partCodeInput, "", { timeoutMs: 1200 });
            console.info(
              `RECLOUD_PART_PREFLIGHT_SELECTION: query=${query} index=${index} name=${optionName || "-"} selected=${selectedCode || "-"}`
            );
            if (!selectedCode || seen.has(selectedCode)) continue;
            const selectedName = String(await partInput.inputValue().catch(() => "") || optionName || query).trim();
            const salesPrice = await waitForRecloudPartPrice(page, salesPriceInput, { timeoutMs: 1200 });
            seen.add(selectedCode);
            items.push({
              code: selectedCode,
              name: selectedName || selectedCode,
              retailPrice: Number.isFinite(salesPrice) && salesPrice >= 0 ? salesPrice : null,
              source: "RECLOUD_SERVICE_ORDER",
            });
          }
        }
        // Some Recloud builds auto-select the only match and immediately hide
        // the suggestion list. In that case the full code is already written
        // to the read-only code field; treat it as an explicit single result
        // instead of reporting an empty lookup and retrying forever.
        if (items.length === 0 && lookup.selectedCode) {
          const selectedName = String(await partInput.inputValue().catch(() => "") || query).trim();
          const salesPrice = await waitForRecloudPartPrice(page, salesPriceInput, { timeoutMs: 1200 });
          items.push({
            code: lookup.selectedCode,
            name: selectedName || lookup.selectedCode,
            retailPrice: Number.isFinite(salesPrice) && salesPrice >= 0 ? salesPrice : null,
            source: "RECLOUD_SERVICE_ORDER",
          });
        }
        console.info(
          `RECLOUD_PART_PREFLIGHT: query=${query} options=${lookup.optionCount} selected=${lookup.selectedCode || "-"} resolved=${items.length}`
        );
        return {
          items,
          explicitEmpty: lookup.explicitEmpty === true,
          source: "RECLOUD_SERVICE_ORDER",
        };
      } finally {
        if (await dialog.isVisible().catch(() => false)) {
          const close = dialog.locator(".el-dialog__headerbtn:visible, button[aria-label='Close']:visible, button[aria-label*='关闭']:visible");
          if (await close.count() === 1) await close.first().click({ timeout: 1500 }).catch(() => {});
          if (await dialog.isVisible().catch(() => false)) await page.keyboard.press("Escape").catch(() => {});
        }
      }
    },

    async addParts(additions) {
      await openServiceReport(page);
      const missingParts = [];
      for (const part of additions) {
        const dialog = await openRepairPartAddDialog(page, { timeoutMs: 7000 });
        const productInput = await locateDialogInput(dialog, "服务单产品明细");
        const partInput = await locateDialogInput(dialog, "新件名称");
        const partCodeInput = await locateDialogInput(dialog, "新件编码");
        const quantityInput = await locateDialogInput(dialog, "数量");
        if (!productInput || !partInput || !partCodeInput || !quantityInput) {
          throw adapterError("配件窗口必填控件发生变化", "RECLOUD_REPAIR_PART_FORM_CHANGED", "PARTS");
        }
        await selectFirstRequiredOption(page, productInput);
        const requestedPartCode = String(part.partCode || "").trim().toUpperCase();
        let selectedPartCode = "";
        let explicitEmpty = false;
        // 优先等待瑞云的下拉结果或只读编码回填，不再使用固定长等待。
        // 只有瑞云明确显示无数据才按缺件处理；超时/网络异常必须抛出，
        // 由后台安全重试，不能把系统故障伪装成库存不足。
        for (let attempt = 0; attempt < 2 && selectedPartCode !== requestedPartCode; attempt += 1) {
          await partInput.fill("");
          await partInput.fill(part.partCode);
          const lookup = await waitForPartLookup(page, partCodeInput, requestedPartCode, {
            timeoutMs: attempt === 0 ? 1800 : 2600,
            lookupInput: partInput,
          });
          explicitEmpty ||= lookup.explicitEmpty === true;
          if (!lookup.optionCount && !lookup.selectedCode) continue;
          await partInput.press("ArrowDown");
          await partInput.press("Enter");
          selectedPartCode = await waitForSelectedPartCode(page, partCodeInput, requestedPartCode, { timeoutMs: 1200 });
        }
        if (selectedPartCode !== requestedPartCode) {
          if (!explicitEmpty) {
            throw adapterError(
              `瑞云配件 ${requestedPartCode} 查询未返回明确结果，等待后台重试`,
              "RECLOUD_REPAIR_PART_LOOKUP_UNAVAILABLE",
              "PARTS"
            );
          }
          missingParts.push({
            partCode: String(part.partCode || "").trim(),
            partName: String(part.partName || "").trim(),
            quantity: Number(part.quantity || 0),
            reason: "瑞云配件窗口明确显示无可用结果",
          });
          // Reload closes every known variant of the add-part dialog. The
          // orchestrator persists this as PARTS_SHORTAGE, continues through
          // Complete, and deliberately stops before Submit.
          await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 });
          await openServiceReport(page);
          continue;
        }
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
        let saveResultNeedsRemoteVerification = false;
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
            saveResultNeedsRemoteVerification = true;
          } catch (closeError) {
            // 这个弹窗没有关闭按钮，部分瑞云环境保存后也不会自行消失。
            // 刷新只丢弃当前未关闭的弹窗，再从已落库的配件表核验结果。
            await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 });
            await openServiceReport(page);
            saveResultNeedsRemoteVerification = true;
          }
        }
        await page.waitForTimeout?.(500);
        if (saveResultNeedsRemoteVerification) {
          let saved = false;
          for (let attempt = 0; attempt < 6; attempt += 1) {
            const remoteParts = await readExistingRepairParts(page);
            saved = remoteParts.some((item) =>
              String(item.partCode || "").trim().toUpperCase() === String(part.partCode || "").trim().toUpperCase()
              && Number(item.quantity) === Number(part.quantity)
            );
            if (saved) break;
            if (attempt < 5) await page.waitForTimeout?.(500);
          }
          if (!saved) {
            throw adapterError(
              `瑞云配件 ${part.partCode} 保存后未出现在更换件明细中`,
              "RECLOUD_REPAIR_PART_SAVE_RESULT_UNKNOWN",
              "PARTS"
            );
          }
        }
      }
      return { missingParts };
    },

    async applyRepairFields(plan) {
      await openServiceReport(page);
      const report = await uniqueVisible(
        page.getByRole("tabpanel", { name: exactText("服务报告") }).filter({ visible: true }),
        "瑞云服务报告区域不唯一",
        "RECLOUD_REPAIR_REPORT_AMBIGUOUS",
        "FIELDS"
      );
      const directControls = createRecloudRepairControlAdapter(page, report);
      let directFieldsChanged = false;
      for (const field of plan.safeWrites.filter((item) => ["customerPaidAmount", "logisticsAmount", "primaryRemark", "secondaryRemark"].includes(item.key))) {
        const control = field.key === "primaryRemark" ? "PICKLIST" : field.key === "secondaryRemark" ? "TEXT" : "NUMBER";
        const expected = normalizeRepairControlValue(field.value, control);
        const current = await directControls.read(field.key);
        if (current !== expected) {
          await directControls.write(field.key, field.value);
          directFieldsChanged = true;
        }
        const confirmed = await directControls.read(field.key);
        if (confirmed !== expected) {
          throw adapterError(`瑞云维修字段 ${field.target} 写入后复核失败`, "RECLOUD_REPAIR_DIRECT_FIELD_POSTVERIFY_FAILED", "FIELDS");
        }
      }
      if (directFieldsChanged) {
        const saveOrder = await uniqueVisible(
          page.getByRole("button", { name: exactText("保存") }).filter({ visible: true }),
          "瑞云维修单保存按钮不唯一",
          "RECLOUD_REPAIR_ORDER_SAVE_AMBIGUOUS",
          "FIELDS"
        );
        await saveOrder.click({ timeout: 5000 });
        await page.waitForTimeout?.(600);
        await openServiceReport(page);
      }
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
      // The repair-detail drawer owns its own required classification fields.
      // A service order created from an RMA can occasionally inherit only the
      // first two levels, leaving level three blank. In that state Recloud
      // silently keeps the drawer open when Save is clicked and the completion
      // worker can never advance. FieldDesk is the source of truth, so repair
      // every classification level in parent-to-child order before saving.
      for (const [label, expected] of [
        ["故障一级分类", fault.faultLevel1],
        ["故障二级分类", fault.faultLevel2],
        ["故障三级分类", fault.faultLevel3],
      ]) {
        const classification = await locateFormItemByText(dialog, label);
        if (!classification) {
          throw adapterError(`缺少${label}`, "RECLOUD_REPAIR_FAULT_CLASSIFICATION_NOT_FOUND", "FIELDS");
        }
        await ensurePicklistValue(page, classification, expected, label);
      }
      const troubleshooting = await locateFormItemByText(dialog, "是否是排障问题");
      if (!troubleshooting) throw adapterError("缺少是否是排障问题", "RECLOUD_REPAIR_TROUBLESHOOTING_NOT_FOUND", "FIELDS");
      await ensurePicklistValue(page, troubleshooting, "否", "是否是排障问题");
      const measure = dialog.getByRole("textbox", { name: exactText("维修措施") }).filter({ visible: true });
      const measureInput = await uniqueVisible(measure, "维修措施输入框不唯一", "RECLOUD_REPAIR_MEASURE_CONTROL_AMBIGUOUS", "FIELDS");
      await measureInput.fill(value);
      const save = await uniqueVisible(dialog.getByRole("button", { name: exactText("保存") }).filter({ visible: true }), "维修措施保存按钮不唯一", "RECLOUD_REPAIR_MEASURE_SAVE_AMBIGUOUS", "FIELDS");
      await save.click({ timeout: 5000 });
      try {
        await dialog.waitFor({ state: "hidden", timeout: 10000 });
      } catch (error) {
        // Some Recloud drawer variants save the edited row but deliberately
        // remain open. Close that drawer with its dedicated X, then persist the
        // containing service order and verify from a fresh page below.
        const validationMessages = await dialog
          .locator(".el-form-item__error:visible, [role='alert']:visible")
          .allInnerTexts()
          .catch(() => []);
        const validationMessage = validationMessages
          .map((item) => String(item || "").replace(/\s+/g, " ").trim())
          .filter(Boolean)
          .join("；");
        if (validationMessage) {
          throw adapterError(
            `瑞云维修措施保存校验失败：${validationMessage}`,
            "RECLOUD_REPAIR_MEASURE_SAVE_VALIDATION_FAILED",
            "FIELDS"
          );
        }
        const closeDrawer = dialog.locator(".btn-close button:visible");
        if (await closeDrawer.count() !== 1) throw error;
        await closeDrawer.first().click({ timeout: 5000, force: true });
        await dialog.waitFor({ state: "hidden", timeout: 5000 });
      }
      // The row dialog only updates the page draft. Persist the whole service
      // order before any verification; otherwise the same DOM can look correct
      // even though a fresh Recloud page still contains the old values.
      const saveOrder = await uniqueVisible(
        page.getByRole("button", { name: exactText("保存") }).filter({ visible: true }),
        "瑞云维修单保存按钮不唯一",
        "RECLOUD_REPAIR_ORDER_SAVE_AMBIGUOUS",
        "FIELDS"
      );
      await saveOrder.click({ timeout: 5000 });
      await page.waitForTimeout?.(600);
    },

    async verifyRepairFields(plan) {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 });
      await openServiceReport(page);
      const report = await uniqueVisible(
        page.getByRole("tabpanel", { name: exactText("服务报告") }).filter({ visible: true }),
        "瑞云服务报告区域不唯一",
        "RECLOUD_REPAIR_REPORT_AMBIGUOUS",
        "FIELDS"
      );
      const directControls = createRecloudRepairControlAdapter(page, report);
      for (const field of plan.safeWrites.filter((item) => ["customerPaidAmount", "logisticsAmount", "primaryRemark", "secondaryRemark"].includes(item.key))) {
        const control = field.key === "primaryRemark" ? "PICKLIST" : field.key === "secondaryRemark" ? "TEXT" : "NUMBER";
        const expected = normalizeRepairControlValue(field.value, control);
        if (await directControls.read(field.key) !== expected) return false;
      }
      const expected = String(plan.safeWrites.find((item) => item.key === "repairMeasure")?.value || "").trim();
      const rows = page.getByRole("row")
        .filter({ hasText: String(context.sn || "").trim().toUpperCase() })
        .filter({ hasText: expected })
        .filter({ visible: true });
      if (await rows.count() !== 1) return false;
      return /(?:^|\s)否(?:\s|$)/.test(String(await rows.first().innerText()));
    },

    async uploadAttachments(plan, options = {}) {
      await openServiceReport(page);
      if (!plan.additions.length) return { uploadedCount: 0 };
      const target = String(options.target || "附件").trim();
      const isDetectionReport = target === "附件（检测报告）";
      const headings = page.getByText(target, { exact: true }).filter({ visible: true });
      const heading = await uniqueVisible(headings, `瑞云${target}区域不唯一`, isDetectionReport ? "RECLOUD_DETECTION_REPORT_SECTION_AMBIGUOUS" : "RECLOUD_REPAIR_ATTACHMENT_SECTION_AMBIGUOUS", isDetectionReport ? "DETECTION_REPORT" : "ATTACHMENTS");
      const panel = heading.locator("xpath=ancestor::*[.//button[normalize-space(.)='上传附件']][1]");
      if (await panel.count() !== 1) throw adapterError(`无法定位瑞云${target}上传按钮`, isDetectionReport ? "RECLOUD_DETECTION_REPORT_UPLOAD_NOT_FOUND" : "RECLOUD_REPAIR_ATTACHMENT_UPLOAD_NOT_FOUND", isDetectionReport ? "DETECTION_REPORT" : "ATTACHMENTS");
      const uploadEntry = await uniqueVisible(panel.getByRole("button", { name: exactText("上传附件") }).filter({ visible: true }), `瑞云${target}上传按钮不唯一`, isDetectionReport ? "RECLOUD_DETECTION_REPORT_UPLOAD_AMBIGUOUS" : "RECLOUD_REPAIR_ATTACHMENT_UPLOAD_AMBIGUOUS", isDetectionReport ? "DETECTION_REPORT" : "ATTACHMENTS");
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
      const saveOrder = await uniqueVisible(
        page.getByRole("button", { name: exactText("保存") }).filter({ visible: true }),
        "瑞云维修单保存按钮不唯一",
        "RECLOUD_REPAIR_ORDER_SAVE_AMBIGUOUS",
        "ATTACHMENTS"
      );
      await saveOrder.click({ timeout: 5000 });
      await page.waitForTimeout?.(600);
      await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 });
      await openServiceReport(page);
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
      const completedBadge = page.getByText("已完工", { exact: true }).filter({ visible: true });
      const confirmationDeadline = Date.now() + 30000;
      while (Date.now() < confirmationDeadline) {
        if (await submitReady.count() === 1 || await completedBadge.count() === 1) {
          return { confirmed: true };
        }
        await page.waitForTimeout?.(500);
      }
      throw adapterError("瑞云点击完工后状态未变化", "RECLOUD_REPAIR_COMPLETE_NOT_CONFIRMED", "COMPLETE");
    },

    async waitForSubmitReady(options = {}) {
      const deadline = Date.now() + Number(options.timeoutMs || 30000);
      while (Date.now() < deadline) {
        if (await page.getByRole("button", { name: exactText("提交") }).filter({ visible: true }).count() === 1) return true;
        await page.waitForTimeout?.(Number(options.pollIntervalMs || 500));
      }
      return false;
    },

    async printOldPartLabels(parts = []) {
      if (!context.printJobStore) return { deferredToOutlet: true, jobs: [] };
      const payload = context.payload || {};
      const jobs = [];
      for (const [index, part] of parts.entries()) {
        jobs.push(await context.printJobStore.enqueue({
          userId: payload.technicianId,
          userName: payload.technicianName || payload.assignee,
          documentType: "OLD_PART_LABEL",
          title: `旧件标签 · ${String(part.partCode || part.code || "").trim() || index + 1}`,
          rmaNo: context.rmaNo,
          sn: context.sn,
          partCode: part.partCode || part.code,
          partName: part.partName || part.name,
          quantity: part.quantity || 1,
          copies: part.quantity || 1,
          technicianName: payload.technicianName || payload.assignee,
          idempotencyKey: `old-part-label:${context.rmaNo}:${String(part.partCode || part.code || "part").trim()}:${index}`,
        }));
      }
      return { queued: true, jobs };
    },

    async clickSubmit(options = {}) {
      if (options.stopImmediately !== true) throw adapterError("最终提交必须设置立即停止", "RECLOUD_REPAIR_SUBMIT_POLICY_INVALID", "SUBMIT");
      const button = await uniqueVisible(page.getByRole("button", { name: exactText("提交") }).filter({ visible: true }), "瑞云提交按钮不唯一", "RECLOUD_REPAIR_SUBMIT_AMBIGUOUS", "SUBMIT");
      await clickAfterLoadingSettles(page, button);
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
        const flowDeadline = Date.now() + 2500;
        while (Date.now() < flowDeadline) {
          selectedFlow = await readApprovalFlow(dialog, flowInput);
          if (selectedFlow === expectedFlow) break;
          await page.waitForTimeout?.(100);
        }
      }
      if (selectedFlow !== expectedFlow) {
        throw adapterError("瑞云签核流程不是预期流程", "RECLOUD_REPAIR_APPROVAL_FLOW_MISMATCH", "SUBMIT");
      }
      const submit = await uniqueVisible(dialog.getByRole("button", { name: exactText("提交") }).filter({ visible: true }), "签核流程提交按钮不唯一", "RECLOUD_REPAIR_APPROVAL_SUBMIT_AMBIGUOUS", "SUBMIT");
      if (!await submit.isEnabled()) throw adapterError("签核流程提交按钮不可用", "RECLOUD_REPAIR_APPROVAL_SUBMIT_DISABLED", "SUBMIT");
      const clickResult = await clickAfterLoadingSettles(page, submit, {
        timeoutMs: 15_000,
        pollIntervalMs: 200,
        successCheck: () => isRecloudRepairFullySubmitted(page),
      });
      if (clickResult?.alreadySucceeded) return { confirmed: true, reconciledAfterClickTimeout: true };
      if (!await waitForRepairSubmissionConfirmed(page, { timeoutMs: 15_000, pollIntervalMs: 200 })) {
        throw adapterError("瑞云已点击最终提交，但未确认进入已提交状态", "RECLOUD_REPAIR_SUBMIT_NOT_CONFIRMED", "SUBMIT");
      }
      return { confirmed: true, reconciledAfterClickTimeout: false };
    },
  };
}

module.exports = {
  clickAfterLoadingSettles,
  clickApprovalFlowInput,
  createRecloudRepairPageAdapter,
  dismissBlockingRepairMessageBoxes,
  ensurePicklistValue,
  waitForDialog,
  isRecloudRepairFullySubmitted,
  parseRecloudPartOptionText,
  readApprovalFlow,
  waitForRepairSubmissionConfirmed,
  waitForPartLookup,
  waitForRecloudPartPrice,
  waitForSelectedPartCode,
};
