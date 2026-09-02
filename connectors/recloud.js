const path = require("path");
const {
  RecloudQueryError,
  extractRmaNoFromTitle,
  extractTextFieldPairs,
  parseRmaFieldPairs,
  selectProductLine,
} = require("./recloud-rma-parser");
const {
  collectSafeFieldTitles,
  isDomDiagnosticsEnabled,
  logSafeFieldTitles,
} = require("./recloud-dom-diagnostics");
const {
  RECLOUD_PROFILE_DIRECTORY,
  createRecloudSessionManager,
} = require("./recloud-session");
const {
  readPendingRmaSupervisionOrders,
  readRmaSupervisionOrderStatuses,
  readSupervisionOrders,
} = require("./recloud-supervision");
const { executeDetectionPrefillSafely } = require("../services/detection-prefill-executor");
const { createRecloudDetectionControlAdapter } = require("./recloud-detection-control-adapter");
const { inspectDirectRepairControls } = require("./recloud-repair-control-adapter");
const { inspectRepairPartsTable } = require("./recloud-repair-parts-reader");
const {
  openRepairPartAddDialog,
  inspectAndCloseRepairPartAddDialog,
} = require("./recloud-repair-part-dialog");
const { inspectRepairAttachmentPanel } = require("./recloud-repair-attachments-reader");
const { inspectRepairExecutionControls } = require("./recloud-repair-execution-inspector");
const { validateProjectCorrectionInput } = require("../services/recloud-project-correction-rules");

const LOGIN_STATE = path.join(__dirname, "recloud-state.json");
const RECLOUD_URL =
  "https://crm2.recloud.com.cn/t/dreame/webapp/dreame/?mainNavName=serviceprovider#/scanSignin/query";
const RECLOUD_PENDING_LIST_URL =
  "https://crm2.recloud.com.cn/t/dreame/webapp/dreame/?mainNavName=serviceprovider#/vmlist/new_srv_rmaline/wdjx";
const RECLOUD_HISTORY_QUERY_URL =
  "https://crm2.recloud.com.cn/t/dreame/webapp/dreame/?mainNavName=serviceprovider#/HistoryOrderQuery/query";
const DEFAULT_TIMEOUT = Number(process.env.RECLOUD_TIMEOUT_MS) || 30000;
const SCAN_PAGE_PROBE_TIMEOUT = 1200;
const QUERY_RETRY_DELAY = 3000;
const SCANNER_KEY_DELAY = 30;
const ENTER_SETTLE_DELAY = 300;
const READY_PAGE_TIMEOUT =
  Number(process.env.RECLOUD_READY_TIMEOUT_MS) || 120000;
const PHONE_REVEAL_TIMEOUT = 5000;
const LOGIN_REQUIRED_MESSAGE = "请重新初始化瑞云登录状态";
const LOGISTICS_INPUT_PLACEHOLDER =
  "请用扫码枪输入物流单号/工单号/订单号/退换单";
const sessionManager = createRecloudSessionManager({
  defaultTimeout: DEFAULT_TIMEOUT,
  isLoginPage: isRecloudLoginPage,
  isReadyPage: async (page) => {
    const input = getLogisticsInput(page);
    if (await input.isVisible().catch(() => false)) return true;
    try {
      await input.waitFor({ state: "visible", timeout: READY_PAGE_TIMEOUT });
      return true;
    } catch {
      return false;
    }
  },
  profileDirectory: RECLOUD_PROFILE_DIRECTORY,
  targetUrl: RECLOUD_URL,
});

function normalizeText(value) {
  return String(value || "").trim();
}

function inferProductType(text) {
  if (/扫地|扫拖|机器人/.test(text)) return "扫地机";
  if (/洗地/.test(text)) return "洗地机";
  return "";
}

function parseRepairDetail(text, logisticsNo = "") {
  const content = normalizeText(text);
  const snMatch = content.match(/\bW[A-Z0-9]{10,}\b/i);
  const rmaMatch = content.match(/\bJXTH\d+\b/i);
  const phoneMatch = content.match(/\b1[3-9]\d{9}\b/);

  return {
    logisticsNo: normalizeText(logisticsNo),
    sn: snMatch ? snMatch[0].toUpperCase() : "",
    rmaNo: rmaMatch ? rmaMatch[0].toUpperCase() : "",
    crmOrderNo: rmaMatch ? rmaMatch[0].toUpperCase() : "",
    productType: inferProductType(content),
    product: inferProductType(content),
    phone: phoneMatch ? phoneMatch[0] : "",
  };
}

async function openRecloud(options = {}) {
  return sessionManager.ensureOpen(options);
}

async function closeRecloud() {
  await sessionManager.close();
}

function isRecloudLoginPage(url) {
  try {
    return new URL(url).hostname.toLowerCase() === "auth4.recloud.com.cn";
  } catch {
    return false;
  }
}

function assertRecloudAuthenticated(page) {
  if (isRecloudLoginPage(page.url())) {
    const error = new Error(LOGIN_REQUIRED_MESSAGE);
    error.code = "RECLOUD_LOGIN_REQUIRED";
    throw error;
  }
}

function getLogisticsInput(page) {
  return page
    .locator(`input[placeholder*="${LOGISTICS_INPUT_PLACEHOLDER}"]`)
    .first();
}

function logRecloudStage(stage, logger = console) {
  logger.info(`RECLOUD_STAGE: ${stage}`);
}

function getSelectAllShortcut(platform = process.platform) {
  return platform === "darwin" ? "Meta+A" : "Control+A";
}

function isRevealPhoneEnabled(env = process.env) {
  return String(env.RECLOUD_REVEAL_PHONE_ENABLED ?? "false").toLowerCase() === "true";
}

function isCompleteMobilePhone(value) {
  return /^1[3-9]\d{9}$/.test(normalizeText(value));
}

function parseRmaDateTime(value) {
  const match = String(value || "").trim().toUpperCase().match(/^JXTH(20\d{2})(\d{2})(\d{2})/);
  if (!match) return NaN;
  const [, year, month, day] = match;
  const timestamp = Date.parse(`${year}-${month}-${day}T00:00:00+08:00`);
  return Number.isFinite(timestamp) ? timestamp : NaN;
}

function logPhoneReveal(stage, logger = console) {
  logger.info(`RECLOUD_PHONE_REVEAL: ${stage}`);
}

async function getFeedbackPhoneSearchScope(item) {
  try {
    const row = item
      .locator(
        "xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' el-row ')][1]"
      )
      .first();
    if (await row.isVisible().catch(() => false)) return row;
  } catch {
    // Backward-compatible fallback for pages without an el-row wrapper.
  }
  return item;
}

async function findFeedbackPhoneRevealButton(item, page) {
  try {
    const fieldMaskControl = item.locator('.hidemask.canHideMask').first();
    if (await fieldMaskControl.isVisible().catch(() => false)) {
      return fieldMaskControl;
    }
    const fieldEyeIcon = item
      .locator(
        [
          ".hidemask.canHideMask .el-tooltip.rtxpc-tooltip.rt-icon",
          ".hidemask.canHideMask i.plat-icon-eye-close-lined",
          ".hidemask.canHideMask i[class*='eye']",
        ].join(", ")
      )
      .first();
    if (await fieldEyeIcon.isVisible().catch(() => false)) {
      return fieldEyeIcon;
    }
  } catch {
    // Older/test DOM adapters do not support Recloud's current CSS classes.
  }
  const scope = await getFeedbackPhoneSearchScope(item);
  try {
    const recloudMaskControl = scope.locator('.hidemask.canHideMask').first();
    if (await recloudMaskControl.isVisible().catch(() => false)) {
      return recloudMaskControl;
    }
  } catch {
    // Continue with the generic accessible/tooltip discovery path.
  }
  const attributedButton = scope
    .locator(
      [
        'button[title="显示数据"]',
        '[role="button"][title="显示数据"]',
        'button[aria-label="显示数据"]',
        '[role="button"][aria-label="显示数据"]',
        '[data-testid*="show-data"]',
        '[data-testid*="reveal"]',
      ].join(", ")
    )
    .first();
  if (await attributedButton.isVisible().catch(() => false)) {
    return attributedButton;
  }

  if (typeof scope.getByRole === "function") {
    const accessibleButton = scope
      .getByRole("button", { name: "显示数据", exact: true })
      .first();
    if (await accessibleButton.isVisible().catch(() => false)) {
      return accessibleButton;
    }
  }

  const fieldBox =
    typeof item.boundingBox === "function"
      ? await item.boundingBox().catch(() => null)
      : null;
  const candidates = scope.locator(
    [
      "button:visible",
      '[role="button"]:visible',
      "[tabindex]:visible",
      "svg:visible",
      "i:visible",
      '[class*="icon"]:visible',
    ].join(", ")
  );
  if (typeof candidates.count !== "function") return null;
  const count = await candidates.count();
  for (let index = 0; index < count; index += 1) {
    const candidate = candidates.nth(index);
    const candidateText = normalizeText(
      await candidate.innerText().catch(() => "")
    );
    if (/签收/.test(candidateText)) continue;
    const candidateBox = await candidate.boundingBox().catch(() => null);
    if (
      fieldBox &&
      candidateBox &&
      candidateBox.x + candidateBox.width / 2 <
        fieldBox.x + fieldBox.width / 2
    ) {
      continue;
    }
    await candidate.hover().catch(() => {});
    const tooltip = page
      .getByText("显示数据", { exact: true })
      .filter({ visible: true })
      .first();
    if (await tooltip.isVisible().catch(() => false)) return candidate;
  }

  return null;
}

function extractCompleteMobilePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.match(/1[3-9]\d{9}/)?.[0] || "";
}

function getMaskedPhoneSignature(value) {
  const normalized = String(value || "").replace(/\s+/g, "");
  if (/^1[3-9]\d{9}$/.test(normalized)) {
    return { prefix: normalized.slice(0, 3), suffix: normalized.slice(-4) };
  }
  const match = normalized.match(/(\d{3})\D*(\d{4})$/);
  return match ? { prefix: match[1], suffix: match[2] } : null;
}

function selectMatchingPhone(textRegions, maskedValue) {
  const signature = getMaskedPhoneSignature(maskedValue);
  const candidates = new Set();
  for (const region of textRegions) {
    const digits = String(region || "").replace(/\D/g, "");
    for (const match of digits.matchAll(/1[3-9]\d{9}/g)) {
      candidates.add(match[0]);
    }
  }
  const matching = [...candidates].filter((phone) =>
    !signature ||
    (phone.startsWith(signature.prefix) && phone.endsWith(signature.suffix))
  );
  if (matching.length === 1) return matching[0];
  return "";
}

function collectStringValues(value, output = []) {
  if (typeof value === "string") {
    output.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStringValues(item, output);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectStringValues(item, output);
  }
  return output;
}

function createPhoneResponseListener(page, maskedValue, options = {}) {
  let phone = "";
  let stopped = false;
  let handler;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (typeof page?.off === "function") {
      page.off("response", handler);
    } else if (typeof page?.removeListener === "function") {
      page.removeListener("response", handler);
    }
  };

  handler = async (response) => {
    if (stopped || phone) return;
    try {
      const request = response.request();
      const resourceType = request.resourceType();
      if (resourceType !== "xhr" && resourceType !== "fetch") return;

      let payload;
      try {
        payload = await response.json();
      } catch {
        payload = await response.text();
      }
      if (stopped || phone) return;
      const stringValues = collectStringValues(payload);
      phone = selectMatchingPhone(stringValues, maskedValue);
      if (options.debug === true) {
        let pathname = "unknown";
        try {
          pathname = new URL(response.url()).pathname;
        } catch {}
        const status = typeof response.status === "function"
          ? response.status()
          : "unknown";
        (options.logger || console).info(
          `RECLOUD_PHONE_RESPONSE: path=${pathname} status=${status} values=${stringValues.length} matched=${Boolean(phone)}`
        );
      }
      if (phone) stop();
    } catch {
      // Network parsing is best-effort and never changes the query outcome.
    }
  };

  if (typeof page?.on === "function") page.on("response", handler);
  return {
    getPhone: () => phone,
    stop,
  };
}

async function readVisibleLocatorTexts(locator) {
  if (!locator || typeof locator.count !== "function") return [];
  const values = [];
  const count = await locator.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (!(await candidate.isVisible().catch(() => false))) continue;
    const text = await candidate.innerText().catch(() => "");
    if (text) values.push(text);
  }
  return values;
}

function getPhoneOverlayLocator(page) {
  return page.locator(
    [
      ".el-popover:visible",
      ".el-tooltip__popper:visible",
      '[role="tooltip"]:visible',
      '[role="dialog"]:visible',
      ".el-dialog:visible",
    ].join(", ")
  );
}

async function countVisiblePhoneOverlays(page) {
  if (!page || typeof page.locator !== "function") return 0;
  try {
    return await getPhoneOverlayLocator(page).count();
  } catch {
    return 0;
  }
}

function boxesAreNear(left, right, maximumDistance = 600) {
  if (!left || !right) return false;
  const leftX = left.x + left.width / 2;
  const leftY = left.y + left.height / 2;
  const rightX = right.x + right.width / 2;
  const rightY = right.y + right.height / 2;
  return Math.hypot(leftX - rightX, leftY - rightY) <= maximumDistance;
}

async function readNewAssociatedOverlayTexts(page, options = {}) {
  if (!page || typeof page.locator !== "function") return [];
  try {
    const overlays = getPhoneOverlayLocator(page);
    const count = await overlays.count();
    const values = [];
    for (
      let index = options.overlayBaselineCount || 0;
      index < count;
      index += 1
    ) {
      const overlay = overlays.nth(index);
      if (!(await overlay.isVisible().catch(() => false))) continue;
      const overlayBox = await overlay.boundingBox().catch(() => null);
      const overlayId = await overlay.getAttribute("id").catch(() => "");
      const isAssociated =
        Boolean(overlayId) &&
        [options.ariaControls, options.ariaDescribedBy]
          .filter(Boolean)
          .some((ids) => ids.split(/\s+/).includes(overlayId));
      if (
        !isAssociated &&
        !boxesAreNear(options.buttonBox, overlayBox)
      ) {
        continue;
      }
      const text = await overlay.innerText().catch(() => "");
      if (text) values.push(text);
    }
    return values;
  } catch {
    return [];
  }
}

async function findCurrentFeedbackPhoneItem(page, fallbackItem) {
  if (!page || typeof page.locator !== "function") return fallbackItem;
  try {
    const items = page.locator(".rtxpc-form-item");
    const count = await items.count();
    for (let index = 0; index < count; index += 1) {
      const candidate = items.nth(index);
      if (
        typeof candidate.isVisible === "function" &&
        !(await candidate.isVisible().catch(() => false))
      ) {
        continue;
      }
      const label = candidate
        .locator(
          "label, .rtxpc-form-item__label, [class*='form-item__label']"
        )
        .first();
      const title = normalizeText(
        (await candidate.getAttribute("fieldTitle")) ||
        (await candidate.getAttribute("field-title")) ||
        (await label.innerText().catch(() => ""))
      ).replace(/[：:]$/, "");
      if (title === "反馈电话") return candidate;
    }
  } catch {
    // The click-time locator remains a fallback for static DOM variants.
  }
  return fallbackItem;
}

async function readControlValues(locator) {
  if (!locator || typeof locator.count !== "function") return [];
  const values = [];
  const count = await locator.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const field = locator.nth(index);
    values.push(await field.inputValue().catch(() => ""));
    if (typeof field.evaluate === "function") {
      values.push(
        await field.evaluate((element) => element.value || "").catch(() => "")
      );
    }
    for (const attribute of ["value", "aria-label", "title", "data-value"]) {
      if (typeof field.getAttribute === "function") {
        values.push(await field.getAttribute(attribute).catch(() => ""));
      }
    }
  }
  return values;
}

async function readComponentValueAttributes(locator) {
  if (!locator || typeof locator.count !== "function") return [];
  const values = [];
  const count = await locator.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const field = locator.nth(index);
    for (const attribute of ["value", "data-value"]) {
      if (typeof field.getAttribute === "function") {
        values.push(await field.getAttribute(attribute).catch(() => ""));
      }
    }
  }
  return values;
}

async function readPositionedFragments(item) {
  const fragments = item.locator("span:visible, div:visible");
  if (typeof fragments.count !== "function") return [];
  const entries = [];
  const count = await fragments.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const fragment = fragments.nth(index);
    if (!(await fragment.isVisible().catch(() => false))) continue;
    const textContent = typeof fragment.textContent === "function"
      ? await fragment.textContent().catch(() => "")
      : "";
    entries.push({
      text:
        textContent ||
        (await fragment.innerText().catch(() => "")),
      box: await fragment.boundingBox().catch(() => null),
      index,
    });
  }
  entries.sort((left, right) => {
    if (!left.box || !right.box) return left.index - right.index;
    const rowDelta = left.box.y - right.box.y;
    return Math.abs(rowDelta) > 4 ? rowDelta : left.box.x - right.box.x;
  });
  return entries.map(({ text }) => text);
}

async function findRevealedPhone(item, page, originalControl, options = {}) {
  const values = [];
  const currentItem = await findCurrentFeedbackPhoneItem(page, item);

  try {
    // Recloud updates the existing input in place after the eye control is
    // clicked. Read that exact control first; pages can retain hidden copies
    // of the same form field, so a broad lookup may otherwise pick stale data.
    if (originalControl && typeof originalControl.inputValue === "function") {
      values.push(await originalControl.inputValue().catch(() => ""));
      if (typeof originalControl.evaluate === "function") {
        values.push(
          await originalControl
            .evaluate((element) => element.value || "")
            .catch(() => "")
        );
      }
      if (typeof originalControl.getAttribute === "function") {
        values.push(
          await originalControl.getAttribute("value").catch(() => "")
        );
      }
    }
    values.push(...await readControlValues(
      currentItem.locator("input, textarea")
    ));
    // Recloud's plat-mask component keeps the revealed number on the wrapper
    // element's value attribute while the disabled input can remain masked.
    values.push(...await readComponentValueAttributes(
      currentItem.locator(".plat-mask-input[value], [datafieldname='new_feedbacktel'] [value], [data-value]")
    ));
    values.push(await currentItem.innerText().catch(() => ""));
    values.push(await currentItem.textContent().catch(() => ""));
    for (const attribute of ["aria-label", "title", "data-value"]) {
      if (typeof currentItem.getAttribute === "function") {
        values.push(
          await currentItem.getAttribute(attribute).catch(() => "")
        );
      }
    }
    const fragments = await readPositionedFragments(currentItem);
    values.push(fragments.join(""));
  } catch {
    if (originalControl && typeof originalControl.inputValue === "function") {
      values.push(await originalControl.inputValue().catch(() => ""));
    }
  }

  try {
    values.push(...await readControlValues(
      page.locator("input, textarea")
    ));
  } catch {
    // Page-wide controls are filtered by the masked number signature below.
  }

  values.push(...await readNewAssociatedOverlayTexts(page, options));
  return selectMatchingPhone(values, options.maskedValue);
}

async function revealFeedbackPhone(item, page, control, options = {}) {
  if (options.enabled !== true) {
    return normalizeText(await control.inputValue());
  }

  const logger = options.logger || console;
  logPhoneReveal("field_found", logger);
  const controlVisible =
    typeof control?.isVisible === "function" &&
    (await control.isVisible().catch(() => false));
  if (!controlVisible) {
    logPhoneReveal("failed CONTROL_NOT_FOUND", logger);
    return "";
  }
  logPhoneReveal("control_found", logger);

  const originalValue = normalizeText(await control.inputValue());
  if (!originalValue.includes("*")) {
    if (isCompleteMobilePhone(originalValue)) {
      logPhoneReveal("full_value_ready", logger);
    }
    return originalValue;
  }

  try {
    const button = await findFeedbackPhoneRevealButton(item, page);
    if (!button) {
      logPhoneReveal("failed BUTTON_NOT_FOUND", logger);
      return originalValue;
    }
    const overlayBaselineCount = await countVisiblePhoneOverlays(page);
    const buttonBox = typeof button.boundingBox === "function"
      ? await button.boundingBox().catch(() => null)
      : null;
    const ariaControls = typeof button.getAttribute === "function"
      ? await button.getAttribute("aria-controls").catch(() => "")
      : "";
    const ariaDescribedBy = typeof button.getAttribute === "function"
      ? await button.getAttribute("aria-describedby").catch(() => "")
      : "";
    const network = createPhoneResponseListener(page, originalValue, {
      debug: String(process.env.RECLOUD_PHONE_DEBUG).toLowerCase() === "true",
      logger,
    });
    try {
      const directClick = typeof item?.evaluate === "function"
        ? await item.evaluate((element) => {
            const candidates = [
              ...element.querySelectorAll(
                ".hidemask.canHideMask .rt-icon, .hidemask.canHideMask, .hidemask .rt-icon"
              ),
            ];
            const target = candidates.find((candidate) => {
              const box = candidate.getBoundingClientRect();
              return box.width > 0 && box.height > 0;
            });
            if (!target) return false;
            target.click();
            return true;
          }).catch(() => false)
        : false;
      if (!directClick) await button.click();
      logPhoneReveal("clicked", logger);

      const revealState = typeof control.evaluate === "function"
        ? await control
            .evaluate((element) => {
              const value = String(element.value || "");
              return {
                length: value.length,
                masked: value.includes("*"),
                complete: /^1[3-9]\d{9}$/.test(value.trim()),
              };
            })
            .catch(() => null)
        : null;
      if (revealState) {
        logPhoneReveal(
          `control_state length=${revealState.length} masked=${revealState.masked} complete=${revealState.complete}`,
          logger
        );
      }
      if (revealState?.masked) {
        // The eye is a toggle. A second click while the reveal request is
        // still in flight hides/cancels the full value, so wait for the first
        // click instead of retrying it.
        logPhoneReveal("reveal_pending", logger);
      }

      const deadline =
        Date.now() + (options.timeout ?? PHONE_REVEAL_TIMEOUT);
      while (Date.now() < deadline) {
        const networkValue = network.getPhone();
        if (networkValue) {
          logPhoneReveal("full_value_ready", logger);
          return networkValue;
        }
        const domValue = await findRevealedPhone(item, page, control, {
          maskedValue: originalValue,
          overlayBaselineCount,
          buttonBox,
          ariaControls,
          ariaDescribedBy,
        });
        if (domValue) {
          logPhoneReveal("full_value_ready", logger);
          return domValue;
        }
        await page.waitForTimeout(options.pollInterval ?? 100);
      }
      logPhoneReveal("failed FULL_VALUE_TIMEOUT", logger);
    } finally {
      network.stop();
    }
  } catch {
    logPhoneReveal("failed REVEAL_ERROR", logger);
    return originalValue;
  }

  return originalValue;
}

async function waitForVisibleText(page, text, timeout = DEFAULT_TIMEOUT) {
  const locator = page
    .getByText(text, { exact: true })
    .filter({ visible: true })
    .first();
  await locator.waitFor({ state: "visible", timeout });
  return locator;
}

async function ensureScanPage(page, options = {}) {
  const logger = options.logger || console;
  const input = getLogisticsInput(page);

  assertRecloudAuthenticated(page);
  let inputVisible = await input.isVisible().catch(() => false);
  if (
    (!inputVisible || !isScanQueryUrl(page.url())) &&
    typeof page.url === "function" &&
    typeof page.goto === "function" &&
    (() => {
      try {
        return new URL(page.url()).hostname.toLowerCase() ===
          "crm2.recloud.com.cn";
      } catch {
        return false;
      }
    })()
  ) {
    await page.goto(RECLOUD_URL, { waitUntil: "domcontentloaded" });
    assertRecloudAuthenticated(page);
    await input.waitFor({
      state: "visible",
      timeout: options.navigationTimeout ?? DEFAULT_TIMEOUT,
    });
    inputVisible = true;
    logRecloudStage("scan_page_reset", logger);
  }
  if (!inputVisible) {
    try {
      await input.waitFor({
        state: "visible",
        timeout: options.probeTimeout ?? SCAN_PAGE_PROBE_TIMEOUT,
      });
    } catch {
      try {
        const serviceManagement = await waitForVisibleText(
          page,
          "服务管理",
          options.navigationTimeout
        );
        await serviceManagement.click();

        const scanReceipt = await waitForVisibleText(
          page,
          "扫码签收",
          options.navigationTimeout
        );
        await scanReceipt.click();
        await input.waitFor({
          state: "visible",
          timeout: options.navigationTimeout ?? DEFAULT_TIMEOUT,
        });
      } catch {
        assertRecloudAuthenticated(page);
        throw new RecloudQueryError(
          "RECLOUD_SCAN_PAGE_UNAVAILABLE",
          "无法进入瑞云扫码签收页面",
          { status: 502, retryable: true }
        );
      }
    }
  }

  logRecloudStage("scan_page_ready", logger);
  return input;
}

function toQueryError(error) {
  if (error instanceof RecloudQueryError || error?.code === "RECLOUD_LOGIN_REQUIRED") {
    return error;
  }
  if (error?.name === "TimeoutError" || /timeout/i.test(String(error?.message || ""))) {
    return new RecloudQueryError("RECLOUD_QUERY_TIMEOUT", "瑞云工单查询超时", {
      status: 504,
      retryable: true,
    });
  }
  return error;
}

async function enterRmaQuery(page, logisticsNo, options = {}) {
  const value = normalizeText(logisticsNo);
  if (!value) throw new Error("缺少物流单号");

  const logger = options.logger || console;
  const input = await ensureScanPage(page, options);
  await input.click();
  await input.press(getSelectAllShortcut(options.platform));
  await input.press("Backspace");
  await input.pressSequentially(value, {
    delay: options.scannerKeyDelay ?? SCANNER_KEY_DELAY,
  });
  logRecloudStage("scanner_input_typed", logger);

  const actualValue = await input.inputValue();
  if (actualValue !== value) {
    throw new RecloudQueryError(
      "RECLOUD_LOGISTICS_FILL_FAILED",
      "瑞云物流单号输入校验失败",
      { status: 502, retryable: true }
    );
  }

  logRecloudStage("logistics_filled", logger);
  await page.waitForTimeout(options.enterSettleDelay ?? ENTER_SETTLE_DELAY);
  await page.keyboard.press("Enter");
  logRecloudStage("enter_pressed", logger);
  logRecloudStage("query_submitted", logger);
}

async function collectRtxpcFormItemPairs(page, options = {}) {
  const items = page.locator(".rtxpc-form-item");
  if (typeof items.count !== "function") return [];

  const pairs = [];
  const count = await items.count();
  for (let index = 0; index < count; index += 1) {
    const item = items.nth(index);
    const label = item
      .locator(
        "label, .rtxpc-form-item__label, [class*='form-item__label']"
      )
      .first();
    const title = normalizeText(
      (await item.getAttribute("fieldTitle")) ||
      (await item.getAttribute("field-title")) ||
      (await label.innerText().catch(() => ""))
    ).replace(/[：:]$/, "");
    if (!title) continue;

    const control = item.locator("input:visible, textarea:visible").first();
    let value = "";
    if (await control.isVisible().catch(() => false)) {
      value =
        title === "反馈电话"
          ? await revealFeedbackPhone(item, page, control, {
              enabled:
                options.revealPhoneEnabled ??
                isRevealPhoneEnabled(),
              timeout: options.phoneRevealTimeout,
              pollInterval: options.phoneRevealPollInterval,
              logger: options.phoneRevealLogger,
            })
          : normalizeText(await control.inputValue());
    } else {
      const content = item.locator(".rtxpc-form-item__content").first();
      value = normalizeText(await content.innerText().catch(() => ""));
      if (!value) {
        const itemText = normalizeText(await item.innerText().catch(() => ""));
        value = normalizeText(itemText.replace(title, ""));
      }
    }

    if (value) pairs.push([title, value]);
  }

  return pairs;
}

async function collectRtxpcFormItemPairsFast(page) {
  if (typeof page.evaluate !== "function") return null;
  return page.evaluate(() => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    return [...document.querySelectorAll(".rtxpc-form-item")]
      .filter((item) => {
        const box = item.getBoundingClientRect();
        const style = getComputedStyle(item);
        return box.width > 0 && box.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      })
      .map((item) => {
        const label = item.querySelector("label, .rtxpc-form-item__label, [class*='form-item__label']");
        const title = clean(item.getAttribute("fieldTitle") || item.getAttribute("field-title") || label?.textContent).replace(/[：:]$/, "");
        const control = item.querySelector("input, textarea");
        const content = item.querySelector(".rtxpc-form-item__content");
        const value = clean(control?.value || content?.textContent || clean(item.textContent).replace(title, ""));
        return title && value ? [title, value] : null;
      })
      .filter(Boolean);
  }).catch(() => null);
}

async function readProductLine(page, logger = console) {
  const fail = (reason) => {
    logger.warn?.(`RECLOUD_PRODUCT_LINE: failed ${reason}`);
    return "";
  };
  if (typeof page.getByText !== "function") return "";

  try {
    // Element UI gives every header/body cell in the same logical column a
    // shared generated class (for example el-table_2_xpc_column_19). Reading
    // through that class is more reliable than pairing the wide main table
    // with its fixed operation-column clone.
    if (typeof page.evaluate === "function") {
      const boundValue = await page.evaluate(() => {
        const visible = (element) => {
          const box = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return box.width > 0 && box.height > 0
            && style.display !== "none" && style.visibility !== "hidden";
        };
        const headers = [...document.querySelectorAll("th")]
          .filter((element) => visible(element) && element.innerText.trim() === "产品线");
        for (const header of headers) {
          const columnClass = [...header.classList].find((name) =>
            /^el-table_\d+_.+_column_\d+$/.test(name)
          );
          if (!columnClass) continue;
          const table = header.closest(".el-table") || document;
          const values = [...table.querySelectorAll(`td.${columnClass}`)]
            .filter(visible)
            .map((element) => element.innerText.replace(/\s+/g, " ").trim())
            .filter(Boolean);
          const uniqueValues = [...new Set(values)];
          if (uniqueValues.length === 1) return uniqueValues[0];
          const explicit = uniqueValues.filter((value) => value === "扫地机" || value === "洗地机");
          if (explicit.length === 1) return explicit[0];
        }
        return "";
      }).catch(() => "");
      if (boundValue) {
        logger.info?.("RECLOUD_PRODUCT_LINE: bound_column_value_ready");
        return normalizeText(boundValue);
      }
    }

    const marker = page
      .getByText("RMA明细", { exact: true })
      .filter({ visible: true })
      .first();
    if (!(await marker.isVisible().catch(() => false))) {
      return fail("RMA_DETAIL_REGION_NOT_FOUND");
    }
    await marker.scrollIntoViewIfNeeded?.().catch(() => {});
    await page.waitForTimeout?.(300);
    let region = marker
      .locator(
        "xpath=ancestor::*[.//*[normalize-space()='产品线'] and .//*[normalize-space()='签收']][1]"
      )
      .first();
    if (!(await region.isVisible().catch(() => false))) {
      // Recloud can render the wide body row and its pinned operation clone
      // in sibling layers, leaving no visible ancestor that owns both. The
      // coordinate match below still binds the value to the product header.
      region = page;
      logger.info?.("RECLOUD_PRODUCT_LINE: using_page_scope");
    }

    const header = region
      .getByText("产品线", { exact: true })
      .filter({ visible: true })
      .first();
    if (!(await header.isVisible().catch(() => false))) {
      return fail("HEADER_NOT_FOUND");
    }
    logger.info?.("RECLOUD_PRODUCT_LINE: header_found");

    const signCells = region
      .getByText("签收", { exact: true })
      .filter({ visible: true });
    const signCount = await signCells.count().catch(() => 0);
    if (signCount === 0) return fail("TARGET_ROW_NOT_FOUND");
    if (signCount > 1) {
      logger.warn?.("RECLOUD_PRODUCT_LINE: ambiguous_target_rows_using_first");
    }
    const signCell = signCells.first();
    const row = signCell
      .locator(
        "xpath=ancestor::tr[1]"
      )
      .first();
    const rowFound =
      typeof row.count === "function"
        ? (await row.count().catch(() => 0)) === 1
        : await row.isVisible().catch(() => false);
    if (!rowFound) {
      const visibleProductLines = [];
      for (const productLine of ["扫地机", "洗地机"]) {
        const values = region
          .getByText(productLine, { exact: true })
          .filter({ visible: true });
        if ((await values.count().catch(() => 0)) > 0) {
          visibleProductLines.push(productLine);
        }
      }
      if (visibleProductLines.length === 1) {
        logger.info?.("RECLOUD_PRODUCT_LINE: unique_visible_value");
        return visibleProductLines[0];
      }
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const regionText =
          typeof region.innerText === "function"
            ? await region.innerText().catch(() => "")
            : await region
                .locator("body")
                .innerText()
                .catch(() => "");
        const textProductLines = ["扫地机", "洗地机"].filter(
          (productLine) => regionText.includes(productLine)
        );
        if (textProductLines.length === 1) {
          logger.info?.("RECLOUD_PRODUCT_LINE: unique_region_text_value");
          return textProductLines[0];
        }
        if (attempt < 19) await page.waitForTimeout?.(500);
      }
      return fail("TARGET_ROW_NOT_FOUND");
    }
    logger.info?.("RECLOUD_PRODUCT_LINE: target_row_found");

    const headers = region.locator(
      "th:visible, [role='columnheader']:visible, [class*='header-cell']:visible"
    );
    const headerTexts = typeof headers.allInnerTexts === "function"
      ? await headers.allInnerTexts()
      : [];
    const productIndex = headerTexts.map(normalizeText).indexOf("产品线");
    const cells = row.locator(
      "td:visible, [role='gridcell']:visible, [role='cell']:visible, .el-table__cell:visible, [class*='grid-cell']:visible"
    );
    if (productIndex >= 0 && typeof cells.count === "function") {
      const cellCount = await cells.count();
      if (productIndex < cellCount) {
        const indexedValue = normalizeText(
          await cells.nth(productIndex).innerText().catch(() => "")
        );
        if (indexedValue && indexedValue !== "签收") {
          logger.info?.("RECLOUD_PRODUCT_LINE: value_ready");
          return indexedValue;
        }
      }
    }

    const headerBox = await header.boundingBox().catch(() => null);
    if (!headerBox || typeof cells.count !== "function") {
      return fail("COLUMN_MATCH_FAILED");
    }
    const cellModels = [];
    const cellCount = await cells.count();
    for (let index = 0; index < cellCount; index += 1) {
      const cell = cells.nth(index);
      if (!(await cell.isVisible().catch(() => false))) continue;
      cellModels.push({
        text: await cell.innerText().catch(() => ""),
        box: await cell.boundingBox().catch(() => null),
      });
    }
    const coordinateValue = selectCellByHeaderCoordinate(
      headerBox,
      cellModels
    );
    if (!coordinateValue) return fail("COLUMN_MATCH_FAILED");
    logger.info?.("RECLOUD_PRODUCT_LINE: value_ready");
    return coordinateValue;
  } catch {
    return fail("READ_ERROR");
  }
}

function selectCellByHeaderCoordinate(headerBox, cells) {
  if (!headerBox) return "";
  const centerX = headerBox.x + headerBox.width / 2;
  const matches = cells
    .filter(({ box }) =>
      box &&
      centerX >= box.x &&
      centerX <= box.x + box.width
    )
    .sort((left, right) => left.box.width - right.box.width);
  for (const match of matches) {
    const value = normalizeText(match.text);
    if (value && value !== "签收") return value;
  }
  return "";
}

async function readRmaDetail(page, logisticsNo = "", options = {}) {
  assertRecloudAuthenticated(page);
  const bodyText = await page.locator("body").innerText();
  const revealPhoneEnabled = options.revealPhoneEnabled ?? isRevealPhoneEnabled();
  const fastPairs = options.fastDomRead
    ? await collectRtxpcFormItemPairsFast(page)
    : null;
  const formItemPairs = fastPairs || await collectRtxpcFormItemPairs(page, {
    revealPhoneEnabled,
    phoneRevealTimeout: options.phoneRevealTimeout,
  });
  const productLine = await readProductLine(page);
  const textPairs = extractTextFieldPairs(bodyText);
  const projectCode = [...formItemPairs, ...textPairs]
    .find(([label]) => normalizeText(label).replace(/[：:]$/, "") === "项目号")?.[1] || "";
  return parseRmaFieldPairs([...formItemPairs, ...textPairs], logisticsNo, {
    rmaNoFromTitle: extractRmaNoFromTitle(bodyText),
    allowFullPhone: revealPhoneEnabled,
    productLine,
    projectCode,
    requirePickupLogisticsNo: options.requirePickupLogisticsNo,
  });
}

function inferProductLineFromCurrentOrder(detail = {}) {
  const text = [
    detail.productModel,
    detail.productName,
    detail.reportedFault,
  ].filter(Boolean).join(" ");
  if (/洗地机|无线洗地|\bH\d{1,3}\b/i.test(text)) return "洗地机";
  if (/扫地机|扫拖|扫地机器人|机器人|\b(?:S|X|R)\d{1,3}\b/i.test(text)) return "扫地机";
  return "";
}

async function readPendingListRow(page, rmaNo, options = {}) {
  const normalizedRmaNo = normalizeText(rmaNo).toUpperCase();
  if (!/^JXTH\d+$/i.test(normalizedRmaNo)) return null;
  await page.goto(RECLOUD_PENDING_LIST_URL, { waitUntil: "domcontentloaded" });
  assertRecloudAuthenticated(page);
  const input = page.locator('input[placeholder*="产品序列号/RMA单号"]').first();
  await input.waitFor({ state: "visible", timeout: options.navigationTimeout ?? DEFAULT_TIMEOUT });
  await input.fill(normalizedRmaNo);
  await input.press("Enter");
  const deadline = Date.now() + (options.metadataTimeout ?? 8000);
  while (Date.now() < deadline) {
    const row = await page.evaluate((targetRmaNo) => {
      const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const tables = [...document.querySelectorAll("table")];
      const headerTable = tables
        .filter((table) => [...table.querySelectorAll("th")].some((cell) => clean(cell.textContent) === "寄修单号"))
        .sort((left, right) => right.querySelectorAll("th").length - left.querySelectorAll("th").length)[0];
      const headers = headerTable
        ? [...headerTable.querySelectorAll("th")].map((cell) => clean(cell.textContent))
        : [];
      if (!headers.length) return null;
      for (const table of tables) {
        for (const tableRow of table.querySelectorAll("tbody tr")) {
          const cells = [...tableRow.querySelectorAll("td")].map((cell) => clean(cell.textContent));
          if (!cells.some((value) => value.toUpperCase() === targetRmaNo)) continue;
          return Object.fromEntries(headers.map((header, index) => [header, cells[index] || ""]));
        }
      }
      return null;
    }, normalizedRmaNo).catch(() => null);
    if (row) return row;
    await page.waitForTimeout(options.pollInterval ?? 200);
  }
  return null;
}

async function enrichRmaFromPendingList(page, detail, options = {}) {
  if (!detail?.rmaNo) return detail;
  let row = null;
  if (!detail.productLine || !detail.productModel || !detail.productSerialNo) {
    row = await readPendingListRow(page, detail.rmaNo, options).catch(() => null);
  }
  const enriched = {
    ...detail,
    logisticsNo: detail.logisticsNo || row?.["取件物流单号"] || "",
    pickupLogisticsNo: detail.pickupLogisticsNo || row?.["取件物流单号"] || "",
    reportedFault: detail.reportedFault || row?.["故障描述"] || "",
    productSerialNo: detail.productSerialNo || row?.["产品序列号"] || "",
    projectCode: detail.projectCode || row?.["项目号"] || "",
    productLine: detail.productLine || row?.["产品线"] || "",
    productModel: detail.productModel || row?.["产品名称"] || row?.["产品型号"] || "",
    pickupStatus: detail.pickupStatus || row?.["取件物流状态"] || "",
    customer: {
      ...(detail.customer || {}),
      name: detail.customer?.name || row?.["联系人"] || "",
      phoneMasked: detail.customer?.phoneMasked || row?.["联系电话"] || "",
    },
  };
  if (!enriched.productLine) {
    enriched.productLine = inferProductLineFromCurrentOrder(enriched);
  }
  return enriched;
}

function isScanQueryUrl(url) {
  try {
    return new URL(url).hash.includes("/scanSignin/query");
  } catch {
    return false;
  }
}

function getRmaDetailSignals(bodyText, options = {}) {
  const text = String(bodyText || "");
  const hasRmaText = /(^|[\s｜|])RMA(?=$|[\s｜|明细])/i.test(text);
  const hasRmaNumber = /JXTH\d+/i.test(text);
  const hasDetailSection = /产品信息|RMA\s*明细/i.test(text);
  const hasNearbyRmaNumber = /RMA[\s\S]{0,200}JXTH\d+/i.test(text);

  return {
    hasRmaText,
    hasRmaNumber,
    hasDetailSection,
    hasNearbyRmaNumber,
    scanInputHidden: options.scanInputHidden === true,
    leftScanQueryRoute: options.leftScanQueryRoute === true,
  };
}

function isRmaDetailReady(signals) {
  return (
    signals.scanInputHidden &&
    signals.hasRmaText &&
    signals.hasRmaNumber &&
    signals.hasDetailSection
  );
}

async function waitForRmaDetail(page, logisticsNo = "", options = {}) {
  const deadline = Date.now() + (options.timeout ?? DEFAULT_TIMEOUT);
  const logger = options.logger || console;
  let diagnosticsLogged = false;
  let enterRetried = false;
  const retryAt = Date.now() + (options.retryDelay ?? QUERY_RETRY_DELAY);

  while (Date.now() < deadline) {
    assertRecloudAuthenticated(page);

    const bodyText = await page.locator("body").innerText().catch(() => "");
    const queryInput = getLogisticsInput(page);
    const scanInputHidden = !(await queryInput.isVisible().catch(() => false));
    const signals = getRmaDetailSignals(bodyText, {
      scanInputHidden,
      leftScanQueryRoute: !isScanQueryUrl(page.url()),
    });

    if (isRmaDetailReady(signals)) {
      logRecloudStage("rma_detail_ready", logger);
      if (isDomDiagnosticsEnabled() && !diagnosticsLogged) {
        try {
          const fieldTitles = await collectSafeFieldTitles(page);
          logSafeFieldTitles(fieldTitles);
        } catch {
          console.warn(
            "RECLOUD_FIELD_TITLES:",
            JSON.stringify([])
          );
        }
        diagnosticsLogged = true;
      }
      return readRmaDetail(page, logisticsNo, options);
    }

    if (!enterRetried && Date.now() >= retryAt) {
      if (!scanInputHidden) {
        await page.keyboard.press("Enter");
        logRecloudStage("enter_retried", logger);
        enterRetried = true;
      }
    }

    if (/未找到|查询不到|暂无(?:相关)?工单|工单不存在/.test(bodyText)) {
      throw new RecloudQueryError(
        "RECLOUD_ORDER_NOT_FOUND",
        "没有查询到对应的瑞云 RMA 寄修单",
        { status: 404, retryable: false }
      );
    }

    await page.waitForTimeout(options.pollInterval ?? 200);
  }

  throw new RecloudQueryError("RECLOUD_QUERY_TIMEOUT", "瑞云工单查询超时", {
    status: 504,
    retryable: true,
  });
}

async function queryRmaByLogisticsNo(page, logisticsNo, options = {}) {
  try {
    await enterRmaQuery(page, logisticsNo, options);
    const detail = await waitForRmaDetail(page, logisticsNo, options);
    return await enrichRmaFromPendingList(page, detail, options);
  } catch (error) {
    throw toQueryError(error);
  }
}

function maskCompletePhone(phone) {
  return String(phone || "").replace(/^(1[3-9]\d)\d{4}(\d{4})$/, "$1****$2");
}

async function waitForPhoneQueryResult(page, phone, options = {}) {
  const isPhoneQuery = /^1[3-9]\d{9}$/.test(String(phone || "").trim());
  const matchedBy = options.queryMatchedBy || (isPhoneQuery ? "PHONE" : "IDENTIFIER");
  const deadline = Date.now() + (options.timeout ?? DEFAULT_TIMEOUT);
  while (Date.now() < deadline) {
    assertRecloudAuthenticated(page);
    const bodyText = await page.locator("body").innerText().catch(() => "");
    const queryInput = getLogisticsInput(page);
    const scanInputHidden = !(await queryInput.isVisible().catch(() => false));
    const signals = getRmaDetailSignals(bodyText, {
      scanInputHidden,
      leftScanQueryRoute: !isScanQueryUrl(page.url()),
    });
    if (isRmaDetailReady(signals)) {
      const detail = await readRmaDetail(page, "", {
        ...options,
        fastDomRead: true,
        revealPhoneEnabled: isPhoneQuery,
        requirePickupLogisticsNo: false,
      });
      if (!isPhoneQuery) return { ...detail, queryMatchedBy: matchedBy };
      const actualPhone = normalizeText(
        detail?.customer?.phoneMasked || detail?.phoneMasked || ""
      );
      const phoneMasked = maskCompletePhone(phone);
      const actualDigits = actualPhone.replace(/\D/g, "");
      const queriedDigits = String(phone || "").replace(/\D/g, "");
      const exactMatch = actualDigits.length === 11 && actualDigits === queriedDigits;
      if (!exactMatch) {
        throw new RecloudQueryError(
          "RECLOUD_PHONE_RESULT_MISMATCH",
          actualPhone.includes("*")
            ? "瑞云只返回了脱敏电话，无法确认是同一用户，请重新查询"
            : "瑞云返回的工单联系电话与查询号码不一致，请重新查询",
          { status: 409, retryable: true }
        );
      }
      return {
        ...detail,
        phoneMasked: actualPhone,
        customer: { ...(detail.customer || {}), phoneMasked: actualPhone },
        phoneVerified: true,
      };
    }

    const rows = await page.evaluate(() => {
      const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const headerRow = [...document.querySelectorAll("tr")].find((row) => {
        const labels = [...row.querySelectorAll("th")].map((cell) => clean(cell.textContent));
        return labels.includes("寄修单号") && labels.includes("产品序列号");
      });
      if (!headerRow) return [];
      const headers = [...headerRow.querySelectorAll("th")].map((cell) => clean(cell.textContent));
      return [...document.querySelectorAll("tr")].map((row) => {
        const cells = [...row.querySelectorAll("td")].map((cell) => clean(cell.textContent));
        if (!/^JXTH\d+$/i.test(cells[0] || "")) return null;
        return Object.fromEntries(headers.map((header, index) => [header, cells[index] || ""]));
      }).filter(Boolean);
    }).catch(() => []);

    if (rows.length > 0) {
      // The scan-sign list does not expose a complete phone per row. A list
      // returned after typing a phone therefore cannot prove that any row
      // belongs to that phone; accepting it caused product lines to cross
      // between unrelated orders.
      if (isPhoneQuery) {
        throw new RecloudQueryError(
          "RECLOUD_PHONE_RESULT_UNVERIFIED",
          "当前瑞云页面无法核对完整电话，已停止返回未验证工单",
          { status: 409, retryable: false }
        );
      }
      return {
        matches: rows.map((row) => ({
          rmaNo: row["寄修单号"] || row["RMA单号"] || "",
          logisticsNo: row["取件物流单号"] || "",
          pickupLogisticsNo: row["取件物流单号"] || "",
          productSerialNo: row["产品序列号"] || "",
          productLine: row["产品线"] || "",
          productModel: row["产品名称"] || "",
          pickupStatus: row["取件物流状态"] || "",
          ...(isPhoneQuery ? {
            phoneMasked: maskCompletePhone(phone),
            customer: { phoneMasked: maskCompletePhone(phone) },
          } : {}),
          queryMatchedBy: matchedBy,
          readOnly: true,
          summary: [row["产品名称"], row["取件物流状态"]].filter(Boolean).join("｜"),
        })),
        queryMatchedBy: matchedBy,
        readOnly: true,
      };
    }

    if (/未找到|查询不到|暂无(?:相关)?工单|工单不存在/.test(bodyText)) {
      throw new RecloudQueryError(
        "RECLOUD_ORDER_NOT_FOUND",
        "没有查询到对应的瑞云 RMA 寄修单",
        { status: 404, retryable: false }
      );
    }
    await page.waitForTimeout(options.pollInterval ?? 200);
  }
  throw new RecloudQueryError("RECLOUD_QUERY_TIMEOUT", "瑞云工单查询超时", {
    status: 504,
    retryable: true,
  });
}

async function enterHistoryPhoneQuery(page, phone, options = {}) {
  await page.goto(RECLOUD_HISTORY_QUERY_URL, { waitUntil: "domcontentloaded" });
  assertRecloudAuthenticated(page);
  const input = page.locator('input[placeholder="请输入设备序列号/手机号"]').first();
  await input.waitFor({ state: "visible", timeout: options.navigationTimeout ?? DEFAULT_TIMEOUT });
  await input.click();
  await input.fill("");
  // This page binds its lookup to Element UI's change event. Enter alone does
  // not submit it; typing followed by blur is what the real page expects.
  if (typeof input.pressSequentially === "function") {
    await input.pressSequentially(phone, { delay: 25 });
  } else {
    await input.fill(phone);
  }
  await input.press("Tab");
  const deadline = Date.now() + (options.timeout ?? DEFAULT_TIMEOUT);
  while (Date.now() < deadline) {
    assertRecloudAuthenticated(page);
    const bodyText = await page.locator("body").innerText().catch(() => "");
    const rmaNos = [...new Set((bodyText.match(/JXTH\d+/gi) || []).map((value) => value.toUpperCase()))];
    if (rmaNos.length) return rmaNos.slice(0, 20);
    if (/未找到|查询不到|暂无(?:相关)?工单|没有查询到|工单不存在/.test(bodyText)) return [];
    await page.waitForTimeout(options.pollInterval ?? 200);
  }
  throw new RecloudQueryError("RECLOUD_QUERY_TIMEOUT", "瑞云手机号查询超时", {
    status: 504,
    retryable: true,
  });
}

async function clickVisibleExactText(page, text) {
  return page.evaluate((targetText) => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const candidates = [...document.querySelectorAll("button,li,span,div,a")]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0
          && style.display !== "none" && style.visibility !== "hidden"
          && clean(element.textContent) === targetText;
      })
      .sort((left, right) => left.children.length - right.children.length);
    const target = candidates[0];
    if (!target) return false;
    HTMLElement.prototype.click.call(target);
    return true;
  }, text);
}

async function selectAllRmaListView(page, options = {}) {
  await page.goto(RECLOUD_PENDING_LIST_URL, { waitUntil: "domcontentloaded" });
  assertRecloudAuthenticated(page);
  await page.waitForTimeout(options.settleDelay ?? 800);
  if (await clickVisibleExactText(page, "更多")) {
    await page.waitForTimeout(150);
  }
  if (!(await clickVisibleExactText(page, "网点寄修明细"))) {
    throw new RecloudQueryError("RECLOUD_ALL_RMA_VIEW_MISSING", "无法打开瑞云网点寄修明细", {
      status: 503,
      retryable: true,
    });
  }
  await page.waitForTimeout(options.viewSettleDelay ?? 800);
}

async function enterAllRmaPhoneQuery(page, phone, options = {}) {
  await selectAllRmaListView(page, options);
  const filterButton = page.locator("button:has(.plat-icon-new-filter-lined)").filter({ visible: true }).first();
  await filterButton.waitFor({ state: "visible", timeout: options.navigationTimeout ?? DEFAULT_TIMEOUT });
  await filterButton.click();
  const phoneFilter = page.locator(".grid-form-filter-item").filter({ hasText: "联系电话" }).first();
  const input = phoneFilter.locator("input").first();
  await input.waitFor({ state: "visible", timeout: options.navigationTimeout ?? DEFAULT_TIMEOUT });
  await input.fill(phone);
  await page.getByRole("button", { name: "筛选", exact: true }).filter({ visible: true }).click();
  await page.waitForTimeout(options.filterSettleDelay ?? 900);
  const phoneSignature = getMaskedPhoneSignature(phone);
  const deadline = Date.now() + (options.timeout ?? DEFAULT_TIMEOUT);
  while (Date.now() < deadline) {
    assertRecloudAuthenticated(page);
    const result = await page.evaluate(() => {
      const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const tables = [...document.querySelectorAll("table")];
      const headers = tables.map((table) => [...table.querySelectorAll("thead th")].map((cell) => clean(cell.textContent)))
        .sort((left, right) => right.length - left.length)
        .find((items) => items.includes("寄修单号"));
      const bodyTable = tables
        .sort((left, right) => right.querySelectorAll("tbody tr:first-child td").length
          - left.querySelectorAll("tbody tr:first-child td").length)[0];
      if (!headers || !bodyTable) return { rows: [], loading: true };
      const rows = [...bodyTable.querySelectorAll("tbody tr")]
        .map((row) => {
          const cells = [...row.querySelectorAll("td")].map((cell) => clean(cell.textContent));
          return Object.fromEntries(headers.map((header, index) => [header, cells[index] || ""]));
        })
        .filter((row) => row["寄修单号"] || row["RMA单号"]);
      const bodyText = clean(document.body.textContent);
      return {
        rows,
        loading: /加载中|正在加载/.test(bodyText),
        empty: /暂无数据|未找到/.test(bodyText),
      };
    });
    const matchingRows = result.rows.filter((row) => {
      if (!phoneSignature) return false;
      const value = String(row["联系电话"] || "").replace(/\s+/g, "");
      return value.startsWith(phoneSignature.prefix) && value.endsWith(phoneSignature.suffix);
    });
    if (matchingRows.length) return matchingRows.slice(0, 50);
    if (result.empty && !result.loading) return [];
    await page.waitForTimeout(options.pollInterval ?? 150);
  }
  throw new RecloudQueryError("RECLOUD_QUERY_TIMEOUT", "瑞云工单查询超时", {
    status: 504,
    retryable: true,
  });
}

async function queryRmaByPhone(page, phone, options = {}) {
  try {
    const normalizedPhone = normalizeText(phone);
    if (!isCompleteMobilePhone(normalizedPhone)) {
      throw new RecloudQueryError("RECLOUD_PHONE_INVALID", "请输入完整手机号", {
        status: 400,
        retryable: false,
      });
    }
    const rows = await enterAllRmaPhoneQuery(page, normalizedPhone, options);
    if (!rows.length) {
      throw new RecloudQueryError("RECLOUD_ORDER_NOT_FOUND", "没有查询到该手机号对应的瑞云工单", {
        status: 404,
        retryable: false,
      });
    }
    if (rows.length > 1) {
      const matches = rows.map((row) => ({
        rmaNo: row["寄修单号"] || row["RMA单号"] || "",
        logisticsNo: row["取件物流单号"] || "",
        pickupLogisticsNo: row["取件物流单号"] || "",
        productSerialNo: row["产品序列号"] || "",
        productLine: row["产品线"] || "",
        productModel: row["产品名称"] || "",
        pickupStatus: row["取件物流状态"] || "",
        customer: {
          name: row["联系人"] || "",
          phoneMasked: normalizedPhone,
          regionAddress: [row["所属省份"], row["所属城市"]].filter(Boolean).join(" / "),
        },
        phoneMasked: normalizedPhone,
        phoneVerified: true,
        queryMatchedBy: "PHONE",
        readOnly: true,
        summary: [row["产品名称"], row["取件物流状态"]].filter(Boolean).join("｜"),
      }));
      return { matches, queryMatchedBy: "PHONE", phoneVerified: true, readOnly: true };
    }
    const matches = [];
    for (const row of rows) {
      const rmaNo = row["寄修单号"] || row["RMA单号"] || "";
      try {
        await enterRmaQuery(page, rmaNo, options);
        let detail = await waitForRmaDetail(page, rmaNo, {
          ...options,
          revealPhoneEnabled: false,
          requirePickupLogisticsNo: false,
        });
        detail = await enrichRmaFromPendingList(page, detail, options);
        matches.push({
          ...detail,
          phoneMasked: normalizedPhone,
          customer: { ...(detail.customer || {}), phoneMasked: normalizedPhone },
          phoneVerified: true,
          queryMatchedBy: "PHONE",
          readOnly: true,
          summary: [detail.productModel || detail.productLine, detail.pickupStatus]
            .filter(Boolean).join("｜"),
        });
      } catch (error) {
        if (error?.code === "RECLOUD_LOGIN_REQUIRED") throw error;
      }
    }
    if (!matches.length) {
      throw new RecloudQueryError("RECLOUD_ORDER_NOT_FOUND", "手机号已匹配，但未能读取对应寄修单资料", {
        status: 404,
        retryable: true,
      });
    }
    return matches.length === 1
      ? matches[0]
      : { matches, queryMatchedBy: "PHONE", phoneVerified: true, readOnly: true };
  } catch (error) {
    throw toQueryError(error);
  }
}

async function queryRmaByIdentifier(page, identifier, options = {}) {
  try {
    await enterRmaQuery(page, identifier, options);
    return await waitForPhoneQueryResult(page, identifier, {
      ...options,
      queryMatchedBy: options.queryMatchedBy || "IDENTIFIER",
    });
  } catch (error) {
    throw toQueryError(error);
  }
}

async function readPendingReceiptOrders(page, options = {}) {
  assertRecloudAuthenticated(page);
  await page.goto(RECLOUD_PENDING_LIST_URL, { waitUntil: 'domcontentloaded' });
  assertRecloudAuthenticated(page);
  await page.waitForTimeout(options.settleDelay ?? 1200);
  const orders = new Map();
  const existingRmaNos = new Set(options.existingRmaNos || []);
  const maxPages = options.maxPages ?? 500;
  const sinceTime = Date.parse(options.since || '');
  const dateFromTime = Date.parse(options.dateFrom || '');
  const parseRowTime = (row) => {
    const value = row['创建时间'] || row['寄修单创建时间'] || row['申请时间'] || row['日期'] || '';
    const normalized = String(value).trim().replace(/年|月/g, '-').replace(/日/g, '').replace(/\//g, '-');
    const explicitTime = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(normalized) ? normalized : `${normalized}+08:00`);
    if (Number.isFinite(explicitTime)) return explicitTime;
    return parseRmaDateTime(row['寄修单号'] || row['RMA单号']);
  };
  let scannedAll = true;
  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    if (options.shouldYield?.()) {
      scannedAll = false;
      break;
    }
    const rows = await page.evaluate(() => {
      const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const tables = [...document.querySelectorAll('table')];
      const headers = tables.map((table) => [...table.querySelectorAll('thead th')].map((cell) => clean(cell.textContent)))
        .sort((a, b) => b.length - a.length)
        .find((items) => items.includes('寄修单号') && items.includes('取件物流状态'));
      const bodyTable = tables.sort((a, b) => b.querySelectorAll('tbody tr:first-child td').length - a.querySelectorAll('tbody tr:first-child td').length)[0];
      if (!headers || !bodyTable) return [];
      return [...bodyTable.querySelectorAll('tbody tr')].map((row) => {
        const cells = [...row.querySelectorAll('td')].map((cell) => clean(cell.textContent));
        return Object.fromEntries(headers.map((header, index) => [header, cells[index] || '']));
      });
    });
    for (const row of rows) {
      const rowTime = parseRowTime(row);
      if (Number.isFinite(dateFromTime) && (!Number.isFinite(rowTime) || rowTime < dateFromTime)) continue;
      const signedAt = String(row['取件物流签收时间'] || '').trim();
      if (row['取件物流状态'] !== '已取件' || !['', '-', '--'].includes(signedAt)) continue;
      const rmaNo = row['寄修单号'] || row['RMA单号'];
      if (!rmaNo) continue;
      orders.set(rmaNo, {
        rmaNo,
        logisticsNo: row['取件物流单号'] || '',
        phone: row['联系电话'] || '',
        customerName: row['联系人'] || '',
        reportedFault: row['故障描述'] || '',
        sn: row['产品序列号'] || '',
        productLine: row['产品线'] || '',
        productModel: row['产品型号'] || '',
        technicianName: row['服务人员'] || row['维修师傅'] || '',
        pickupStatus: row['取件物流状态'] || '',
        sourceCreatedAt: row['创建时间'] || row['寄修单创建时间'] || row['申请时间'] || row['日期'] || (Number.isFinite(rowTime) ? new Date(rowTime).toISOString() : ''),
        source: 'RECLOUD_PENDING_RECEIPT',
      });
    }
    if (Number.isFinite(dateFromTime) && rows.length > 0) {
      const datedRows = rows.map(parseRowTime).filter(Number.isFinite);
      if (datedRows.length > 0 && datedRows.every((value) => value < dateFromTime)) break;
    }
    if (!options.catchUp && Number.isFinite(sinceTime) && rows.length > 0) {
      const rowTimes = rows.map(parseRowTime).filter(Number.isFinite);
      if (rowTimes.length > 0 && rowTimes.every((value) => value <= sinceTime)) {
        scannedAll = false;
        break;
      }
    }
    const next = page.locator('button.btn-next:not([disabled]), .btn-next:not(.is-disabled)').filter({ visible: true }).first();
    if (!(await next.isVisible().catch(() => false)) || await next.isDisabled().catch(() => true)) break;
    await next.click();
    await page.waitForTimeout(options.pageDelay ?? 350);
  }
  const activeRmaNos = [...orders.keys()];
  if (options.shouldYield?.()) {
    return { orders: [], activeRmaNos: null, fullSnapshot: false, yielded: true };
  }
  const prioritySignature = getMaskedPhoneSignature(options.priorityPhone || '');
  const priorityMatches = (order) => {
    if (!prioritySignature) return false;
    const value = String(order.phone || '').replace(/\s+/g, '');
    return value.startsWith(prioritySignature.prefix) && value.endsWith(prioritySignature.suffix);
  };
  const newOrders = [...orders.values()]
    .filter((order) => !existingRmaNos.has(order.rmaNo))
    .sort((left, right) => Number(priorityMatches(right)) - Number(priorityMatches(left)))
    // Keep the shared Recloud page available for foreground searches. Old
    // masked cache rows are repaired gradually instead of monopolising the
    // browser for several minutes in one sync cycle.
    .slice(0, options.maxPhoneDetailsPerRun ?? 1);
  const completedOrders = [];
  for (const order of newOrders) {
    if (options.shouldYield?.()) break;
    try {
      const detail = await queryRmaByLogisticsNo(page, order.logisticsNo || order.rmaNo, {
        revealPhoneEnabled: true,
        phoneRevealTimeout: options.phoneRevealTimeout ?? 3000,
        requirePickupLogisticsNo: false,
      });
      order.phone = detail?.customer?.phoneMasked || detail?.phoneMasked || order.phone;
      order.customerName = detail?.customer?.name || order.customerName;
      order.regionAddress = detail?.customer?.regionAddress || order.regionAddress || '';
      order.reportedFault = detail?.reportedFault || order.reportedFault;
      order.sn = detail?.productSerialNo || order.sn;
      order.productLine = detail?.productLine || order.productLine;
      order.productModel = detail?.productModel || order.productModel;
      if (!/^1[3-9]\d{9}$/.test(String(order.phone || '').trim())) {
        const error = new Error('完整联系电话读取失败');
        error.code = 'RECLOUD_FULL_PHONE_REQUIRED';
        throw error;
      }
      completedOrders.push(order);
      if (typeof options.onOrder === 'function') {
        await options.onOrder(order);
      }
      (options.logger || console).info?.(`PENDING_RECEIPT_BACKFILL: completed ${completedOrders.length}/${newOrders.length}`);
    } catch (error) {
      (options.logger || console).warn?.(`PENDING_RECEIPT_PHONE: failed ${error.code || 'UNKNOWN'}`);
    }
  }
  return { orders: completedOrders, activeRmaNos: scannedAll ? activeRmaNos : null, fullSnapshot: scannedAll };
}

async function resetAllRmaListFilters(page) {
  const filterButton = page.locator("button:has(.plat-icon-new-filter-lined)").filter({ visible: true }).first();
  if (!(await filterButton.isVisible().catch(() => false))) return;
  await filterButton.click();
  const resetButton = page.getByRole("button", { name: "重置", exact: true }).filter({ visible: true }).first();
  if (await resetButton.isVisible().catch(() => false)) {
    await resetButton.click();
    await page.waitForTimeout(300);
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(300);
  }
}

async function setRmaListPageSize(page, size = 100) {
  try {
    const paginationSize = page.locator(".el-pagination__sizes, .rtxpc-pagination__sizes").filter({ visible: true }).first();
    if (!(await paginationSize.isVisible().catch(() => false))) return false;
    await paginationSize.click();
    const option = page.getByText(`${size}条/页`, { exact: true }).filter({ visible: true }).first();
    if (!(await option.isVisible().catch(() => false))) {
      await page.keyboard.press("Escape").catch(() => {});
      return false;
    }
    await option.click();
    await page.waitForTimeout(600);
    return true;
  } catch {
    await page.keyboard.press("Escape").catch(() => {});
    return false;
  }
}

async function readRecentRmaOrders(page, options = {}) {
  assertRecloudAuthenticated(page);
  await selectAllRmaListView(page, options);
  await resetAllRmaListFilters(page);
  await setRmaListPageSize(page, options.pageSize ?? 100);
  const orders = new Map();
  const existingRmaNos = new Set(options.existingRmaNos || []);
  const maxPages = options.maxPages ?? 500;
  const maxRecords = options.maxRecords ?? 10000;
  const dateFromTime = Date.parse(options.dateFrom || "");
  const parseRowTime = (row) => {
    const value = row["寄修单创建时间"] || row["创建时间"] || "";
    const normalized = String(value).trim().replace(/年|月/g, "-").replace(/日/g, "").replace(/\//g, "-");
    const explicitTime = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(normalized) ? normalized : `${normalized}+08:00`);
    if (Number.isFinite(explicitTime)) return explicitTime;
    return parseRmaDateTime(row["寄修单号"] || row["RMA单号"]);
  };
  for (let pageNumber = 0; pageNumber < maxPages && orders.size < maxRecords; pageNumber += 1) {
    if (options.shouldYield?.()) break;
    const rows = await page.evaluate(() => {
      const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const tables = [...document.querySelectorAll("table")];
      const headers = tables.map((table) => [...table.querySelectorAll("thead th")].map((cell) => clean(cell.textContent)))
        .sort((left, right) => right.length - left.length)
        .find((items) => items.includes("寄修单号"));
      const bodyTable = tables
        .sort((left, right) => right.querySelectorAll("tbody tr:first-child td").length
          - left.querySelectorAll("tbody tr:first-child td").length)[0];
      if (!headers || !bodyTable) return [];
      return [...bodyTable.querySelectorAll("tbody tr")].map((row) => {
        const cells = [...row.querySelectorAll("td")].map((cell) => clean(cell.textContent));
        return Object.fromEntries(headers.map((header, index) => [header, cells[index] || ""]));
      });
    });
    let pageEntirelyOlder = rows.length > 0;
    for (const row of rows) {
      const rowTime = parseRowTime(row);
      if (!Number.isFinite(dateFromTime) || (Number.isFinite(rowTime) && rowTime >= dateFromTime)) {
        pageEntirelyOlder = false;
      }
      if (Number.isFinite(dateFromTime) && (!Number.isFinite(rowTime) || rowTime < dateFromTime)) continue;
      const rmaNo = row["寄修单号"] || row["RMA单号"] || "";
      if (!rmaNo) continue;
      orders.set(rmaNo, {
        rmaNo,
        logisticsNo: row["取件物流单号"] || "",
        phone: row["联系电话"] || "",
        customerName: row["联系人"] || "",
        regionAddress: [row["所属省份"], row["所属城市"]].filter(Boolean).join(" / "),
        reportedFault: "",
        sn: row["产品序列号"] || "",
        productLine: row["产品线"] || "",
        productModel: row["产品名称"] || "",
        technicianName: row["服务人员"] || row["维修师傅"] || "",
        pickupStatus: row["取件物流状态"] || "",
        sourceCreatedAt: row["寄修单创建时间"] || row["创建时间"] || (Number.isFinite(rowTime) ? new Date(rowTime).toISOString() : ""),
        source: "RECLOUD_RECENT_RMA_BACKFILL",
      });
      if (orders.size >= maxRecords) break;
    }
    if (pageEntirelyOlder) break;
    const next = page.locator("button.btn-next:not([disabled]), .btn-next:not(.is-disabled)").filter({ visible: true }).first();
    if (!(await next.isVisible().catch(() => false)) || await next.isDisabled().catch(() => true)) break;
    await next.click();
    await page.waitForTimeout(options.pageDelay ?? 350);
  }
  const pendingDetails = [...orders.values()].filter((order) => !existingRmaNos.has(order.rmaNo));
  const completedOrders = [];
  for (const order of pendingDetails) {
    if (options.shouldYield?.()) break;
    try {
      const detail = await queryRmaByLogisticsNo(page, order.logisticsNo || order.rmaNo, {
        revealPhoneEnabled: true,
        phoneRevealTimeout: options.phoneRevealTimeout ?? 5000,
        requirePickupLogisticsNo: false,
      });
      order.phone = detail?.customer?.phoneMasked || detail?.phoneMasked || order.phone;
      order.customerName = detail?.customer?.name || order.customerName;
      order.regionAddress = detail?.customer?.regionAddress || order.regionAddress;
      order.reportedFault = detail?.reportedFault || order.reportedFault;
      order.sn = detail?.productSerialNo || order.sn;
      order.productLine = detail?.productLine || order.productLine;
      order.productModel = detail?.productModel || order.productModel;
      order.technicianName = detail?.technicianName || order.technicianName;
      order.phoneVerified = /^1[3-9]\d{9}$/.test(String(order.phone || "").trim());
      if (!order.phoneVerified) throw Object.assign(new Error("完整联系电话读取失败"), { code: "RECLOUD_FULL_PHONE_REQUIRED" });
      completedOrders.push(order);
      if (typeof options.onOrder === "function") await options.onOrder(order);
      (options.logger || console).info?.(`RECLOUD_RMA_BACKFILL: completed ${completedOrders.length}/${pendingDetails.length}`);
    } catch (error) {
      (options.logger || console).warn?.(`RECLOUD_RMA_BACKFILL: failed ${error.code || "UNKNOWN"}`);
    }
  }
  return { orders: completedOrders, discovered: orders.size, pending: pendingDetails.length };
}

// 旧写操作兼容层。只读 V1 不调用这些函数。
const scanSign = enterRmaQuery;

async function getRepairDetail(page, logisticsNo = "") {
  return readRmaDetail(page, logisticsNo);
}

function locateDialogField(dialog, labels, placeholders) {
  const labelPattern = new RegExp(labels.join("|"), "i");
  const placeholderSelector = placeholders
    .map((item) => `input[placeholder*="${item}"], textarea[placeholder*="${item}"]`)
    .join(",");

  return {
    byLabel: dialog.getByLabel(labelPattern).first(),
    byPlaceholder: dialog.locator(placeholderSelector).first(),
  };
}

async function firstVisible(locators) {
  for (const locator of locators) {
    if (!locator) continue;
    if ((await locator.count()) > 0 && (await locator.isVisible().catch(() => false))) {
      return locator;
    }
  }
  return null;
}

function logReceiptInspection(stage, logger = console) {
  logger.info(`RECLOUD_RECEIPT_INSPECTION: ${stage}`);
}

async function activateReceiptDetailTabs(scope, page, logger = console) {
  const result = {
    productTabActivated: false,
    rmaTabActivated: false,
  };
  if (typeof scope.getByRole !== "function") return result;
  const exactText = scope
    .getByText("产品信息", { exact: true })
    .filter({ visible: true });
  const target = await firstVisible([
    scope
      .getByRole("tab", { name: "产品信息", exact: true })
      .filter({ visible: true }),
    exactText
      .locator(
        "xpath=ancestor-or-self::*[@role='tab' or contains(concat(' ', normalize-space(@class), ' '), ' el-tabs__item ')][1]"
      )
      .first(),
  ]);
  if (target) {
    result.productTabActivated = true;
    const selected = await target.getAttribute("aria-selected").catch(() => "");
    if (selected !== "true") {
      await target.scrollIntoViewIfNeeded?.().catch(() => {});
      await target.click({ timeout: 2000 }).catch(() => {});
      logReceiptInspection("productInfoActivated", logger);
      await page.waitForTimeout?.(300);
    }
  }
  return result;
}

async function prepareRmaDetailRegion(scope, page) {
  const firstActuallyVisible = async (locators) => {
    for (const locator of locators) {
      if (await locator.isVisible().catch(() => false)) return locator;
    }
    return null;
  };
  const marker = await firstActuallyVisible([
    scope
      .getByText("RMA明细", { exact: true })
      .filter({ visible: true })
      .first(),
    scope
      .getByText(/^\s*RMA\s*明细\s*$/)
      .filter({ visible: true })
      .first(),
  ]);
  if (!marker) return null;
  await marker.scrollIntoViewIfNeeded?.().catch(() => {});
  await page.waitForTimeout?.(200);

  const region = await firstActuallyVisible([
    marker
      .locator("xpath=ancestor::*[.//*[normalize-space()='操作']][1]")
      .first(),
    marker
      .locator(
        "xpath=following::*[self::table or @role='grid' or contains(@class,'table') or contains(@class,'grid')][1]"
      )
      .first(),
    marker
      .locator("xpath=ancestor::*[.//*[normalize-space()='签收']][1]")
      .first(),
  ]);
  if (!region) return null;
  await region.scrollIntoViewIfNeeded?.().catch(() => {});
  if (typeof region.evaluate === "function") {
    await region
      .evaluate((element) => {
        const nodes = [element, ...element.querySelectorAll("*")];
        for (const node of nodes) {
          if (node.scrollWidth > node.clientWidth + 2) {
            node.scrollLeft = node.scrollWidth;
            node.dispatchEvent(new Event("scroll", { bubbles: true }));
          }
        }
      })
      .catch(() => {});
  }
  await page.waitForTimeout?.(300);
  return region;
}

async function selectReceiptCandidate(candidates, options = {}) {
  const logisticsNo = normalizeText(options.logisticsNo);
  const productLine = normalizeText(options.productLine);
  const scored = [];
  for (const candidate of candidates) {
    const rowText =
      typeof candidate.row.innerText === "function"
        ? await candidate.row.innerText().catch(() => "")
        : "";
    const box =
      typeof candidate.entry.boundingBox === "function"
        ? await candidate.entry.boundingBox().catch(() => null)
        : null;
    let score = 0;
    if (logisticsNo && rowText.includes(logisticsNo)) score += 100;
    if (/待签收|未签收/.test(rowText)) score += 40;
    if (productLine && rowText.includes(productLine)) score += 20;
    if (await candidate.entry.isEnabled?.().catch(() => false)) score += 5;
    scored.push({ ...candidate, score, box });
  }
  scored.sort((left, right) => right.score - left.score);
  if (scored.length === 1) return scored[0];
  const best = scored[0];
  const tied = scored.filter((candidate) => candidate.score === best.score);
  if (tied.length === 1) return best;

  // Fixed-column tables can render a duplicate action at the same row position.
  const sameVisualRow =
    tied.every((candidate) => candidate.box && best.box) &&
    tied.every(
      (candidate) =>
        Math.abs(
          candidate.box.y + candidate.box.height / 2 -
            (best.box.y + best.box.height / 2)
        ) <= 4
    );
  if (sameVisualRow) return best;
  const error = receiptInspectionError(
    "RECLOUD_RECEIPT_ACTION_AMBIGUOUS",
    "RMA 明细中存在多个无法安全区分的签收入口",
    ["receiptForm.targetRow"]
  );
  throw error;
}

const RECEIPT_ROW_SELECTORS = [
  "tr",
  '[role="row"]',
  "[data-row-key]",
  ".el-table__row",
  ".table-row",
  ".grid-row",
  ".vxe-body--row",
  ".rtxpc-table__row",
];
const RECEIPT_ROW_SELECTOR = RECEIPT_ROW_SELECTORS.join(", ");

function safeReceiptOperationText(value) {
  return normalizeText(value) === "签收" ? "签收" : "";
}

async function findTargetReceiptRow(region, options = {}) {
  const rows = region.locator(RECEIPT_ROW_SELECTOR).filter({ visible: true });
  const count = await rows.count().catch(() => 0);
  const candidates = [];
  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    const text = await row.innerText().catch(() => "");
    if (!text || (/产品线/.test(text) && /操作/.test(text))) continue;
    const rowKey =
      (await row.getAttribute("data-row-key").catch(() => "")) ||
      (await row.getAttribute("row-key").catch(() => ""));
    const box = await row.boundingBox().catch(() => null);
    let score = 0;
    if (options.logisticsNo && text.includes(options.logisticsNo)) score += 100;
    if (/待签收|未签收/.test(text)) score += 40;
    if (options.productLine && text.includes(options.productLine)) score += 20;
    candidates.push({ row, index, rowKey, box, score });
  }
  if (candidates.length === 0) return null;
  candidates.sort((left, right) => right.score - left.score);
  if (candidates.length === 1) return candidates[0];
  if (candidates[0].score > candidates[1].score) return candidates[0];
  return null;
}

async function findCorrespondingOperationRows(region, target) {
  const rows = [target.row];
  const container = region
    .locator(
      "xpath=ancestor-or-self::*[.//*[contains(@class,'fixed-right') or contains(@class,'fixed__right') or contains(@class,'fixed-column')]][1]"
    )
    .first();
  const scope = (await container.isVisible().catch(() => false))
    ? container
    : region;
  if (target.rowKey) {
    const keyed = scope
      .locator(`[data-row-key="${target.rowKey}"], [row-key="${target.rowKey}"]`)
      .filter({ visible: true });
    const keyedCount = await keyed.count().catch(() => 0);
    for (let index = 0; index < keyedCount; index += 1) {
      rows.push(keyed.nth(index));
    }
  }
  const fixedRows = scope
      .locator(
      [
        ".el-table__fixed-right",
        ".el-table__fixed",
        ".fixed-right",
        '[class*="fixed"][class*="right"]',
      ]
        .flatMap((prefix) =>
          RECEIPT_ROW_SELECTORS.map((rowSelector) => `${prefix} ${rowSelector}`)
        )
        .join(", ")
    )
    .filter({ visible: true });
  const fixedCount = await fixedRows.count().catch(() => 0);
  if (target.index < fixedCount) rows.push(fixedRows.nth(target.index));
  for (let index = 0; index < fixedCount; index += 1) {
    const row = fixedRows.nth(index);
    const box = await row.boundingBox().catch(() => null);
    if (
      box &&
      target.box &&
      Math.abs(
        box.y + box.height / 2 -
          (target.box.y + target.box.height / 2)
      ) <= 4
    ) {
      rows.push(row);
    }
  }
  return rows;
}

async function diagnoseReceiptOperation(region, options = {}) {
  const target = await findTargetReceiptRow(region, options);
  if (!target) {
    return { targetFound: false, diagnostics: [], entry: null };
  }
  const rows = await findCorrespondingOperationRows(region, target);
  const diagnostics = [];
  const matches = [];
  const seenBoxes = new Set();
  const seenDiagnostics = new Set();
  for (const row of rows) {
    const elements = row
      .locator(
        [
          "button",
          "a",
          "span",
          "div",
          '[role="button"]',
          "[tabindex]",
          "[onclick]",
          '[style*="cursor: pointer"]',
          '[style*="cursor:pointer"]',
        ].join(", ")
      )
      .filter({ visible: true });
    const count = Math.min(await elements.count().catch(() => 0), 80);
    for (let index = 0; index < count; index += 1) {
      const element = elements.nth(index);
      const raw =
        typeof element.evaluate === "function"
          ? await element
              .evaluate((node) => ({
                tagName: node.tagName.toLowerCase(),
                role: node.getAttribute("role") || "",
                className:
                  typeof node.className === "string" ? node.className : "",
                title: node.getAttribute("title") || "",
                ariaLabel: node.getAttribute("aria-label") || "",
                dataTestId: node.getAttribute("data-testid") || "",
                text: (node.innerText || node.textContent || "").trim(),
              }))
              .catch(() => null)
          : null;
      if (!raw) continue;
      const visible = await element.isVisible().catch(() => false);
      const enabled =
        typeof element.isEnabled === "function"
          ? await element.isEnabled().catch(() => false)
          : true;
      let tooltip = "";
      if (
        !safeReceiptOperationText(raw.text) &&
        !safeReceiptOperationText(raw.title) &&
        !safeReceiptOperationText(raw.ariaLabel)
      ) {
        await element.hover?.({ timeout: 500 }).catch(() => {});
        const tooltipLocator = options.page
          ?.locator(
            '[role="tooltip"]:visible, .el-tooltip__popper:visible, .el-popper:visible'
          )
          .last();
        tooltip = tooltipLocator
          ? safeReceiptOperationText(
              typeof tooltipLocator.innerText === "function"
                ? await tooltipLocator.innerText().catch(() => "")
                : ""
            )
          : "";
      }
      const descriptor = {
        tagName: raw.tagName,
        role: raw.role,
        className: String(raw.className).slice(0, 160),
        title: safeReceiptOperationText(raw.title),
        ariaLabel: safeReceiptOperationText(raw.ariaLabel),
        dataTestId: String(raw.dataTestId).slice(0, 80),
        visible,
        enabled,
        text: safeReceiptOperationText(raw.text),
        tooltip,
      };
      const isReceipt = Boolean(
        descriptor.text ||
          descriptor.title ||
          descriptor.ariaLabel ||
          descriptor.tooltip
      );
      if (
        isReceipt ||
        ["button", "a"].includes(descriptor.tagName) ||
        descriptor.role === "button" ||
        /pointer/.test(descriptor.className)
      ) {
        const diagnosticKey = JSON.stringify(descriptor);
        if (!seenDiagnostics.has(diagnosticKey)) {
          seenDiagnostics.add(diagnosticKey);
          diagnostics.push(descriptor);
        }
      }
      if (isReceipt && visible && enabled) {
        const box = await element.boundingBox().catch(() => null);
        const key = box
          ? `${Math.round(box.x)}:${Math.round(box.y)}:${Math.round(
              box.width
            )}:${Math.round(box.height)}`
          : `element:${matches.length}`;
        if (!seenBoxes.has(key)) {
          seenBoxes.add(key);
          matches.push(element);
        }
      }
    }
  }
  return {
    targetFound: true,
    diagnostics,
    entry: matches.length === 1 ? matches[0] : null,
    ambiguous: matches.length > 1,
  };
}

async function collectOperationCellDiagnostics(cell, page) {
  const diagnostics = [];
  const matches = [];
  const seen = new Set();
  const elements = cell
    .locator(
      [
        "button",
        "a",
        "span",
        "div",
        '[role="button"]',
        "[tabindex]",
        "[onclick]",
        '[style*="cursor: pointer"]',
        '[style*="cursor:pointer"]',
      ].join(", ")
    )
    .filter({ visible: true });
  const count = Math.min(await elements.count().catch(() => 0), 60);
  for (let index = 0; index < count; index += 1) {
    const element = elements.nth(index);
    const raw = await element
      .evaluate((node) => ({
        tagName: node.tagName.toLowerCase(),
        role: node.getAttribute("role") || "",
        className: typeof node.className === "string" ? node.className : "",
        title: node.getAttribute("title") || "",
        ariaLabel: node.getAttribute("aria-label") || "",
        dataTestId: node.getAttribute("data-testid") || "",
        text: (node.innerText || node.textContent || "").trim(),
        cursorPointer: getComputedStyle(node).cursor === "pointer",
      }))
      .catch(() => null);
    if (!raw) continue;
    let tooltip = "";
    if (
      !safeReceiptOperationText(raw.text) &&
      !safeReceiptOperationText(raw.title) &&
      !safeReceiptOperationText(raw.ariaLabel)
    ) {
      await element.hover?.({ timeout: 500 }).catch(() => {});
      const tooltipLocator = page
        .locator(
          '[role="tooltip"]:visible, .el-tooltip__popper:visible, .el-popper:visible'
        )
        .last();
      tooltip = safeReceiptOperationText(
        await tooltipLocator.innerText().catch(() => "")
      );
    }
    const descriptor = {
      tagName: raw.tagName,
      role: raw.role,
      className: String(raw.className).slice(0, 160),
      title: safeReceiptOperationText(raw.title),
      ariaLabel: safeReceiptOperationText(raw.ariaLabel),
      dataTestId: String(raw.dataTestId).slice(0, 80),
      visible: await element.isVisible().catch(() => false),
      enabled:
        typeof element.isEnabled === "function"
          ? await element.isEnabled().catch(() => false)
          : true,
      cursorPointer: Boolean(raw.cursorPointer),
      actionTexts: [safeReceiptOperationText(raw.text)].filter(Boolean),
      tooltip: Boolean(tooltip),
    };
    const key = JSON.stringify(descriptor);
    if (!seen.has(key)) {
      seen.add(key);
      diagnostics.push(descriptor);
    }
    if (
      descriptor.visible &&
      descriptor.enabled &&
      (descriptor.actionTexts.includes("签收") ||
        descriptor.title === "签收" ||
        descriptor.ariaLabel === "签收" ||
        descriptor.tooltip)
    ) {
      matches.push(element);
    }
  }
  return {
    diagnostics,
    entry: matches.length === 1 ? matches[0] : null,
    ambiguous: matches.length > 1,
  };
}

async function diagnoseReceiptByCoordinates(region, options = {}) {
  const headerNames = ["产品序列号", "项目号", "产品线", "操作"];
  const headers = {};
  for (const name of headerNames) {
    const locator = region
      .getByText(name, { exact: true })
      .filter({ visible: true })
      .first();
    const box = await locator.boundingBox().catch(() => null);
    if (!box) {
      return {
        targetRowCandidateCount: 0,
        targetRowMatchedBy: [],
        fixedOperationRowMatched: false,
        operationDiagnostics: [],
        entry: null,
      };
    }
    headers[name] = {
      x: box.x + box.width / 2,
      y: box.y + box.height / 2,
    };
  }

  const cells = region
    .locator(
      [
        "td",
        '[role="cell"]',
        ".el-table__cell",
        ".vxe-body--column",
        ".rtxpc-table__cell",
        '[class*="table-cell"]',
        '[class*="grid-cell"]',
      ].join(", ")
    )
    .filter({ visible: true });
  const groups = [];
  const count = Math.min(await cells.count().catch(() => 0), 400);
  for (let index = 0; index < count; index += 1) {
    const cell = cells.nth(index);
    const box = await cell.boundingBox().catch(() => null);
    if (!box) continue;
    const centerY = box.y + box.height / 2;
    if (centerY <= Math.max(...Object.values(headers).map((item) => item.y)) + 4) {
      continue;
    }
    let group = groups.find((item) => Math.abs(item.centerY - centerY) <= 4);
    if (!group) {
      group = { centerY, cells: [] };
      groups.push(group);
    }
    group.cells.push({
      locator: cell,
      box,
      text: await cell.innerText().catch(() => ""),
    });
  }

  const cellAtHeader = (group, headerName) => {
    const x = headers[headerName].x;
    const covering = group.cells.filter(
      (cell) => cell.box.x <= x && cell.box.x + cell.box.width >= x
    );
    if (covering.length > 0) {
      covering.sort((left, right) => left.box.width - right.box.width);
      return covering[0];
    }
    const nearby = [...group.cells].sort(
      (left, right) =>
        Math.abs(left.box.x + left.box.width / 2 - x) -
        Math.abs(right.box.x + right.box.width / 2 - x)
    );
    return nearby[0] || null;
  };

  const allowedProductLines = Array.isArray(options.allowedProductLines)
    ? options.allowedProductLines
    : [];
  const identities = [];
  for (let rowIndex = 0; rowIndex < groups.length; rowIndex += 1) {
    const group = groups[rowIndex];
    const productCell = cellAtHeader(group, "产品线");
    const operationCell = cellAtHeader(group, "操作");
    if (!productCell || !operationCell) continue;
    const rowText = group.cells.map((cell) => cell.text).join(" ");
    const logisticsMatch = Boolean(
      options.logisticsNo && rowText.includes(options.logisticsNo)
    );
    const productLineMatch =
      allowedProductLines.length > 0 &&
      allowedProductLines.includes(normalizeText(productCell.text));
    const pendingStatus = /待签收|未签收/.test(rowText);
    const interactiveCount = await operationCell.locator
      .locator(
        'button, a, [role="button"], [tabindex], [onclick], [style*="cursor"]'
      )
      .filter({ visible: true })
      .count()
      .catch(() => 0);
    if (
      logisticsMatch ||
      productLineMatch ||
      pendingStatus ||
      interactiveCount > 0
    ) {
      identities.push({
        rowIndex,
        group,
        operationCell,
        logisticsMatch,
        productLineMatch,
        pendingStatus,
        interactiveCount,
        score:
          (logisticsMatch ? 1000 : 0) +
          (productLineMatch ? 100 : 0) +
          (pendingStatus ? 10 : 0) +
          (interactiveCount > 0 ? 1 : 0),
      });
    }
  }
  identities.sort((left, right) => right.score - left.score);
  const bestScore = identities[0]?.score;
  const finalists = identities.filter((item) => item.score === bestScore);
  if (finalists.length !== 1) {
    return {
      targetRowCandidateCount: finalists.length,
      targetRowMatchedBy: [],
      fixedOperationRowMatched: false,
      operationDiagnostics: [],
      entry: null,
    };
  }
  const target = finalists[0];
  const matchedBy = [
    target.logisticsMatch && "logisticsNo",
    target.productLineMatch && "productLine",
    target.pendingStatus && "pendingStatus",
    target.interactiveCount > 0 && "verticalCoordinate",
  ].filter(Boolean);
  const operation = await collectOperationCellDiagnostics(
    target.operationCell.locator,
    options.page
  );
  return {
    targetRowCandidateCount: 1,
    targetRowMatchedBy: matchedBy,
    fixedOperationRowMatched: target.interactiveCount > 0,
    operationDiagnostics: operation.diagnostics,
    entry: operation.entry,
  };
}

function sanitizeTableHeader(value) {
  const text = normalizeText(value).replace(/\s+/g, " ");
  if (!text || text.length > 24 || /\d{5,}/.test(text)) return "";
  return /^[\p{L}\s/()（）_-]+$/u.test(text) ? text : "";
}

async function collectReceiptTableContainers(scope, markerBox) {
  const selector = [
    "table",
    '[role="table"]',
    '[role="grid"]',
    ".el-table",
    ".rtxpc-table",
    ".vxe-table",
    '[class*="virtual"][class*="table"]',
    '[class*="fixed"][class*="right"]',
  ].join(", ");
  const raw = await scope.locator(selector).evaluateAll(
    (elements, marker) => {
      const visible = (element) => {
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          box.width > 0 &&
          box.height > 0
        );
      };
      const rowSelector = [
        "tbody tr",
        '[role="row"]',
        "[data-row-key]",
        ".el-table__row",
        ".rtxpc-table__row",
        ".vxe-body--row",
        '[class*="virtual"][class*="row"]',
      ].join(", ");
      const cellSelector = [
        "th",
        "td",
        '[role="columnheader"]',
        '[role="cell"]',
        ".el-table__cell",
        ".rtxpc-table__cell",
        ".vxe-header--column",
        ".vxe-body--column",
        '[class*="table-cell"]',
        '[class*="grid-cell"]',
      ].join(", ");
      const candidates = elements
        .filter(visible)
        .filter((element) => {
          const box = element.getBoundingClientRect();
          return (
            box.bottom >= marker.y - 100 &&
            box.top <= marker.y + 1800
          );
        });
      const roots = candidates
        .filter((element) => {
          const className =
            typeof element.className === "string" ? element.className : "";
          if (/fixed.*right|right.*fixed/i.test(className)) return true;
          return !candidates.some(
            (other) => other !== element && other.contains(element)
          );
        })
        .sort((left, right) => {
          const leftBox = left.getBoundingClientRect();
          const rightBox = right.getBoundingClientRect();
          return (
            Math.abs(leftBox.top - marker.y) -
            Math.abs(rightBox.top - marker.y)
          );
        })
        .slice(0, 12);
      return roots
        .map((element) => {
          const box = element.getBoundingClientRect();
          const headerNodes = [
            ...element.querySelectorAll(
              "th, [role='columnheader'], .el-table__header .cell, .rtxpc-table__header, .vxe-header--column"
            ),
          ].filter(visible);
          const headerBottom = headerNodes.reduce(
            (maximum, node) =>
              Math.max(maximum, node.getBoundingClientRect().bottom),
            box.top
          );
          let rows = [...element.querySelectorAll(rowSelector)]
            .filter(visible)
            .filter((row) => {
              const rowBox = row.getBoundingClientRect();
              return (
                rowBox.top >= headerBottom - 2 &&
                !row.querySelector(
                  "th, [role='columnheader'], .el-table__header"
                )
              );
            })
            .map((row) => {
              const rowBox = row.getBoundingClientRect();
              return {
                tagName: row.tagName.toLowerCase(),
                role: row.getAttribute("role") || "",
                className:
                  typeof row.className === "string"
                    ? row.className.slice(0, 160)
                    : "",
                rowKeyPresent: Boolean(
                  row.getAttribute("data-row-key") ||
                    row.getAttribute("row-key")
                ),
                y: Math.round(rowBox.y),
                height: Math.round(rowBox.height),
              };
            });
          if (rows.length === 0) {
            const yGroups = [];
            for (const cell of element.querySelectorAll(cellSelector)) {
              if (!visible(cell)) continue;
              const cellBox = cell.getBoundingClientRect();
              if (cellBox.top < headerBottom - 2) continue;
              const y = Math.round(cellBox.y);
              if (!yGroups.some((item) => Math.abs(item - y) <= 4)) {
                yGroups.push(y);
              }
            }
            rows = yGroups.map((y) => ({
              tagName: "virtual-row",
              role: "row",
              className: "",
              rowKeyPresent: false,
              y,
              height: 0,
            }));
          }
          return {
            tagName: element.tagName.toLowerCase(),
            role: element.getAttribute("role") || "",
            className:
              typeof element.className === "string"
                ? element.className.slice(0, 160)
                : "",
            fixedOperationContainer:
              /fixed.*right|right.*fixed/i.test(
                typeof element.className === "string"
                  ? element.className
                  : ""
              ),
            bounds: {
              x: Math.round(box.x),
              y: Math.round(box.y),
              width: Math.round(box.width),
              height: Math.round(box.height),
            },
            headers: headerNodes.map(
              (node) => (node.innerText || node.textContent || "").trim()
            ),
            rows,
          };
        });
    },
    { y: markerBox.y }
  );
  return raw.map((table, index) => ({
    tableIndex: index,
    tagName: table.tagName,
    role: table.role,
    className: table.className,
    fixedOperationContainer: table.fixedOperationContainer,
    bounds: table.bounds,
    headers: [...new Set(table.headers.map(sanitizeTableHeader).filter(Boolean))],
    visibleDataRowCount: table.rows.length,
    rows: table.rows,
  }));
}

async function diagnoseReceiptTableStructure(page, options = {}) {
  if (options.dryRun !== true || options.writeEnabled !== false) {
    const error = new Error("RMA 表格结构诊断只允许在严格只读模式下执行");
    error.code = "RECLOUD_RECEIPT_INSPECTION_UNSAFE";
    error.status = 403;
    throw error;
  }
  assertRecloudAuthenticated(page);

  const totalTimeout = Math.min(Number(options.tableTimeout) || 30000, 30000);
  const operationTimeout = Math.min(
    Number(options.operationTimeout) || 3000,
    3000
  );
  const deadline = Date.now() + totalTimeout;
  const result = {
    tabCandidateCount: 0,
    tabCandidates: [],
    productTabActivated: false,
    rmaSectionFound: false,
    rmaSectionBounds: null,
    tableContainerCount: 0,
    visibleHeaderTitles: [],
    visibleDataRowCount: 0,
    headerBounds: {},
    tableRootFound: false,
    tableRootTag: "",
    tableRootRole: "",
    tableRootClass: "",
    tableRootBounds: null,
    bodyContainerCount: 0,
    fixedLeftContainerCount: 0,
    fixedRightContainerCount: 0,
    mainRowCount: 0,
    fixedLeftRowCount: 0,
    fixedRightRowCount: 0,
    rowCandidates: [],
    targetRowCandidateCount: 0,
    targetRowMatchedBy: [],
    operationCellFound: false,
    diagnosticsStage: "product_tab_lookup",
    missingFields: ["receiptForm.productTab"],
    errorCode: "RECLOUD_RECEIPT_ACTION_NOT_FOUND",
  };
  const limited = async (work, fallback) => {
    const remaining = Math.max(0, deadline - Date.now());
    if (remaining === 0) return fallback;
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(work),
        new Promise((resolve) => {
          timer = setTimeout(
            () => resolve(fallback),
            Math.min(operationTimeout, remaining)
          );
        }),
      ]);
    } catch {
      return fallback;
    } finally {
      clearTimeout(timer);
    }
  };
  const count = (locator, cap) =>
    limited(async () => Math.min(await locator.count(), cap), 0);
  const visible = (locator) =>
    limited(() => locator.isVisible({ timeout: operationTimeout }), false);
  const bounds = (locator) => limited(() => locator.boundingBox(), null);
  const wait = (milliseconds) =>
    limited(() => page.waitForTimeout?.(milliseconds), undefined);

  const diagnose = async () => {
    const childFrames =
      typeof page.frames === "function"
        ? page
            .frames()
            .filter(
              (frame) =>
                typeof page.mainFrame !== "function" ||
                frame !== page.mainFrame()
            )
            .slice(0, 5)
        : [];
    const scopes = [page, ...childFrames];
    const rawCandidates = [];

    for (const scope of scopes) {
      const exactTexts = scope.getByText("产品信息", { exact: true });
      const textCount = await count(exactTexts, 20);
      for (let index = 0; index < textCount; index += 1) {
        const text = exactTexts.nth(index);
        if (!(await visible(text))) continue;
        const tabAncestor = text
          .locator(
            "xpath=ancestor-or-self::*[self::button or self::a or @role='tab' or contains(concat(' ', normalize-space(@class), ' '), ' el-tabs__item ') or (contains(@class,'rtxpc') and contains(@class,'tab'))][1]"
          )
          .first();
        rawCandidates.push({
          scope,
          locator: (await visible(tabAncestor)) ? tabAncestor : text,
        });
      }
    }

    const seen = new Set();
    const candidates = [];
    for (const item of rawCandidates.slice(0, 20)) {
      const structure = await limited(
        () =>
          item.locator.evaluate((element) => {
            const className =
              typeof element.className === "string" ? element.className : "";
            const ariaSelected = element.getAttribute("aria-selected") || "";
            return {
              tag: element.tagName.toLowerCase(),
              role: element.getAttribute("role") || "",
              class: className.slice(0, 160),
              ariaSelected,
              visible: true,
              active:
                ariaSelected === "true" ||
                /(^|\s)(?:is-)?active(?:\s|$)/i.test(className),
            };
          }),
        null
      );
      const box = await bounds(item.locator);
      if (!structure || !box) continue;
      const identity = [
        Math.round(box.x),
        Math.round(box.y),
        Math.round(box.width),
        Math.round(box.height),
      ].join(":");
      if (seen.has(identity)) continue;
      seen.add(identity);
      candidates.push({ ...item, structure });
    }
    result.tabCandidateCount = candidates.length;
    result.tabCandidates = candidates.map(({ structure }) => structure);

    const activeCandidates = candidates.filter(
      ({ structure }) => structure.active
    );
    let selectedScope;
    if (activeCandidates.length === 1) {
      result.productTabActivated = true;
      selectedScope = activeCandidates[0].scope;
    } else if (candidates.length === 1) {
      result.diagnosticsStage = "product_tab_activation";
      const candidate = candidates[0];
      const clicked = await limited(async () => {
        await candidate.locator.scrollIntoViewIfNeeded({
          timeout: operationTimeout,
        });
        await candidate.locator.click({ timeout: operationTimeout });
        return true;
      }, false);
      if (!clicked) return result;
      result.productTabActivated = true;
      selectedScope = candidate.scope;
    } else {
      result.diagnosticsStage =
        candidates.length > 1
          ? "product_tab_ambiguous"
          : "product_tab_not_found";
      return result;
    }

    result.diagnosticsStage = "rma_section_lookup";
    result.missingFields = ["receiptForm.rmaSection"];
    const scope = selectedScope || page;
    const headerNames = ["产品序列号", "项目号", "产品线", "操作"];
    let marker = null;

    for (
      let scrollIndex = 0;
      scrollIndex <= 6 && Date.now() < deadline;
      scrollIndex += 1
    ) {
      const markers = scope.getByText("RMA明细", { exact: true });
      const markerCount = await count(markers, 10);
      for (let index = 0; index < markerCount; index += 1) {
        const current = markers.nth(index);
        if (await visible(current)) {
          marker = current;
          break;
        }
      }
      const visibleHeaders = [];
      for (const title of headerNames) {
        const headers = scope.getByText(title, { exact: true });
        const headerCount = await count(headers, 10);
        for (let index = 0; index < headerCount; index += 1) {
          if (await visible(headers.nth(index))) {
            visibleHeaders.push(title);
            break;
          }
        }
      }
      result.visibleHeaderTitles = [...new Set(visibleHeaders)];
      if (
        marker ||
        result.visibleHeaderTitles.includes("产品线") ||
        result.visibleHeaderTitles.includes("操作")
      ) {
        break;
      }
      if (scrollIndex === 6) break;
      const scrolled = await limited(async () => {
        const mainScroller = scope
          .locator(
            "main:visible, [role='main']:visible, .el-main:visible, [class*='content']:visible"
          )
          .first();
        if (await mainScroller.isVisible({ timeout: operationTimeout })) {
          await mainScroller.evaluate((element) => {
            const distance = Math.min(
              600,
              Math.max(200, element.clientHeight * 0.7)
            );
            element.scrollBy({ top: distance, behavior: "auto" });
          });
        } else {
          await page.mouse?.wheel(0, 600);
        }
        return true;
      }, false);
      if (!scrolled) break;
      await wait(500);
    }

    if (marker) {
      result.rmaSectionFound = true;
      result.rmaSectionBounds = await bounds(marker);
      await limited(
        () => marker.scrollIntoViewIfNeeded({ timeout: operationTimeout }),
        undefined
      );
    } else if (result.visibleHeaderTitles.length > 0) {
      result.rmaSectionFound = true;
    }
    if (!result.rmaSectionFound) return result;

    result.diagnosticsStage = "header_structure_lookup";
    const headerLocators = {};
    for (const title of headerNames) {
      const headers = scope.getByText(title, { exact: true });
      const headerCount = await count(headers, 10);
      for (let index = 0; index < headerCount; index += 1) {
        const header = headers.nth(index);
        if (!(await visible(header))) continue;
        const headerBox = await bounds(header);
        if (!headerBox) continue;
        const structure = await limited(
          () =>
            header.evaluate((element) => {
              const allowedClass = String(element.className || "")
                .split(/\s+/)
                .filter((token) =>
                  /(?:^el-|rtxpc|table|grid|header|column|cell)/i.test(token)
                )
                .slice(0, 12)
                .join(" ");
              return {
                tag: element.tagName.toLowerCase(),
                role: element.getAttribute("role") || "",
                class: allowedClass,
              };
            }),
          null
        );
        if (!structure) continue;
        headerLocators[title] = header;
        result.headerBounds[title] = {
          ...structure,
          bounds: headerBox,
        };
        break;
      }
    }
    const anchor =
      headerLocators["产品序列号"] ||
      headerLocators["项目号"] ||
      headerLocators["产品线"] ||
      headerLocators["操作"];
    if (!anchor || Object.keys(headerLocators).length < 3) {
      result.missingFields = ["receiptForm.tableHeaders"];
      result.errorCode = "RECLOUD_RECEIPT_ACTION_NOT_FOUND";
      return result;
    }

    const collectSnapshot = async () =>
      limited(
        () =>
          anchor.evaluate(
            (headerElement, input) => {
              const {
                headerNames: targetHeaders,
                logisticsNo,
                productLine,
              } = input;
              const visibleElement = (element) => {
                const box = element.getBoundingClientRect();
                const style = getComputedStyle(element);
                return (
                  box.width > 0 &&
                  box.height > 0 &&
                  style.display !== "none" &&
                  style.visibility !== "hidden"
                );
              };
              const text = (element) =>
                String(element.innerText || element.textContent || "").trim();
              const classTokens = (element) =>
                String(element.className || "")
                  .split(/\s+/)
                  .filter((token) =>
                    /(?:^el-|rtxpc|table|grid|body|fixed|left|right|virtual|list|scroll|row)/i.test(
                      token
                    )
                  )
                  .slice(0, 16)
                  .join(" ");
              const safeBounds = (element) => {
                const box = element.getBoundingClientRect();
                return {
                  x: Math.round(box.x * 10) / 10,
                  y: Math.round(box.y * 10) / 10,
                  width: Math.round(box.width * 10) / 10,
                  height: Math.round(box.height * 10) / 10,
                };
              };
              const exactHeaderCount = (element) => {
                let found = 0;
                const nodes = [element, ...element.querySelectorAll("*")].slice(
                  0,
                  1500
                );
                for (const title of targetHeaders) {
                  if (
                    nodes.some(
                      (node) => visibleElement(node) && text(node) === title
                    )
                  ) {
                    found += 1;
                  }
                }
                return found;
              };

              let root = headerElement;
              for (let depth = 0; depth <= 8 && root; depth += 1) {
                const box = root.getBoundingClientRect();
                if (
                  box.width > 400 &&
                  box.height > 60 &&
                  exactHeaderCount(root) >= 3
                ) {
                  break;
                }
                root = root.parentElement;
              }
              if (!root || exactHeaderCount(root) < 3) return null;

              const containerSelector = [
                "table",
                "tbody",
                "[role='table']",
                "[role='grid']",
                "[role='rowgroup']",
                ".el-table",
                ".rtxpc-table",
                ".el-table__body-wrapper",
                "[class*='body']",
                "[class*='fixed']",
                "[class*='virtual']",
                "[class*='list']",
                "[class*='scroll']",
              ].join(",");
              const containers = [
                root,
                ...root.querySelectorAll(containerSelector),
              ]
                .slice(0, 200)
                .filter(visibleElement);
              const category = (element) => {
                const value = `${element.getAttribute("role") || ""} ${
                  element.className || ""
                }`.toLowerCase();
                if (/fixed[^ ]*(?:right)|right[^ ]*fixed/.test(value)) {
                  return "fixedRight";
                }
                if (/fixed[^ ]*(?:left)|left[^ ]*fixed/.test(value)) {
                  return "fixedLeft";
                }
                return "body";
              };
              const uniqueContainers = (name) =>
                containers.filter((element) => category(element) === name)
                  .length;

              const rowSelector = [
                "tbody tr",
                "[role='row']",
                "[data-row-key]",
                "[row-key]",
                "[aria-rowindex]",
                ".el-table__row",
                ".rtxpc-table__row",
                "[class*='virtual'][class*='row']",
                "[class*='list'][class*='item']",
              ].join(",");
              const operationHeader = [
                root,
                ...root.querySelectorAll("*"),
              ]
                .slice(0, 1500)
                .find(
                  (element) =>
                    visibleElement(element) && text(element) === "操作"
                );
              const operationX = operationHeader
                ? operationHeader.getBoundingClientRect().x +
                  operationHeader.getBoundingClientRect().width / 2
                : null;
              const rawRows = [...root.querySelectorAll(rowSelector)]
                .slice(0, 300)
                .filter(visibleElement);
              const seenRows = new Set();
              const rows = [];
              const counters = { body: 0, fixedLeft: 0, fixedRight: 0 };
              for (const element of rawRows) {
                const box = element.getBoundingClientRect();
                const rowText = text(element);
                if (
                  targetHeaders.some((title) => rowText === title) ||
                  targetHeaders.filter((title) => rowText.includes(title))
                    .length >= 3 ||
                  box.height <= 0
                ) {
                  continue;
                }
                const rowKey =
                  element.getAttribute("data-row-key") ||
                  element.getAttribute("row-key") ||
                  "";
                const ariaIndex = element.getAttribute("aria-rowindex") || "";
                const rowCategory = category(
                  element.closest(
                    "[class*='fixed'],[role='rowgroup'],tbody,[class*='body']"
                  ) || element
                );
                const identity = `${rowCategory}:${rowKey}:${ariaIndex}:${Math.round(
                  box.y
                )}`;
                if (seenRows.has(identity)) continue;
                seenRows.add(identity);
                counters[rowCategory] += 1;
                const interactive = [
                  ...element.querySelectorAll(
                    "button,a,[role='button'],[tabindex],[onclick]"
                  ),
                ]
                  .slice(0, 30)
                  .some(visibleElement);
                const coversOperation =
                  operationX !== null &&
                  box.x <= operationX &&
                  box.x + box.width >= operationX;
                rows.push({
                  category: rowCategory,
                  rowKey,
                  rowIndex: ariaIndex || counters[rowCategory],
                  y: Math.round((box.y + box.height / 2) * 10) / 10,
                  logisticsMatched:
                    Boolean(logisticsNo) && rowText.includes(logisticsNo),
                  productLineMatched:
                    Boolean(productLine) && rowText.includes(productLine),
                  pendingReceipt: /待签收|签收/.test(rowText),
                  operationCellExists:
                    rowCategory === "fixedRight" ||
                    interactive ||
                    coversOperation,
                });
              }

              const verticalScroller = containers.find((element) => {
                const style = getComputedStyle(element);
                return (
                  /(auto|scroll)/.test(style.overflowY) &&
                  element.scrollHeight > element.clientHeight + 2
                );
              });
              const horizontalScroller = containers.find((element) => {
                const style = getComputedStyle(element);
                return (
                  /(auto|scroll)/.test(style.overflowX) &&
                  element.scrollWidth > element.clientWidth + 2
                );
              });
              return {
                root: {
                  tag: root.tagName.toLowerCase(),
                  role: root.getAttribute("role") || "",
                  class: classTokens(root),
                  bounds: safeBounds(root),
                },
                containerCounts: {
                  body: uniqueContainers("body"),
                  fixedLeft: uniqueContainers("fixedLeft"),
                  fixedRight: uniqueContainers("fixedRight"),
                },
                rowCounts: counters,
                rows,
                canScrollVertically: Boolean(verticalScroller),
                canScrollHorizontally: Boolean(horizontalScroller),
                scrolled: false,
              };
            },
            {
              headerNames,
              logisticsNo: normalizeText(options.logisticsNo),
              productLine: normalizeText(options.productLine),
            }
          ),
        null
      );

    let snapshot = await collectSnapshot();
    for (
      let scrollIndex = 0;
      snapshot &&
      snapshot.rows.length === 0 &&
      snapshot.canScrollVertically &&
      scrollIndex < 6 &&
      Date.now() < deadline;
      scrollIndex += 1
    ) {
      await limited(
        () =>
          anchor.evaluate((headerElement) => {
            let element = headerElement.parentElement;
            for (let depth = 0; depth < 8 && element; depth += 1) {
              const style = getComputedStyle(element);
              if (
                /(auto|scroll)/.test(style.overflowY) &&
                element.scrollHeight > element.clientHeight + 2
              ) {
                element.scrollTop += 300;
                element.dispatchEvent(new Event("scroll", { bubbles: true }));
                return true;
              }
              element = element.parentElement;
            }
            return false;
          }),
        false
      );
      await wait(400);
      snapshot = await collectSnapshot();
    }
    if (snapshot?.canScrollHorizontally) {
      await limited(
        () =>
          anchor.evaluate((headerElement) => {
            let element = headerElement.parentElement;
            for (let depth = 0; depth < 8 && element; depth += 1) {
              const style = getComputedStyle(element);
              if (
                /(auto|scroll)/.test(style.overflowX) &&
                element.scrollWidth > element.clientWidth + 2
              ) {
                element.scrollLeft = element.scrollWidth;
                element.dispatchEvent(new Event("scroll", { bubbles: true }));
                return true;
              }
              element = element.parentElement;
            }
            return false;
          }),
        false
      );
      await wait(400);
      snapshot = await collectSnapshot();
    }

    if (!snapshot) {
      result.missingFields = ["receiptForm.tableRoot"];
      result.errorCode = "RECLOUD_RECEIPT_ACTION_NOT_FOUND";
      return result;
    }
    result.tableRootFound = true;
    result.tableRootTag = snapshot.root.tag;
    result.tableRootRole = snapshot.root.role;
    result.tableRootClass = snapshot.root.class;
    result.tableRootBounds = snapshot.root.bounds;
    result.bodyContainerCount = snapshot.containerCounts.body;
    result.fixedLeftContainerCount = snapshot.containerCounts.fixedLeft;
    result.fixedRightContainerCount = snapshot.containerCounts.fixedRight;
    result.mainRowCount = snapshot.rowCounts.body;
    result.fixedLeftRowCount = snapshot.rowCounts.fixedLeft;
    result.fixedRightRowCount = snapshot.rowCounts.fixedRight;

    const mainRows = snapshot.rows.filter((row) => row.category === "body");
    const fixedRows = snapshot.rows.filter(
      (row) => row.category === "fixedRight"
    );
    result.rowCandidates = mainRows.map((row) => {
      const fixedMatch = fixedRows.find(
        (fixed) =>
          (row.rowKey && fixed.rowKey === row.rowKey) ||
          (row.rowIndex && fixed.rowIndex === row.rowIndex) ||
          Math.abs(fixed.y - row.y) <= 4
      );
      return {
        rowKey: row.rowKey,
        rowIndex: row.rowIndex,
        y: row.y,
        logisticsMatched: row.logisticsMatched,
        productLineMatched: row.productLineMatched,
        pendingReceipt: row.pendingReceipt,
        operationCellExists:
          row.operationCellExists || Boolean(fixedMatch?.operationCellExists),
      };
    });
    const scoredRows = result.rowCandidates.map((row) => ({
      row,
      score:
        Number(row.logisticsMatched) * 4 +
        Number(row.pendingReceipt) * 2 +
        Number(row.productLineMatched),
    }));
    const bestScore = Math.max(0, ...scoredRows.map(({ score }) => score));
    const targets = scoredRows
      .filter(({ score }) => score > 0 && score === bestScore)
      .map(({ row }) => row);
    result.targetRowCandidateCount = targets.length;
    if (targets.length === 1) {
      const target = targets[0];
      result.targetRowMatchedBy = [
        ...(target.logisticsMatched ? ["logisticsNo"] : []),
        ...(target.pendingReceipt ? ["pendingReceipt"] : []),
        ...(target.productLineMatched ? ["productLine"] : []),
      ];
      result.operationCellFound = target.operationCellExists;
    }
    result.tableContainerCount =
      result.bodyContainerCount +
      result.fixedLeftContainerCount +
      result.fixedRightContainerCount;
    result.visibleDataRowCount = result.mainRowCount;
    result.diagnosticsStage = "complete";
    result.missingFields =
      targets.length === 1
        ? result.operationCellFound
          ? []
          : ["receiptForm.operationCell"]
        : ["receiptForm.targetRow"];
    result.errorCode =
      targets.length === 1 && result.operationCellFound
        ? null
        : "RECLOUD_RECEIPT_ACTION_NOT_FOUND";
    return result;
  };

  let hardTimeout;
  try {
    return await Promise.race([
      diagnose(),
      new Promise((resolve) => {
        hardTimeout = setTimeout(
          () =>
            resolve({
              ...result,
              diagnosticsStage: "timeout",
              missingFields: ["receiptForm.tableDiagnostics"],
              errorCode: "RECLOUD_RECEIPT_TABLE_DIAGNOSTICS_TIMEOUT",
            }),
          totalTimeout
        );
      }),
    ]);
  } finally {
    clearTimeout(hardTimeout);
  }
}

async function findPendingReceiptAction(page, logger = console, options = {}) {
  const scopes =
    typeof page.frames === "function" ? [page, ...page.frames()] : [page];
  const deadline = Date.now() + (options.actionTimeout ?? 10000);
  const activatedScopes = new Set();
  while (Date.now() < deadline) {
    const candidates = [];
    for (const scope of scopes) {
      if (!activatedScopes.has(scope)) {
        await activateReceiptDetailTabs(scope, page, logger);
        activatedScopes.add(scope);
      }
      const region = await prepareRmaDetailRegion(scope, page);
      if (!region) continue;
      const actions = region
        .getByText("签收", { exact: true })
        .filter({ visible: true });
      const count = await actions.count().catch(() => 0);

      for (let index = 0; index < count; index += 1) {
        const text = actions.nth(index);
        const row = text
          .locator(
            "xpath=ancestor::*[self::tr or @role='row' or @data-row-key or contains(concat(' ', normalize-space(@class), ' '), ' el-table__row ') or contains(concat(' ', normalize-space(@class), ' '), ' table-row ') or contains(concat(' ', normalize-space(@class), ' '), ' grid-row ') or contains(concat(' ', normalize-space(@class), ' '), ' vxe-body--row ') or contains(concat(' ', normalize-space(@class), ' '), ' rtxpc-table__row ') or contains(concat(' ', normalize-space(@class), ' '), ' row ')][1]"
          )
          .first();
        if (!(await row.isVisible().catch(() => false))) continue;
        const entry = await firstVisible([
          row.getByRole("button", { name: "签收", exact: true }),
          row.getByRole("link", { name: "签收", exact: true }),
          row
            .locator("button:visible, a:visible, [role='button']:visible")
            .filter({ hasText: /^签收$/ }),
          row.getByText("签收", { exact: true }).filter({ visible: true }),
        ]);
        if (entry) candidates.push({ row, entry });
      }
      if (count === 0) {
        const diagnosed = await diagnoseReceiptOperation(region, {
          ...options,
          page,
        });
        if (diagnosed.entry) {
          return {
            row: null,
            entry: diagnosed.entry,
            operationDiagnostics: diagnosed.diagnostics,
          };
        }
        if (diagnosed.targetFound) {
          options.lastOperationDiagnostics = diagnosed.diagnostics;
        }
        const coordinate = await diagnoseReceiptByCoordinates(region, {
          ...options,
          page,
        });
        options.lastReceiptLocator = {
          targetRowCandidateCount: coordinate.targetRowCandidateCount,
          targetRowMatchedBy: coordinate.targetRowMatchedBy,
          fixedOperationRowMatched: coordinate.fixedOperationRowMatched,
        };
        if (coordinate.entry) {
          return {
            row: null,
            entry: coordinate.entry,
            operationDiagnostics: coordinate.operationDiagnostics,
            receiptLocator: options.lastReceiptLocator,
          };
        }
        if (coordinate.operationDiagnostics.length > 0) {
          options.lastOperationDiagnostics = coordinate.operationDiagnostics;
        }
      }
    }
    if (candidates.length > 0) {
      if (candidates.length > 1) {
        logger.warn?.("RECLOUD_RECEIPT_INSPECTION: multiple_candidates");
      }
      return selectReceiptCandidate(candidates, options);
    }
    await page.waitForTimeout?.(250);
  }
  if (options.lastOperationDiagnostics) {
    const error = receiptInspectionError(
      "RECLOUD_RECEIPT_ACTION_NOT_FOUND",
      "未找到 RMA 明细中的待处理签收操作",
      ["receiptForm.entry"]
    );
    error.operationDiagnostics = options.lastOperationDiagnostics;
    error.receiptLocator = options.lastReceiptLocator;
    throw error;
  }
  return null;
}

async function diagnoseFixedReceiptOperation(page, options = {}) {
  if (options.dryRun !== true || options.writeEnabled !== false) {
    const error = new Error("固定操作列诊断只允许在严格只读模式下执行");
    error.code = "RECLOUD_RECEIPT_INSPECTION_UNSAFE";
    error.status = 403;
    throw error;
  }
  assertRecloudAuthenticated(page);
  const operationTimeout = Math.min(
    Number(options.operationTimeout) || 3000,
    3000
  );
  const deadline = Date.now() + Math.min(
    Number(options.diagnosticTimeout) || 30000,
    30000
  );
  const base = {
    targetMainRowIndex: 1,
    targetMainRowTop: null,
    targetMainRowBottom: null,
    targetMainRowHeight: null,
    targetMainRowCenterY: null,
    fixedRightContainerFound: false,
    fixedRightContainerTag: "",
    fixedRightContainerClass: "",
    fixedRightContainerBounds: null,
    directChildCount: 0,
    descendantElementCount: 0,
    visibleDescendantCount: 0,
    descendantTagCounts: {},
    roleCounts: {},
    elementsWithTabindexCount: 0,
    elementsWithOnclickCount: 0,
    pointerInteractiveElementCount: 0,
    visibleNodeSummaries: [],
    fixedStructureType: "",
    fixedVisibleCandidateCount: 0,
    fixedIntersectingCandidateCount: 0,
    fixedRightRowCandidateCount: 0,
    fixedRightRowMatched: false,
    fixedRightRowMatchedBy: "",
    fixedRightRowCenterDelta: null,
    fixedRightRowBounds: null,
    operationCellFound: false,
    operationCellBounds: null,
    operationControlCandidateCount: 0,
    operationControlCandidates: [],
    operationCellTree: [],
    pointHitDiagnostics: [],
    operationCellVisibleTextIsReceipt: false,
    operationCellVisibleTextContainsReceipt: false,
    operationCellAccessibleNameIsReceipt: false,
    operationCellCursor: "",
    operationCellPointerEvents: "",
    operationCellRole: "",
    operationCellTabIndex: "",
    operationCellPseudoReceiptFound: false,
    descendantNodeCount: 0,
    exactReceiptCandidateCount: 0,
    semanticInteractiveCandidateCount: 0,
    pointerCandidateCount: 0,
    pointHitCandidateCount: 0,
    delegatedCellCandidate: false,
    uniqueReceiptControlFound: false,
    uniqueReceiptControlMatchedBy: "",
    uniqueReceiptControlNodeIndex: null,
    uniqueReceiptControlBounds: null,
    overlayDetected: false,
    diagnosticsStage: "fixed_structure",
    clicked: false,
    dialogOpened: false,
    blockedRequestCount: 0,
    confirmClicked: false,
    missingFields: [],
    errorCode: null,
  };
  const limited = async (work, fallback) => {
    const remaining = Math.max(0, deadline - Date.now());
    if (remaining === 0) return fallback;
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(work),
        new Promise((resolve) => {
          timer = setTimeout(
            () => resolve(fallback),
            Math.min(operationTimeout, remaining)
          );
        }),
      ]);
    } catch {
      return fallback;
    } finally {
      clearTimeout(timer);
    }
  };
  const scopes =
    typeof page.frames === "function"
      ? [page, ...page.frames().filter((frame) => frame !== page.mainFrame?.())]
      : [page];
  for (const scope of scopes.slice(0, 6)) {
    const headers = scope.getByText(/^(产品序列号|操作)$/);
    const headerCount = await limited(
      async () => Math.min(await headers.count(), 10),
      0
    );
    for (let index = 0; index < headerCount; index += 1) {
      const header = headers.nth(index);
      if (!(await limited(() => header.isVisible(), false))) continue;
      const root = header
        .locator(
          "xpath=ancestor::*[self::table or @role='table' or @role='grid' or contains(concat(' ', normalize-space(@class), ' '), ' el-table ') or contains(concat(' ', normalize-space(@class), ' '), ' rtxpc-table ')][last()]"
        )
        .first();
      if (!(await limited(() => root.isVisible(), false))) continue;
      const result = await limited(
        () =>
          root.evaluate(
            (tableRoot, input) => {
              const visible = (element) => {
                const box = element.getBoundingClientRect();
                const style = getComputedStyle(element);
                return (
                  box.width > 0 &&
                  box.height > 0 &&
                  style.display !== "none" &&
                  style.visibility !== "hidden"
                );
              };
              const bounds = (element) => {
                const box = element.getBoundingClientRect();
                return {
                  x: Math.round(box.x * 10) / 10,
                  y: Math.round(box.y * 10) / 10,
                  width: Math.round(box.width * 10) / 10,
                  height: Math.round(box.height * 10) / 10,
                };
              };
              const className = (element) =>
                String(element.className || "")
                  .split(/\s+/)
                  .slice(0, 16)
                  .join(" ");
              const text = (element) =>
                String(element.innerText || element.textContent || "");
              const rowSelector = [
                "tbody tr",
                "[role='row']",
                "[data-row-key]",
                "[row-key]",
                "[aria-rowindex]",
                ".el-table__row",
                ".rtxpc-table__row",
                "[class*='virtual'][class*='row']",
              ].join(",");
              const rows = [...tableRoot.querySelectorAll(rowSelector)]
                .slice(0, 300)
                .filter(visible)
                .map((element) => {
                  const box = element.getBoundingClientRect();
                  const value = text(element);
                  return {
                    element,
                    rowKey:
                      element.getAttribute("data-row-key") ||
                      element.getAttribute("row-key") ||
                      "",
                    ariaRowIndex:
                      element.getAttribute("aria-rowindex") || "",
                    top: box.y,
                    bottom: box.y + box.height,
                    height: box.height,
                    centerY: box.y + box.height / 2,
                    pendingReceipt: /待签收|签收/.test(value),
                    header:
                      input.headerNames.filter((title) =>
                        value.includes(title)
                      ).length >= 3,
                  };
                })
                .filter((row) => !row.header && row.height > 0);
              const uniqueRows = [];
              const rowSeen = new Set();
              for (const row of rows.sort(
                (left, right) => left.centerY - right.centerY
              )) {
                const identity = `${row.rowKey}:${row.ariaRowIndex}:${Math.round(
                  row.centerY
                )}`;
                if (rowSeen.has(identity)) continue;
                rowSeen.add(identity);
                uniqueRows.push(row);
              }
              if (
                uniqueRows.length === 0 &&
                Number.isFinite(input.targetCenterY)
              ) {
                const geometryGroups = [];
                const cells = [
                  ...tableRoot.querySelectorAll(
                    "td,[role='gridcell'],.el-table__cell,[class*='cell']"
                  ),
                ]
                  .slice(0, 2000)
                  .filter(visible);
                for (const cell of cells) {
                  const box = cell.getBoundingClientRect();
                  if (
                    input.targetCenterY < box.y ||
                    input.targetCenterY > box.y + box.height
                  ) {
                    continue;
                  }
                  if (
                    !geometryGroups.some(
                      (group) =>
                        Math.abs(group.top - box.y) <= 2 &&
                        Math.abs(group.height - box.height) <= 2
                    )
                  ) {
                    geometryGroups.push({
                      top: box.y,
                      bottom: box.y + box.height,
                      height: box.height,
                      centerY: box.y + box.height / 2,
                    });
                  }
                }
                if (geometryGroups.length === 1) {
                  uniqueRows.push({
                    ...geometryGroups[0],
                    rowKey: "",
                    ariaRowIndex: "",
                    pendingReceipt: true,
                  });
                }
              }
              uniqueRows.forEach((row, rowIndex) => {
                row.rowIndex = rowIndex + 1;
              });
              let targets;
              if (Number.isFinite(input.targetCenterY)) {
                const minimumDelta = Math.min(
                  ...uniqueRows.map((row) =>
                    Math.abs(row.centerY - input.targetCenterY)
                  )
                );
                targets = uniqueRows.filter(
                  (row) =>
                    Math.abs(
                      Math.abs(row.centerY - input.targetCenterY) -
                        minimumDelta
                    ) <= 1
                );
                if (targets.length > 1) {
                  const top = Math.min(...targets.map((row) => row.top));
                  const bottom = Math.max(
                    ...targets.map((row) => row.bottom)
                  );
                  targets = [
                    {
                      rowKey: "",
                      ariaRowIndex: "",
                      rowIndex: input.rowIndex,
                      top,
                      bottom,
                      height: bottom - top,
                      centerY: input.targetCenterY,
                      pendingReceipt: true,
                    },
                  ];
                }
              } else {
                targets = uniqueRows.filter(
                  (row) =>
                    row.rowIndex === input.rowIndex && row.pendingReceipt
                );
              }
              if (targets.length !== 1) return null;
              const target = targets[0];
              const fixedSelector = [
                ".el-table__fixed-right",
                ".el-table__fixed-right-wrapper",
                ".rtxpc-table__fixed-right",
                "[class*='fixed-right']",
                "[class*='fixedRight']",
                "[class*='fixed'][class*='right']",
              ].join(",");
              const fixedContainers = [
                ...tableRoot.querySelectorAll(fixedSelector),
              ]
                .slice(0, 30)
                .filter(visible);
              if (fixedContainers.length === 0) {
                return {
                  target,
                  fixedRightContainerFound: false,
                  errorCode: "RECLOUD_RECEIPT_FIXED_RIGHT_NOT_FOUND",
                };
              }
              const container = fixedContainers.reduce((smallest, current) => {
                const currentBox = current.getBoundingClientRect();
                const smallestBox = smallest.getBoundingClientRect();
                return currentBox.width * currentBox.height <
                  smallestBox.width * smallestBox.height
                  ? current
                  : smallest;
              });
              const descendants = [
                ...container.querySelectorAll("*"),
              ].slice(0, 5000);
              const visibleDescendants = descendants.filter(visible);
              const tagCounts = {};
              const roleCounts = {};
              let tabindexCount = 0;
              let onclickCount = 0;
              let pointerCount = 0;
              for (const element of descendants) {
                const tag = element.tagName.toLowerCase();
                tagCounts[tag] = (tagCounts[tag] || 0) + 1;
                const role = element.getAttribute("role") || "";
                if (role) roleCounts[role] = (roleCounts[role] || 0) + 1;
                if (element.hasAttribute("tabindex")) tabindexCount += 1;
                if (element.hasAttribute("onclick")) onclickCount += 1;
                const style = getComputedStyle(element);
                if (
                  visible(element) &&
                  style.pointerEvents !== "none" &&
                  (style.cursor === "pointer" ||
                    ["button", "a"].includes(tag) ||
                    role === "button" ||
                    element.hasAttribute("tabindex") ||
                    element.hasAttribute("onclick"))
                ) {
                  pointerCount += 1;
                }
              }
              const intersects = (element) => {
                const box = element.getBoundingClientRect();
                return (
                  Math.min(target.bottom, box.y + box.height) -
                    Math.max(target.top, box.y) >
                  0
                );
              };
              const summaries = visibleDescendants
                .slice(0, 30)
                .map((element) => {
                  const style = getComputedStyle(element);
                  return {
                    tag: element.tagName.toLowerCase(),
                    role: element.getAttribute("role") || "",
                    className: className(element),
                    ariaLabelPresent: element.hasAttribute("aria-label"),
                    titlePresent: element.hasAttribute("title"),
                    tabindex: element.getAttribute("tabindex") || "",
                    cursor: style.cursor,
                    pointerEvents: style.pointerEvents,
                    bounds: bounds(element),
                    childCount: element.children.length,
                    intersectsTargetY: intersects(element),
                  };
                });
              const interactiveSelector = [
                "button",
                "a",
                "[role='button']",
                "[tabindex]",
                "[onclick]",
                "[title]",
                "[aria-label]",
                "span",
                "div",
              ].join(",");
              const structuralSelector = [
                "tr",
                "[role='row']",
                "[data-row-key]",
                "[row-key]",
                "[aria-rowindex]",
                ".el-table__row",
                "[class*='row']",
                "[class*='cell']",
                "[class*='fixed']",
                "[class*='body']",
              ].join(",");
              const structural = [
                container,
                ...container.querySelectorAll(structuralSelector),
              ]
                .slice(0, 1000)
                .filter(visible);
              const candidates = [];
              const candidateSeen = new Set();
              for (const element of structural) {
                if (!intersects(element)) continue;
                const box = element.getBoundingClientRect();
                const identity = `${Math.round(box.x)}:${Math.round(
                  box.y
                )}:${Math.round(box.width)}:${Math.round(box.height)}`;
                if (candidateSeen.has(identity)) continue;
                candidateSeen.add(identity);
                const owner = element.closest(
                  "[data-row-key],[row-key],[aria-rowindex]"
                );
                const interactive = [
                  ...element.querySelectorAll(interactiveSelector),
                ]
                  .slice(0, 100)
                  .filter((node) => {
                    const style = getComputedStyle(node);
                    return (
                      visible(node) &&
                      style.pointerEvents !== "none" &&
                      (style.cursor === "pointer" ||
                        ["button", "a"].includes(
                          node.tagName.toLowerCase()
                        ) ||
                        node.getAttribute("role") === "button" ||
                        node.hasAttribute("tabindex") ||
                        node.hasAttribute("onclick") ||
                        node.hasAttribute("title") ||
                        node.hasAttribute("aria-label"))
                    );
                  });
                candidates.push({
                  element,
                  rowKey:
                    owner?.getAttribute("data-row-key") ||
                    owner?.getAttribute("row-key") ||
                    "",
                  ariaRowIndex:
                    owner?.getAttribute("aria-rowindex") || "",
                  box,
                  centerDelta: Math.abs(
                    box.y + box.height / 2 - target.centerY
                  ),
                  interactiveCount: interactive.length,
                });
              }
              candidates.sort(
                (left, right) => left.centerDelta - right.centerDelta
              );
              let matchedBy = "";
              let matches = [];
              if (target.rowKey) {
                matches = candidates.filter(
                  (candidate) => candidate.rowKey === target.rowKey
                );
                if (matches.length > 0) matchedBy = "rowKey";
              }
              if (matches.length === 0 && target.ariaRowIndex) {
                matches = candidates.filter(
                  (candidate) =>
                    candidate.ariaRowIndex === target.ariaRowIndex
                );
                if (matches.length > 0) matchedBy = "ariaRowIndex";
              }
              if (matches.length === 0 && candidates.length > 0) {
                const minimumDelta = candidates[0].centerDelta;
                matches = candidates.filter(
                  (candidate) =>
                    Math.abs(candidate.centerDelta - minimumDelta) <= 1
                );
                if (matches.length > 0) matchedBy = "verticalGeometry";
              }
              if (matches.length > 1) {
                const interactiveMatches = matches.filter(
                  (candidate) => candidate.interactiveCount > 0
                );
                if (interactiveMatches.length === 1) {
                  matches = interactiveMatches;
                  matchedBy = "uniqueInteractiveGeometry";
                } else {
                  const smallest = matches.filter(
                    (candidate) =>
                      !matches.some(
                        (other) =>
                          other !== candidate &&
                          candidate.element.contains(other.element)
                      )
                  );
                  if (smallest.length === 1) matches = smallest;
                }
              }
              const common = {
                targetMainRowIndex: target.rowIndex,
                targetMainRowTop: Math.round(target.top * 10) / 10,
                targetMainRowBottom: Math.round(target.bottom * 10) / 10,
                targetMainRowHeight: Math.round(target.height * 10) / 10,
                targetMainRowCenterY:
                  Math.round(target.centerY * 10) / 10,
                fixedRightContainerFound: true,
                fixedRightContainerTag: container.tagName.toLowerCase(),
                fixedRightContainerClass: className(container),
                fixedRightContainerBounds: bounds(container),
                directChildCount: container.children.length,
                descendantElementCount: descendants.length,
                visibleDescendantCount: visibleDescendants.length,
                descendantTagCounts: tagCounts,
                roleCounts,
                elementsWithTabindexCount: tabindexCount,
                elementsWithOnclickCount: onclickCount,
                pointerInteractiveElementCount: pointerCount,
                visibleNodeSummaries: summaries,
                fixedStructureType:
                  container.querySelector("tr,[role='row']")
                    ? "row"
                    : "div-grid-or-absolute",
                fixedVisibleCandidateCount: candidates.length,
                fixedIntersectingCandidateCount: candidates.length,
                fixedRightRowCandidateCount: matches.length,
              };
              if (visibleDescendants.length === 0) {
                return {
                  ...common,
                  errorCode: "RECLOUD_RECEIPT_FIXED_STRUCTURE_EMPTY",
                };
              }
              if (candidates.length === 0) {
                return {
                  ...common,
                  errorCode: "RECLOUD_RECEIPT_FIXED_ROW_NOT_MAPPED",
                };
              }
              if (matches.length !== 1) {
                return {
                  ...common,
                  errorCode: "RECLOUD_RECEIPT_FIXED_ROW_AMBIGUOUS",
                };
              }
              const match = matches[0];
              const operationCell =
                match.element.matches(
                  "td,[role='gridcell'],.el-table__cell,.rtxpc-table__cell"
                )
                  ? match.element
                  : match.element.querySelector(
                      "td,[role='gridcell'],.el-table__cell,.rtxpc-table__cell"
                    ) || match.element;
              const cellBox = operationCell.getBoundingClientRect();
              const cellStyle = getComputedStyle(operationCell);
              const normalizedText = (element) =>
                String(element.innerText || element.textContent || "").trim();
              const accessibleName = (element) =>
                String(
                  element.getAttribute("aria-label") ||
                    element.getAttribute("title") ||
                    normalizedText(element)
                ).trim();
              const pseudoState = (element, pseudo) => {
                const style = getComputedStyle(element, pseudo);
                const content = String(style.content || "")
                  .replace(/^["']|["']$/g, "")
                  .trim();
                return {
                  exists:
                    content !== "" &&
                    content !== "none" &&
                    content !== "normal",
                  isReceipt: content === "签收",
                  containsReceipt: content.includes("签收"),
                };
              };
              const queue = [{ element: operationCell, parent: null, depth: 0 }];
              const tree = [];
              const elementToIndex = new Map();
              while (queue.length > 0 && tree.length < 40) {
                const current = queue.shift();
                const element = current.element;
                const index = tree.length;
                elementToIndex.set(element, index);
                const style = getComputedStyle(element);
                const box = bounds(element);
                const nodeText = normalizedText(element);
                const name = accessibleName(element);
                const before = pseudoState(element, "::before");
                const after = pseudoState(element, "::after");
                tree.push({
                  nodeIndex: index,
                  parentNodeIndex: current.parent,
                  tag: element.tagName.toLowerCase(),
                  className: className(element),
                  role: element.getAttribute("role") || "",
                  tabindex: element.getAttribute("tabindex") || "",
                  titlePresent: element.hasAttribute("title"),
                  ariaLabelPresent: element.hasAttribute("aria-label"),
                  dataTestIdPresent: element.hasAttribute("data-testid"),
                  disabled: element.hasAttribute("disabled"),
                  ariaDisabled:
                    element.getAttribute("aria-disabled") || "",
                  hidden: element.hasAttribute("hidden"),
                  visible: visible(element),
                  bounds: box,
                  cursor: style.cursor,
                  pointerEvents: style.pointerEvents,
                  display: style.display,
                  visibility: style.visibility,
                  hasHref: element.hasAttribute("href"),
                  hasOnclick: element.hasAttribute("onclick"),
                  accessibleNamePresent: name.length > 0,
                  accessibleNameIsReceipt: name === "签收",
                  visibleTextIsReceipt: nodeText === "签收",
                  visibleTextContainsReceipt: nodeText.includes("签收"),
                  beforeContentExists: before.exists,
                  beforeContentIsReceipt: before.isReceipt,
                  beforeContentContainsReceipt: before.containsReceipt,
                  afterContentExists: after.exists,
                  afterContentIsReceipt: after.isReceipt,
                  afterContentContainsReceipt: after.containsReceipt,
                });
                if (current.depth < 6) {
                  for (const child of [...element.children]) {
                    if (tree.length + queue.length >= 40) break;
                    queue.push({
                      element: child,
                      parent: index,
                      depth: current.depth + 1,
                    });
                  }
                }
              }
              const sampleX = [0.2, 0.5, 0.8];
              const sampleY = [0.25, 0.5, 0.75];
              const pointHits = [];
              const pointHitElements = new Set();
              let overlayDetected = false;
              for (const xRatio of sampleX) {
                for (const yRatio of sampleY) {
                  const x = cellBox.x + cellBox.width * xRatio;
                  const y = cellBox.y + cellBox.height * yRatio;
                  const hits = document.elementsFromPoint(x, y).slice(0, 10);
                  for (const element of hits) {
                    const style = getComputedStyle(element);
                    const inside =
                      element === operationCell ||
                      operationCell.contains(element);
                    if (inside) pointHitElements.add(element);
                    if (
                      element === hits[0] &&
                      !inside &&
                      style.pointerEvents !== "none" &&
                      Number(style.opacity || "1") < 0.1
                    ) {
                      overlayDetected = true;
                    }
                    pointHits.push({
                      sample: `${Math.round(xRatio * 100)}:${Math.round(
                        yRatio * 100
                      )}`,
                      tag: element.tagName.toLowerCase(),
                      className: className(element),
                      role: element.getAttribute("role") || "",
                      tabindex: element.getAttribute("tabindex") || "",
                      bounds: bounds(element),
                      cursor: style.cursor,
                      pointerEvents: style.pointerEvents,
                      insideOperationCell: inside,
                      accessibleNameIsReceipt:
                        accessibleName(element) === "签收",
                      visibleTextIsReceipt:
                        normalizedText(element) === "签收",
                    });
                  }
                }
              }
              const candidateRecords = tree.map((node) => {
                const element = [...elementToIndex.entries()].find(
                  ([, nodeIndex]) => nodeIndex === node.nodeIndex
                )?.[0];
                const tabindex = Number.parseInt(node.tabindex, 10);
                const semantic =
                  ["button", "a"].includes(node.tag) ||
                  ["button", "link"].includes(node.role) ||
                  Number.isFinite(tabindex) && tabindex >= 0 ||
                  node.hasOnclick;
                const pointer =
                  node.cursor === "pointer" &&
                  node.pointerEvents !== "none";
                const pseudoReceipt =
                  node.beforeContentIsReceipt ||
                  node.beforeContentContainsReceipt ||
                  node.afterContentIsReceipt ||
                  node.afterContentContainsReceipt;
                const pointHit = element && pointHitElements.has(element);
                let priority = 0;
                let matchedBy = "";
                if (node.accessibleNameIsReceipt) {
                  priority = 8;
                  matchedBy = "accessibleName";
                } else if (node.visibleTextIsReceipt) {
                  priority = 7;
                  matchedBy = "exactVisibleText";
                } else if (node.visibleTextContainsReceipt) {
                  priority = 6;
                  matchedBy = "containsVisibleText";
                } else if (pseudoReceipt) {
                  priority = 6;
                  matchedBy = "pseudoContent";
                } else if (
                  ["button", "link"].includes(node.role)
                ) {
                  priority = 5;
                  matchedBy = "semanticRole";
                } else if (["button", "a"].includes(node.tag)) {
                  priority = 4;
                  matchedBy = "semanticTag";
                } else if (Number.isFinite(tabindex) && tabindex >= 0) {
                  priority = 3;
                  matchedBy = "tabindex";
                } else if (pointer) {
                  priority = 2;
                  matchedBy = "pointerCursor";
                } else if (pointHit && semantic) {
                  priority = 1;
                  matchedBy = "pointHitInteractive";
                }
                return {
                  node,
                  priority,
                  matchedBy,
                  semantic,
                  pointer,
                  pointHit,
                };
              });
              const exactCandidates = candidateRecords.filter(
                ({ node }) =>
                  node.accessibleNameIsReceipt ||
                  node.visibleTextIsReceipt ||
                  node.visibleTextContainsReceipt ||
                  node.beforeContentIsReceipt ||
                  node.beforeContentContainsReceipt ||
                  node.afterContentIsReceipt ||
                  node.afterContentContainsReceipt
              );
              const semanticCandidates = candidateRecords.filter(
                ({ semantic }) => semantic
              );
              const pointerCandidates = candidateRecords.filter(
                ({ pointer }) => pointer
              );
              const hitCandidates = candidateRecords.filter(
                ({ pointHit, semantic, pointer }) =>
                  pointHit && (semantic || pointer)
              );
              const delegatedCellCandidate =
                cellStyle.pointerEvents !== "none" &&
                (cellStyle.cursor === "pointer" ||
                  operationCell.getAttribute("role") === "button" ||
                  operationCell.hasAttribute("tabindex") ||
                  operationCell.hasAttribute("onclick"));
              const highestPriority = Math.max(
                0,
                ...candidateRecords.map(({ priority }) => priority)
              );
              let best = candidateRecords.filter(
                ({ priority }) =>
                  priority > 0 && priority === highestPriority
              );
              if (best.length > 1) {
                best = best.filter(
                  ({ node }) =>
                    !best.some(
                      ({ node: other }) =>
                        other.nodeIndex !== node.nodeIndex &&
                        other.parentNodeIndex === node.nodeIndex
                    )
                );
              }
              if (
                best.length === 0 &&
                delegatedCellCandidate
              ) {
                best = [
                  {
                    node: tree[0],
                    matchedBy: "delegatedCell",
                  },
                ];
              }
              const unique = best.length === 1 ? best[0] : null;
              const operationCellText = normalizedText(operationCell);
              const operationCellName = accessibleName(operationCell);
              const operationCellPseudo = tree.some(
                (node) =>
                  node.beforeContentIsReceipt ||
                  node.beforeContentContainsReceipt ||
                  node.afterContentIsReceipt ||
                  node.afterContentContainsReceipt
              );
              const safeControls = candidateRecords
                .filter(({ priority }) => priority > 0)
                .slice(0, 30)
                .map(({ node }) => ({
                  tag: node.tag,
                  role: node.role,
                  class: node.className,
                  titlePresent: node.titlePresent,
                  ariaLabelPresent: node.ariaLabelPresent,
                  enabled: !node.disabled && node.ariaDisabled !== "true",
                  visible: node.visible,
                  bounds: node.bounds,
                }));
              const errorCode = overlayDetected
                ? "RECLOUD_RECEIPT_CONTROL_OCCLUDED"
                : tree.length === 0
                  ? "RECLOUD_RECEIPT_OPERATION_CELL_EMPTY"
                  : unique
                    ? null
                    : best.length > 1
                      ? "RECLOUD_RECEIPT_CONTROL_AMBIGUOUS"
                      : "RECLOUD_RECEIPT_CONTROL_NOT_FOUND";
              return {
                ...common,
                fixedRightRowMatched: true,
                fixedRightRowMatchedBy: matchedBy,
                fixedRightRowCenterDelta:
                  Math.round(match.centerDelta * 10) / 10,
                fixedRightRowBounds: bounds(match.element),
                operationCellFound: true,
                operationCellBounds: bounds(operationCell),
                operationControlCandidateCount: safeControls.length,
                operationControlCandidates: safeControls,
                operationCellTree: tree,
                pointHitDiagnostics: pointHits.slice(0, 90),
                operationCellVisibleTextIsReceipt:
                  operationCellText === "签收",
                operationCellVisibleTextContainsReceipt:
                  operationCellText.includes("签收"),
                operationCellAccessibleNameIsReceipt:
                  operationCellName === "签收",
                operationCellCursor: cellStyle.cursor,
                operationCellPointerEvents: cellStyle.pointerEvents,
                operationCellRole:
                  operationCell.getAttribute("role") || "",
                operationCellTabIndex:
                  operationCell.getAttribute("tabindex") || "",
                operationCellPseudoReceiptFound: operationCellPseudo,
                descendantNodeCount: Math.max(0, tree.length - 1),
                exactReceiptCandidateCount: exactCandidates.length,
                semanticInteractiveCandidateCount:
                  semanticCandidates.length,
                pointerCandidateCount: pointerCandidates.length,
                pointHitCandidateCount: hitCandidates.length,
                delegatedCellCandidate,
                uniqueReceiptControlFound: Boolean(unique),
                uniqueReceiptControlMatchedBy:
                  unique?.matchedBy || "",
                uniqueReceiptControlNodeIndex:
                  unique?.node?.nodeIndex ?? null,
                uniqueReceiptControlBounds:
                  unique?.node?.bounds || null,
                overlayDetected,
                diagnosticsStage: "operation_cell_complete",
                errorCode,
              };
            },
            {
              rowIndex: Number(options.rowIndex) || 1,
              targetCenterY: Number.isFinite(options.targetCenterY)
                ? options.targetCenterY
                : null,
              headerNames: ["产品序列号", "项目号", "产品线", "操作"],
            }
          ),
        null
      );
      if (!result) continue;
      return {
        ...base,
        ...result,
        missingFields:
          result.errorCode === "RECLOUD_RECEIPT_FIXED_RIGHT_NOT_FOUND"
            ? ["receiptForm.fixedRight"]
            : result.errorCode === "RECLOUD_RECEIPT_FIXED_STRUCTURE_EMPTY"
              ? ["receiptForm.fixedRightStructure"]
              : result.errorCode === "RECLOUD_RECEIPT_FIXED_ROW_NOT_MAPPED" ||
                  result.errorCode === "RECLOUD_RECEIPT_FIXED_ROW_AMBIGUOUS"
                ? ["receiptForm.fixedRightRow"]
                : result.errorCode === "RECLOUD_RECEIPT_CONTROL_NOT_FOUND" ||
                    result.errorCode === "RECLOUD_RECEIPT_CONTROL_AMBIGUOUS" ||
                    result.errorCode ===
                      "RECLOUD_RECEIPT_OPERATION_CELL_EMPTY" ||
                    result.errorCode === "RECLOUD_RECEIPT_CONTROL_OCCLUDED"
                  ? ["receiptForm.entry"]
                  : [],
      };
    }
  }
  return {
    ...base,
    missingFields: ["receiptForm.fixedRight"],
    errorCode: "RECLOUD_RECEIPT_FIXED_RIGHT_NOT_FOUND",
  };
}

function summarizeReceiptHoverSnapshots(snapshots = []) {
  const latest = snapshots.at(-1) || {};
  const popupCounts = snapshots.map((item) => item.hoverPopupCount || 0);
  const candidateCounts = snapshots.map(
    (item) => item.receiptControlCandidateCount || 0
  );
  const maximumPopupCount = Math.max(0, ...popupCounts);
  const maximumCandidateCount = Math.max(0, ...candidateCounts);
  const uniqueSnapshot = snapshots.find(
    (item) =>
      item.receiptControlCandidateCount === 1 &&
      item.receiptControlVisible &&
      !item.receiptControlOccluded &&
      item.hoverSourceUnique
  );
  let errorCode = null;
  if (maximumPopupCount > 1) {
    errorCode = "RECLOUD_RECEIPT_HOVER_POPUP_AMBIGUOUS";
  } else if (maximumCandidateCount > 1) {
    errorCode = "RECLOUD_RECEIPT_CONTROL_AMBIGUOUS";
  } else if (
    snapshots.some(
      (item) =>
        item.receiptControlCandidateCount === 1 &&
        item.receiptControlOccluded
    )
  ) {
    errorCode = "RECLOUD_RECEIPT_CONTROL_OCCLUDED";
  } else if (!uniqueSnapshot) {
    errorCode = snapshots.some((item) => item.descendantsExpandedAfterHover)
      ? "RECLOUD_RECEIPT_CONTROL_NOT_FOUND"
      : "RECLOUD_RECEIPT_HOVER_NOT_EXPANDED";
  }
  return {
    descendantsExpandedAfterHover: snapshots.some(
      (item) => item.descendantsExpandedAfterHover
    ),
    hoverPopupCount: maximumPopupCount,
    popupAppearedAfterHover: maximumPopupCount > 0,
    receiptTextAppearedAfterHover: snapshots.some(
      (item) => item.receiptTextAppearedAfterHover
    ),
    receiptControlAppearedAfterHover: maximumCandidateCount > 0,
    receiptControlCandidateCount: maximumCandidateCount,
    uniqueReceiptControlFound: Boolean(uniqueSnapshot),
    uniqueReceiptControlMatchedBy:
      uniqueSnapshot?.uniqueReceiptControlMatchedBy || "",
    receiptControlBounds:
      uniqueSnapshot?.receiptControlBounds || null,
    receiptControlOccluded: snapshots.some(
      (item) => item.receiptControlOccluded
    ),
    hoverDiagnostics: latest.hoverDiagnostics || [],
    errorCode,
  };
}

async function diagnoseReceiptControlAfterHover(page, options = {}) {
  if (options.dryRun !== true || options.writeEnabled !== false) {
    const error = new Error("签收控件悬停诊断只允许在严格只读模式下执行");
    error.code = "RECLOUD_RECEIPT_INSPECTION_UNSAFE";
    error.status = 403;
    throw error;
  }
  assertRecloudAuthenticated(page);
  const fixed = await diagnoseFixedReceiptOperation(page, options);
  const base = {
    operationCellHovered: false,
    hoverTargetStillUnique: false,
    descendantsExpandedAfterHover: false,
    hoverPopupCount: 0,
    popupAppearedAfterHover: false,
    receiptTextAppearedAfterHover: false,
    receiptControlAppearedAfterHover: false,
    receiptControlCandidateCount: 0,
    uniqueReceiptControlFound: false,
    uniqueReceiptControlMatchedBy: "",
    receiptControlBounds: null,
    receiptControlOccluded: false,
    hoverDiagnostics: [],
    networkWriteBlocked: false,
    blockedRequestCount: 0,
    confirmClicked: false,
    clicked: false,
    dialogOpened: false,
    missingFields: [],
    errorCode: null,
  };
  if (!fixed.fixedRightRowMatched || !fixed.operationCellFound) {
    return {
      ...base,
      missingFields: fixed.missingFields,
      errorCode: fixed.errorCode,
    };
  }

  const marker = "data-fielddesk-hover-operation-cell";
  const box = fixed.operationCellBounds;
  const markResult = await page.evaluate(
    ({ marker, box }) => {
      document
        .querySelectorAll(`[${marker}]`)
        .forEach((element) => element.removeAttribute(marker));
      const candidates = [
        ...document.querySelectorAll(
          ".el-table__fixed-right td,.rtxpc-table__fixed-right td,[class*='fixed-right'] td,[class*='fixedRight'] td"
        ),
      ].filter((element) => {
        const current = element.getBoundingClientRect();
        return (
          Math.abs(current.x - box.x) <= 2 &&
          Math.abs(current.y - box.y) <= 2 &&
          Math.abs(current.width - box.width) <= 2 &&
          Math.abs(current.height - box.height) <= 2
        );
      });
      if (candidates.length === 1) {
        candidates[0].setAttribute(marker, "true");
      }
      return { count: candidates.length };
    },
    { marker, box }
  );
  if (markResult.count !== 1) {
    return {
      ...base,
      missingFields: ["receiptForm.operationCell"],
      errorCode: "RECLOUD_RECEIPT_FIXED_ROW_AMBIGUOUS",
    };
  }

  const target = page.locator(`[${marker}="true"]`);
  const guardState = createSimulationState();
  let networkGuard = null;
  const snapshots = [];
  try {
    networkGuard = await createReceiptNetworkGuard(page, guardState);
    const baselinePopups = await page.evaluate(() =>
      [
        ...document.querySelectorAll(
          "[role='tooltip'],[role='menu'],[role='listbox'],.el-tooltip__popper,.el-popover,.el-dropdown-menu,[class*='popover'],[class*='tooltip'],[class*='dropdown'],[class*='portal']"
        ),
      ]
        .filter((element) => {
          const box = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return (
            box.width > 0 &&
            box.height > 0 &&
            style.display !== "none" &&
            style.visibility !== "hidden"
          );
        })
        .map((element) => {
          const box = element.getBoundingClientRect();
          return `${element.tagName}:${Math.round(box.x)}:${Math.round(box.y)}`;
        })
    );
    await target.hover({ timeout: options.hoverTimeout ?? 3000 });
    base.operationCellHovered = true;

    for (const delay of [100, 500, 1000]) {
      await page.waitForTimeout(delay);
      const snapshot = await page.evaluate(
        ({ marker, baselinePopups }) => {
          const cell = document.querySelector(`[${marker}="true"]`);
          if (!cell) return { targetCount: 0 };
          const visible = (element) => {
            const box = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return (
              box.width > 0 &&
              box.height > 0 &&
              style.display !== "none" &&
              style.visibility !== "hidden"
            );
          };
          const bounds = (element) => {
            const box = element.getBoundingClientRect();
            return {
              x: Math.round(box.x * 10) / 10,
              y: Math.round(box.y * 10) / 10,
              width: Math.round(box.width * 10) / 10,
              height: Math.round(box.height * 10) / 10,
            };
          };
          const safeClass = (element) =>
            String(element.className || "")
              .split(/\s+/)
              .slice(0, 16)
              .join(" ");
          const text = (element) =>
            String(element.innerText || element.textContent || "").trim();
          const name = (element) =>
            String(
              element.getAttribute("aria-label") ||
                element.getAttribute("title") ||
                text(element)
            ).trim();
          const popupSelector =
            "[role='tooltip'],[role='menu'],[role='listbox'],.el-tooltip__popper,.el-popover,.el-dropdown-menu,[class*='popover'],[class*='tooltip'],[class*='dropdown'],[class*='portal']";
          const popups = [...document.querySelectorAll(popupSelector)]
            .filter(visible)
            .filter((element) => {
              const box = element.getBoundingClientRect();
              const identity = `${element.tagName}:${Math.round(
                box.x
              )}:${Math.round(box.y)}`;
              return !baselinePopups.includes(identity);
            });
          const scopes = [cell, ...popups];
          const nodes = [
            cell,
            ...cell.querySelectorAll(
              ".cell,.operation,.rt-list-button-group,button,a,span,div,svg,use,[role='button'],[tabindex],[title],[aria-label],[data-testid]"
            ),
            ...popups.flatMap((popup) => [
              popup,
              ...popup.querySelectorAll(
                "button,a,span,div,svg,use,[role='button'],[tabindex],[title],[aria-label],[data-testid]"
              ),
            ]),
          ].slice(0, 200);
          const uniqueNodes = [...new Set(nodes)];
          const diagnostics = uniqueNodes.slice(0, 40).map((element) => {
            const style = getComputedStyle(element);
            const accessible = name(element);
            const visibleText = text(element);
            return {
              tag: element.tagName.toLowerCase(),
              className: safeClass(element),
              rolePresent: element.hasAttribute("role"),
              tabindexPresent: element.hasAttribute("tabindex"),
              visible: visible(element),
              width: bounds(element).width,
              height: bounds(element).height,
              cursor: style.cursor,
              pointerEvents: style.pointerEvents,
              clickSemantic:
                element.hasAttribute("onclick") ||
                ["button", "a"].includes(element.tagName.toLowerCase()) ||
                element.getAttribute("role") === "button" ||
                style.cursor === "pointer",
              accessibleNameIsReceipt: accessible === "签收",
              visibleTextIsReceipt: visibleText === "签收",
            };
          });
          const candidates = uniqueNodes.filter((element) => {
            if (!visible(element)) return false;
            const style = getComputedStyle(element);
            const semantic =
              element.hasAttribute("onclick") ||
              ["button", "a"].includes(element.tagName.toLowerCase()) ||
              element.getAttribute("role") === "button" ||
              element.hasAttribute("tabindex") ||
              style.cursor === "pointer";
            const receipt =
              name(element) === "签收" || text(element) === "签收";
            return receipt && (semantic || receipt);
          });
          const deepest = candidates.filter(
            (element) =>
              !candidates.some(
                (other) => other !== element && element.contains(other)
              )
          );
          let occluded = false;
          let controlBounds = null;
          if (deepest.length === 1) {
            const box = deepest[0].getBoundingClientRect();
            controlBounds = bounds(deepest[0]);
            const top = document.elementFromPoint(
              box.x + box.width / 2,
              box.y + box.height / 2
            );
            occluded = Boolean(
              top &&
                top !== deepest[0] &&
                !deepest[0].contains(top) &&
                !top.contains(deepest[0])
            );
          }
          const cellBox = cell.getBoundingClientRect();
          const pointHits = new Set();
          for (const xRatio of [0.2, 0.5, 0.8]) {
            for (const yRatio of [0.25, 0.5, 0.75]) {
              for (const element of document.elementsFromPoint(
                cellBox.x + cellBox.width * xRatio,
                cellBox.y + cellBox.height * yRatio
              )) {
                if (cell.contains(element)) pointHits.add(element);
              }
            }
          }
          const descendantsExpanded = [
            ...cell.querySelectorAll(
              ".cell,.operation,.rt-list-button-group"
            ),
          ].some(visible);
          return {
            targetCount: document.querySelectorAll(
              `[${marker}="true"]`
            ).length,
            hoverSourceUnique: true,
            descendantsExpandedAfterHover: descendantsExpanded,
            hoverPopupCount: popups.length,
            receiptTextAppearedAfterHover: scopes.some(
              (scope) =>
                text(scope) === "签收" ||
                [...scope.querySelectorAll("*")]
                  .slice(0, 200)
                  .some((element) => text(element) === "签收")
            ),
            receiptControlCandidateCount: deepest.length,
            receiptControlVisible:
              deepest.length === 1 && visible(deepest[0]),
            receiptControlOccluded: occluded,
            uniqueReceiptControlMatchedBy:
              deepest.length === 1
                ? cell.contains(deepest[0])
                  ? "hoveredCell"
                  : "hoverPopup"
                : "",
            receiptControlBounds: controlBounds,
            pointHitCandidateCount: [...pointHits].filter((element) =>
              candidates.includes(element)
            ).length,
            hoverDiagnostics: diagnostics,
          };
        },
        { marker, baselinePopups }
      );
      if (snapshot.targetCount !== 1) {
        return {
          ...base,
          operationCellHovered: true,
          hoverTargetStillUnique: false,
          networkWriteBlocked: true,
          blockedRequestCount: guardState.blockedRequestCount,
          missingFields: ["receiptForm.operationCell"],
          errorCode: "RECLOUD_RECEIPT_FIXED_ROW_AMBIGUOUS",
        };
      }
      snapshots.push(snapshot);
    }
    await networkGuard.assertSafe();
    const summary = summarizeReceiptHoverSnapshots(snapshots);
    return {
      ...base,
      ...summary,
      operationCellHovered: true,
      hoverTargetStillUnique: true,
      networkWriteBlocked: true,
      blockedRequestCount: guardState.blockedRequestCount,
      confirmClicked: false,
      clicked: false,
      dialogOpened: false,
      missingFields: summary.errorCode ? ["receiptForm.entry"] : [],
    };
  } catch (error) {
    if (error.code === "RECLOUD_UNEXPECTED_WRITE_REQUEST") {
      return {
        ...base,
        operationCellHovered: true,
        hoverTargetStillUnique: true,
        networkWriteBlocked: true,
        blockedRequestCount: guardState.blockedRequestCount,
        missingFields: [],
        errorCode: error.code,
      };
    }
    throw error;
  } finally {
    await networkGuard?.stop();
    await page
      .evaluate((marker) => {
        document
          .querySelectorAll(`[${marker}]`)
          .forEach((element) => element.removeAttribute(marker));
      }, marker)
      .catch(() => {});
  }
}

function classifyReceiptRowHoverDiagnostics(result = {}) {
  if ((result.receiptControlCandidateCount || 0) > 1) {
    return "RECLOUD_RECEIPT_CONTROL_AMBIGUOUS";
  }
  if (result.uniqueReceiptControlFound) return null;
  if (result.clippingDetected) return "RECLOUD_RECEIPT_CONTENT_CLIPPED";
  if (result.delegatedHoverDetected) {
    return "RECLOUD_RECEIPT_PARENT_EVENT_DELEGATION";
  }
  if (
    result.mainRowHovered &&
    !result.descendantsExpandedAfterHover &&
    (result.portalCandidateCount || 0) === 0
  ) {
    return "RECLOUD_RECEIPT_ROW_HOVER_NOT_EXPANDED";
  }
  if ((result.portalCandidateCount || 0) === 0) {
    return "RECLOUD_RECEIPT_PORTAL_NOT_FOUND";
  }
  return "RECLOUD_RECEIPT_CONTROL_NOT_RENDERED";
}

async function diagnoseReceiptControlAfterRowHover(page, options = {}) {
  if (options.dryRun !== true || options.writeEnabled !== false) {
    const error = new Error("签收整行悬停诊断只允许在严格只读模式下执行");
    error.code = "RECLOUD_RECEIPT_INSPECTION_UNSAFE";
    error.status = 403;
    throw error;
  }
  assertRecloudAuthenticated(page);
  const fixed = await diagnoseFixedReceiptOperation(page, options);
  const base = {
    mainRowHovered: false,
    fixedRowHovered: false,
    operationCellHovered: false,
    hoverStateMatched: {},
    mutationCountByTarget: {},
    newStructuralNodes: [],
    ancestorStyleDiagnostics: [],
    elementsFromPointBefore: [],
    elementsFromPointAfterMainRowHover: [],
    elementsFromPointAfterFixedRowHover: [],
    pseudoElementDiagnostics: {},
    renderMechanismDiagnostics: {},
    descendantsExpandedAfterHover: false,
    clippingDetected: false,
    delegatedHoverDetected: false,
    portalCandidateCount: 0,
    receiptControlCandidateCount: 0,
    uniqueReceiptControlFound: false,
    receiptControlMatchedBy: "",
    receiptControlBounds: null,
    receiptControlOccluded: false,
    networkWriteBlocked: false,
    blockedRequestCount: 0,
    confirmClicked: false,
    missingFields: [],
    errorCode: null,
  };
  if (!fixed.fixedRightRowMatched || !fixed.operationCellFound) {
    return {
      ...base,
      missingFields: fixed.missingFields,
      errorCode: fixed.errorCode,
    };
  }

  const markers = {
    main: "data-fielddesk-main-row-hover",
    fixed: "data-fielddesk-fixed-row-hover",
    cell: "data-fielddesk-operation-cell-hover",
  };
  const marked = await page.evaluate(
    ({ markers, fixed }) => {
      Object.values(markers).forEach((marker) => {
        document
          .querySelectorAll(`[${marker}]`)
          .forEach((element) => element.removeAttribute(marker));
      });
      const close = (a, b, tolerance = 2) =>
        Math.abs(Number(a) - Number(b)) <= tolerance;
      const rowLike = [
        ...document.querySelectorAll(
          "tr,[role='row'],.el-table__row,[class*='table-row'],[class*='virtual-row']"
        ),
      ];
      const fixedAncestor = (element) =>
        Boolean(
          element.closest(
            ".el-table__fixed-right,.el-table__fixed-right-wrapper,[class*='fixed-right'],[class*='fixedRight']"
          )
        );
      const matchesRow = (element, y, height) => {
        const box = element.getBoundingClientRect();
        return (
          close(box.y, y) &&
          close(box.height, height) &&
          box.width > 0
        );
      };
      const mainRows = rowLike.filter(
        (element) =>
          !fixedAncestor(element) &&
          matchesRow(
            element,
            fixed.targetMainRowTop,
            fixed.targetMainRowHeight
          )
      );
      const fixedRows = rowLike.filter(
        (element) =>
          fixedAncestor(element) &&
          matchesRow(
            element,
            fixed.fixedRightRowBounds?.y,
            fixed.fixedRightRowBounds?.height
          )
      );
      const cells = [
        ...document.querySelectorAll(
          ".el-table__fixed-right td,.rtxpc-table__fixed-right td,[class*='fixed-right'] td,[class*='fixedRight'] td"
        ),
      ].filter((element) => {
        const current = element.getBoundingClientRect();
        const box = fixed.operationCellBounds;
        return (
          box &&
          close(current.x, box.x) &&
          close(current.y, box.y) &&
          close(current.width, box.width) &&
          close(current.height, box.height)
        );
      });
      if (mainRows.length === 1)
        mainRows[0].setAttribute(markers.main, "true");
      if (fixedRows.length === 1)
        fixedRows[0].setAttribute(markers.fixed, "true");
      if (cells.length === 1)
        cells[0].setAttribute(markers.cell, "true");
      return {
        mainCount: mainRows.length,
        fixedCount: fixedRows.length,
        cellCount: cells.length,
      };
    },
    { markers, fixed }
  );
  if (
    marked.mainCount !== 1 ||
    marked.fixedCount !== 1 ||
    marked.cellCount !== 1
  ) {
    return {
      ...base,
      missingFields: ["receiptForm.uniqueHoverTargets"],
      errorCode: "RECLOUD_RECEIPT_FIXED_ROW_AMBIGUOUS",
    };
  }

  const guardState = createSimulationState();
  let networkGuard;
  const snapshots = [];
  const targets = [
    { key: "mainRow", selector: `[${markers.main}="true"]` },
    { key: "mainRowCenter", selector: `[${markers.main}="true"]`, center: true },
    { key: "fixedRow", selector: `[${markers.fixed}="true"]` },
    { key: "operationCell", selector: `[${markers.cell}="true"]` },
    { key: "cell", selector: `[${markers.cell}="true"] .cell`, optional: true },
    {
      key: "operation",
      selector: `[${markers.cell}="true"] .operation.operate-option`,
      optional: true,
    },
    {
      key: "buttonGroup",
      selector: `[${markers.cell}="true"] .rt-list-button-group`,
      optional: true,
    },
  ];
  try {
    networkGuard = await createReceiptNetworkGuard(page, guardState);
    await page.evaluate(() => {
      const safeClass = (element) =>
        String(element.className || "")
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, 12)
          .join(" ");
      const safeNode = (element) => {
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          tag: element.tagName.toLowerCase(),
          className: safeClass(element),
          rolePresent: element.hasAttribute("role"),
          ariaLabelPresent: element.hasAttribute("aria-label"),
          titlePresent: element.hasAttribute("title"),
          dataTestidPresent: element.hasAttribute("data-testid"),
          visible:
            box.width > 0 &&
            box.height > 0 &&
            style.display !== "none" &&
            style.visibility !== "hidden",
          bounds: {
            x: Math.round(box.x * 10) / 10,
            y: Math.round(box.y * 10) / 10,
            width: Math.round(box.width * 10) / 10,
            height: Math.round(box.height * 10) / 10,
          },
          portalLike: Boolean(
            element.closest(
              "[role='tooltip'],[role='menu'],[role='dialog'],.el-popper,.el-popover,.el-tooltip__popper,.el-dropdown-menu,[class*='portal'],[class*='teleport'],[class*='overlay']"
            )
          ),
        };
      };
      window.__fieldDeskHoverDiagnostic = {
        activeTarget: "",
        counts: {},
        nodes: [],
        safeNode,
      };
      const state = window.__fieldDeskHoverDiagnostic;
      state.observer = new MutationObserver((mutations) => {
        const key = state.activeTarget || "inactive";
        state.counts[key] = state.counts[key] || { added: 0, removed: 0 };
        for (const mutation of mutations) {
          state.counts[key].added += mutation.addedNodes.length;
          state.counts[key].removed += mutation.removedNodes.length;
          for (const node of mutation.addedNodes) {
            if (
              node.nodeType === Node.ELEMENT_NODE &&
              state.nodes.length < 80
            ) {
              state.nodes.push({ target: key, ...safeNode(node) });
            }
          }
        }
      });
      state.observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: [
          "class",
          "style",
          "role",
          "aria-label",
          "title",
          "data-testid",
        ],
      });
    });

    const collect = (key, phase) =>
      page.evaluate(
        ({ key, phase, markers }) => {
          const cell = document.querySelector(`[${markers.cell}="true"]`);
          const main = document.querySelector(`[${markers.main}="true"]`);
          const fixedRow = document.querySelector(
            `[${markers.fixed}="true"]`
          );
          if (!cell || !main || !fixedRow) return { targetsUnique: false };
          const round = (value) => Math.round(value * 10) / 10;
          const bounds = (element) => {
            const box = element.getBoundingClientRect();
            return {
              x: round(box.x),
              y: round(box.y),
              width: round(box.width),
              height: round(box.height),
            };
          };
          const safeClass = (element) =>
            String(element.className || "")
              .split(/\s+/)
              .filter(Boolean)
              .slice(0, 12)
              .join(" ");
          const visible = (element) => {
            const box = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return (
              box.width > 0 &&
              box.height > 0 &&
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              style.opacity !== "0"
            );
          };
          const isReceipt = (element) =>
            String(
              element.getAttribute("aria-label") ||
                element.getAttribute("title") ||
                element.innerText ||
                element.textContent ||
                ""
            ).trim() === "签收";
          const interactive = (element) => {
            const style = getComputedStyle(element);
            return (
              ["button", "a"].includes(element.tagName.toLowerCase()) ||
              ["button", "link"].includes(element.getAttribute("role")) ||
              element.hasAttribute("tabindex") ||
              element.hasAttribute("onclick") ||
              style.cursor === "pointer"
            );
          };
          const styleRecord = (element, label) => {
            const style = getComputedStyle(element);
            const box = element.getBoundingClientRect();
            return {
              label,
              tag: element.tagName.toLowerCase(),
              className: safeClass(element),
              hoverMatched: element.matches(":hover"),
              cursor: style.cursor,
              pointerEvents: style.pointerEvents,
              visibility: style.visibility,
              display: style.display,
              opacity: style.opacity,
              overflow: style.overflow,
              overflowX: style.overflowX,
              overflowY: style.overflowY,
              clipPresent: style.clip !== "auto",
              clipPathPresent: !["none", ""].includes(style.clipPath),
              zIndex: style.zIndex,
              transformPresent: style.transform !== "none",
              width: round(box.width),
              height: round(box.height),
              maxWidth: style.maxWidth,
              maxHeight: style.maxHeight,
              zeroHeightNonEmpty:
                box.height === 0 && element.children.length > 0,
              delegatedEventHint:
                element.hasAttribute("onclick") ||
                Object.keys(element).some((name) =>
                  /react|vue|event/i.test(name)
                ),
            };
          };
          const ancestors = [];
          let current = cell;
          for (let index = 0; current && index < 8; index += 1) {
            ancestors.push(styleRecord(current, `ancestor-${index}`));
            current = current.parentElement;
          }
          const sample = () => {
            const box = cell.getBoundingClientRect();
            const result = [];
            for (const xRatio of [0.2, 0.5, 0.8]) {
              for (const yRatio of [0.25, 0.5, 0.75]) {
                result.push(
                  ...document
                    .elementsFromPoint(
                      box.x + box.width * xRatio,
                      box.y + box.height * yRatio
                    )
                    .slice(0, 8)
                    .map((element) => {
                      const style = getComputedStyle(element);
                      return {
                        position: `${xRatio}-${yRatio}`,
                        tag: element.tagName.toLowerCase(),
                        className: safeClass(element),
                        rolePresent: element.hasAttribute("role"),
                        accessibleNameIsReceipt: isReceipt(element),
                        bounds: bounds(element),
                        pointerEvents: style.pointerEvents,
                        zIndex: style.zIndex,
                      };
                    })
                );
              }
            }
            return result.slice(0, 72);
          };
          const descendants = [...cell.querySelectorAll("*")].slice(0, 120);
          const popupSelector =
            "[role='tooltip'],[role='menu'],[role='dialog'],.el-popper,.el-popover,.el-tooltip__popper,.el-dropdown-menu,[class*='portal'],[class*='teleport'],[class*='overlay']";
          const popups = [...document.querySelectorAll(popupSelector)].filter(
            visible
          );
          const candidates = [
            ...new Set([
              ...descendants,
              ...popups.flatMap((popup) => [
                popup,
                ...popup.querySelectorAll("*"),
              ]),
            ]),
          ].filter(
            (element) =>
              visible(element) && interactive(element) && isReceipt(element)
          );
          const deepest = candidates.filter(
            (element) =>
              !candidates.some(
                (other) => other !== element && element.contains(other)
              )
          );
          let occluded = false;
          if (deepest.length === 1) {
            const box = deepest[0].getBoundingClientRect();
            const top = document.elementFromPoint(
              box.x + box.width / 2,
              box.y + box.height / 2
            );
            occluded = Boolean(
              top &&
                top !== deepest[0] &&
                !deepest[0].contains(top) &&
                !top.contains(deepest[0])
            );
          }
          const pseudo = {};
          for (const [label, element] of [
            ["cell", cell],
            ["operation", cell.querySelector(".operation.operate-option")],
            ["buttonGroup", cell.querySelector(".rt-list-button-group")],
          ]) {
            if (!element) continue;
            const before = getComputedStyle(element, "::before").content;
            const after = getComputedStyle(element, "::after").content;
            pseudo[label] = {
              beforePresent: !["none", "normal", '""', ""].includes(before),
              beforeIsReceipt: before.replace(/^["']|["']$/g, "") === "签收",
              afterPresent: !["none", "normal", '""', ""].includes(after),
              afterIsReceipt: after.replace(/^["']|["']$/g, "") === "签收",
            };
          }
          const render = {
            svgCount: cell.querySelectorAll("svg,use").length,
            canvasCount: cell.querySelectorAll("canvas").length,
            iframeCount: cell.querySelectorAll("iframe").length,
            shadowRootCount: [cell, ...descendants].filter(
              (element) => element.shadowRoot
            ).length,
            backgroundImagePresent: [cell, ...descendants].some(
              (element) =>
                getComputedStyle(element).backgroundImage !== "none"
            ),
            maskPresent: [cell, ...descendants].some((element) => {
              const style = getComputedStyle(element);
              return Boolean(
                (style.maskImage && style.maskImage !== "none") ||
                  (style.webkitMaskImage &&
                    style.webkitMaskImage !== "none")
              );
            }),
            iconFontPresent: [cell, ...descendants].some((element) =>
              /icon/i.test(safeClass(element))
            ),
          };
          return {
            targetsUnique:
              document.querySelectorAll(`[${markers.main}="true"]`).length ===
                1 &&
              document.querySelectorAll(`[${markers.fixed}="true"]`).length ===
                1 &&
              document.querySelectorAll(`[${markers.cell}="true"]`).length ===
                1,
            key,
            phase,
            hoverState: {
              mainRow: main.matches(":hover"),
              fixedRow: fixedRow.matches(":hover"),
              operationCell: cell.matches(":hover"),
            },
            ancestorStyles: ancestors,
            pointHits: sample(),
            descendantsExpanded: descendants.some(visible),
            portalCount: popups.length,
            candidateCount: deepest.length,
            candidateBounds:
              deepest.length === 1 ? bounds(deepest[0]) : null,
            candidateOccluded: occluded,
            candidateMatchedBy:
              deepest.length === 1
                ? cell.contains(deepest[0])
                  ? "operationCell"
                  : "associatedPortal"
                : "",
            pseudo,
            render,
          };
        },
        { key, phase, markers }
      );

    snapshots.push(await collect("before", "before"));
    for (const target of targets) {
      const locator = page.locator(target.selector);
      if ((await locator.count()) !== 1) {
        if (!target.optional) {
          return {
            ...base,
            networkWriteBlocked: true,
            missingFields: ["receiptForm.uniqueHoverTargets"],
            errorCode: "RECLOUD_RECEIPT_FIXED_ROW_AMBIGUOUS",
          };
        }
        continue;
      }
      const targetBox = await locator.boundingBox();
      if (
        !targetBox ||
        targetBox.width <= 0 ||
        targetBox.height <= 0
      ) {
        if (target.optional) {
          base.hoverStateMatched[target.key] = {
            hoverable: false,
            zeroSized: true,
          };
          continue;
        }
        return {
          ...base,
          networkWriteBlocked: true,
          missingFields: ["receiptForm.uniqueHoverTargets"],
          errorCode: "RECLOUD_RECEIPT_FIXED_ROW_AMBIGUOUS",
        };
      }
      await page.evaluate((key) => {
        window.__fieldDeskHoverDiagnostic.activeTarget = key;
      }, target.key);
      if (target.center) {
        await page.mouse.move(
          targetBox.x + targetBox.width / 2,
          targetBox.y + targetBox.height / 2
        );
      } else {
        await locator.hover({ timeout: options.hoverTimeout ?? 3000 });
      }
      if (target.key === "mainRow" || target.key === "mainRowCenter")
        base.mainRowHovered = true;
      if (target.key === "fixedRow") base.fixedRowHovered = true;
      if (target.key === "operationCell")
        base.operationCellHovered = true;
      for (const delay of [100, 500, 1000]) {
        await page.waitForTimeout(delay);
        const snapshot = await collect(target.key, delay);
        if (!snapshot.targetsUnique) {
          return {
            ...base,
            networkWriteBlocked: true,
            missingFields: ["receiptForm.uniqueHoverTargets"],
            errorCode: "RECLOUD_RECEIPT_FIXED_ROW_AMBIGUOUS",
          };
        }
        snapshots.push(snapshot);
      }
    }
    await networkGuard.assertSafe();
    const observer = await page.evaluate(() => {
      const state = window.__fieldDeskHoverDiagnostic;
      state?.observer?.disconnect();
      return {
        counts: state?.counts || {},
        nodes: (state?.nodes || []).slice(0, 40),
      };
    });
    const lastByKey = Object.fromEntries(
      targets.map(({ key }) => [
        key,
        [...snapshots].reverse().find((item) => item.key === key) || {},
      ])
    );
    const allStyles = snapshots.flatMap(
      (snapshot) => snapshot.ancestorStyles || []
    );
    const clippingDetected = allStyles.some(
      (style) =>
        style.clipPresent ||
        style.clipPathPresent ||
        ["hidden", "clip"].includes(style.overflow) ||
        ["hidden", "clip"].includes(style.overflowX) ||
        ["hidden", "clip"].includes(style.overflowY)
    );
    const delegatedHoverDetected = allStyles.some(
      (style) => style.delegatedEventHint
    );
    const maximumCandidates = Math.max(
      0,
      ...snapshots.map((snapshot) => snapshot.candidateCount || 0)
    );
    const unique = snapshots.find(
      (snapshot) =>
        snapshot.candidateCount === 1 && !snapshot.candidateOccluded
    );
    const result = {
      ...base,
      hoverStateMatched: Object.fromEntries(
        Object.entries(lastByKey).map(([key, value]) => [
          key,
          value.hoverState || {},
        ])
      ),
      mutationCountByTarget: observer.counts,
      newStructuralNodes: observer.nodes,
      ancestorStyleDiagnostics: (
        lastByKey.fixedRow.ancestorStyles || []
      ).slice(0, 8),
      elementsFromPointBefore: snapshots[0]?.pointHits || [],
      elementsFromPointAfterMainRowHover:
        lastByKey.mainRow.pointHits || [],
      elementsFromPointAfterFixedRowHover:
        lastByKey.fixedRow.pointHits || [],
      pseudoElementDiagnostics:
        lastByKey.operationCell.pseudo || snapshots.at(-1)?.pseudo || {},
      renderMechanismDiagnostics:
        lastByKey.operationCell.render || snapshots.at(-1)?.render || {},
      descendantsExpandedAfterHover: snapshots.some(
        (snapshot) => snapshot.descendantsExpanded
      ),
      clippingDetected,
      delegatedHoverDetected,
      portalCandidateCount: Math.max(
        0,
        ...snapshots.map((snapshot) => snapshot.portalCount || 0)
      ),
      receiptControlCandidateCount: maximumCandidates,
      uniqueReceiptControlFound: Boolean(unique),
      receiptControlMatchedBy: unique?.candidateMatchedBy || "",
      receiptControlBounds: unique?.candidateBounds || null,
      receiptControlOccluded: snapshots.some(
        (snapshot) => snapshot.candidateOccluded
      ),
      networkWriteBlocked: true,
      blockedRequestCount: guardState.blockedRequestCount,
      confirmClicked: false,
    };
    result.errorCode = classifyReceiptRowHoverDiagnostics(result);
    result.missingFields = result.errorCode
      ? ["receiptForm.entry"]
      : [];
    return result;
  } finally {
    await page
      .evaluate(({ markers }) => {
        window.__fieldDeskHoverDiagnostic?.observer?.disconnect();
        delete window.__fieldDeskHoverDiagnostic;
        Object.values(markers).forEach((marker) => {
          document
            .querySelectorAll(`[${marker}]`)
            .forEach((element) => element.removeAttribute(marker));
        });
      }, { markers })
      .catch(() => {});
    await networkGuard?.stop();
  }
}

function classifyReceiptLayoutDiagnostics(result = {}) {
  if (result.uniqueReceiptControlFound && result.revealedByScroll) {
    return "RECLOUD_RECEIPT_CONTROL_REVEALED_BY_SCROLL";
  }
  if (result.uniqueReceiptControlFound) return null;
  if (result.coveredByFixedColumn) {
    return "RECLOUD_RECEIPT_CONTROL_COVERED_BY_FIXED_COLUMN";
  }
  if (result.positionedOffscreen) {
    return "RECLOUD_RECEIPT_CONTROL_POSITIONED_OFFSCREEN";
  }
  if (result.clippingDetected) return "RECLOUD_RECEIPT_CONTENT_CLIPPED";
  return "RECLOUD_RECEIPT_CONTROL_NOT_RENDERED";
}

async function diagnoseReceiptControlLayout(page, options = {}) {
  if (options.dryRun !== true || options.writeEnabled !== false) {
    const error = new Error("签收布局诊断只允许在严格只读模式下执行");
    error.code = "RECLOUD_RECEIPT_INSPECTION_UNSAFE";
    error.status = 403;
    throw error;
  }
  assertRecloudAuthenticated(page);
  const fixed = await diagnoseFixedReceiptOperation(page, options);
  const base = {
    layoutBeforeHover: {},
    layoutByScrollPosition: [],
    mutationDiagnostics: [],
    pointHitDiagnostics: [],
    scrollContainerFound: false,
    scrollPositionsChecked: [],
    originalScrollLeftRestored: false,
    clippingDetected: false,
    positionedOffscreen: false,
    coveredByFixedColumn: false,
    groupZeroSizedWithVisibleChildren: false,
    renderMechanismDiagnostics: {},
    receiptControlCandidateCount: 0,
    uniqueReceiptControlFound: false,
    matchedBy: "",
    receiptControlBounds: null,
    revealedByScroll: false,
    networkWriteBlocked: false,
    blockedRequestCount: 0,
    confirmClicked: false,
    missingFields: [],
    errorCode: null,
  };
  if (!fixed.fixedRightRowMatched || !fixed.operationCellFound) {
    return {
      ...base,
      missingFields: fixed.missingFields,
      errorCode: fixed.errorCode,
    };
  }

  const markers = {
    main: "data-fielddesk-layout-main-row",
    fixed: "data-fielddesk-layout-fixed-row",
    cell: "data-fielddesk-layout-operation-cell",
    scroll: "data-fielddesk-layout-scroll",
  };
  const marked = await page.evaluate(
    ({ fixed, markers }) => {
      Object.values(markers).forEach((marker) =>
        document
          .querySelectorAll(`[${marker}]`)
          .forEach((element) => element.removeAttribute(marker))
      );
      const close = (a, b) => Math.abs(Number(a) - Number(b)) <= 2;
      const fixedSelector =
        ".el-table__fixed-right,.el-table__fixed-right-wrapper,[class*='fixed-right'],[class*='fixedRight']";
      const rows = [
        ...document.querySelectorAll(
          "tr,[role='row'],.el-table__row,[class*='table-row'],[class*='virtual-row']"
        ),
      ];
      const rowMatches = (element, y, height) => {
        const box = element.getBoundingClientRect();
        return close(box.y, y) && close(box.height, height) && box.width > 0;
      };
      const mainRows = rows.filter(
        (element) =>
          !element.closest(fixedSelector) &&
          rowMatches(
            element,
            fixed.targetMainRowTop,
            fixed.targetMainRowHeight
          )
      );
      const fixedRows = rows.filter(
        (element) =>
          element.closest(fixedSelector) &&
          rowMatches(
            element,
            fixed.fixedRightRowBounds?.y,
            fixed.fixedRightRowBounds?.height
          )
      );
      const cells = [
        ...document.querySelectorAll(
          ".el-table__fixed-right td,.el-table__fixed-right-wrapper td,[class*='fixed-right'] td,[class*='fixedRight'] td"
        ),
      ].filter((element) => {
        const box = element.getBoundingClientRect();
        const target = fixed.operationCellBounds;
        return (
          target &&
          close(box.x, target.x) &&
          close(box.y, target.y) &&
          close(box.width, target.width) &&
          close(box.height, target.height)
        );
      });
      let scrollContainer = null;
      if (mainRows.length === 1) {
        const tableRoot = mainRows[0].closest(
          ".el-table,.rtxpc-table,[role='table'],[role='grid']"
        );
        const candidates = tableRoot
          ? [
              ...tableRoot.querySelectorAll(
                ".el-table__body-wrapper,.rtxpc-table__body-wrapper,[class*='scroll'],[class*='body-wrapper']"
              ),
            ]
          : [];
        scrollContainer =
          candidates.find(
            (element) => element.scrollWidth > element.clientWidth
          ) || null;
      }
      if (mainRows.length === 1)
        mainRows[0].setAttribute(markers.main, "true");
      if (fixedRows.length === 1)
        fixedRows[0].setAttribute(markers.fixed, "true");
      if (cells.length === 1)
        cells[0].setAttribute(markers.cell, "true");
      if (scrollContainer)
        scrollContainer.setAttribute(markers.scroll, "true");
      return {
        mainCount: mainRows.length,
        fixedCount: fixedRows.length,
        cellCount: cells.length,
        scrollCount: scrollContainer ? 1 : 0,
        originalScrollLeft: scrollContainer?.scrollLeft || 0,
        maximumScrollLeft: scrollContainer
          ? Math.max(0, scrollContainer.scrollWidth - scrollContainer.clientWidth)
          : 0,
      };
    },
    { fixed, markers }
  );
  if (
    marked.mainCount !== 1 ||
    marked.fixedCount !== 1 ||
    marked.cellCount !== 1
  ) {
    return {
      ...base,
      missingFields: ["receiptForm.uniqueLayoutTargets"],
      errorCode: "RECLOUD_RECEIPT_FIXED_ROW_AMBIGUOUS",
    };
  }
  if (marked.scrollCount !== 1) {
    return {
      ...base,
      missingFields: ["receiptForm.horizontalScrollContainer"],
      errorCode: "RECLOUD_RECEIPT_CONTROL_NOT_RENDERED",
    };
  }

  const positions = [
    { name: "left", value: 0 },
    { name: "right", value: marked.maximumScrollLeft },
    { name: "current", value: marked.originalScrollLeft },
  ].filter(
    (item, index, items) =>
      items.findIndex((other) => other.value === item.value) === index
  );
  const guardState = createSimulationState();
  let networkGuard;
  const snapshots = [];
  try {
    networkGuard = await createReceiptNetworkGuard(page, guardState);
    await page.evaluate(() => {
      const safeClass = (element) =>
        String(element.className || "")
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, 12)
          .join(" ");
      window.__fieldDeskLayoutMutations = { active: "before", records: [] };
      const state = window.__fieldDeskLayoutMutations;
      state.observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) {
            if (
              node.nodeType !== Node.ELEMENT_NODE ||
              state.records.length >= 60
            )
              continue;
            const box = node.getBoundingClientRect();
            const parent = node.parentElement;
            state.records.push({
              position: state.active,
              tag: node.tagName.toLowerCase(),
              className: safeClass(node),
              parentTag: parent?.tagName?.toLowerCase() || "",
              parentClassName: parent ? safeClass(parent) : "",
              bounds: {
                x: Math.round(box.x * 10) / 10,
                y: Math.round(box.y * 10) / 10,
                width: Math.round(box.width * 10) / 10,
                height: Math.round(box.height * 10) / 10,
              },
              insideOperationCell: Boolean(
                node.closest("[data-fielddesk-layout-operation-cell='true']")
              ),
            });
          }
        }
      });
      state.observer.observe(document.body, {
        childList: true,
        subtree: true,
      });
    });

    const collect = (position, phase) =>
      page.evaluate(
        ({ markers, position, phase }) => {
          const main = document.querySelector(`[${markers.main}="true"]`);
          const fixedRow = document.querySelector(
            `[${markers.fixed}="true"]`
          );
          const cell = document.querySelector(`[${markers.cell}="true"]`);
          const scroll = document.querySelector(`[${markers.scroll}="true"]`);
          if (!main || !fixedRow || !cell || !scroll) {
            return { targetsUnique: false };
          }
          const round = (value) => Math.round(value * 10) / 10;
          const bounds = (element) => {
            const box = element.getBoundingClientRect();
            return {
              x: round(box.x),
              y: round(box.y),
              width: round(box.width),
              height: round(box.height),
            };
          };
          const safeClass = (element) =>
            String(element.className || "")
              .split(/\s+/)
              .filter(Boolean)
              .slice(0, 12)
              .join(" ");
          const layout = (element, label) => {
            if (!element) return { label, found: false };
            const style = getComputedStyle(element);
            const offsetParent = element.offsetParent;
            return {
              label,
              found: true,
              tag: element.tagName.toLowerCase(),
              className: safeClass(element),
              bounds: bounds(element),
              offsetParent: offsetParent
                ? {
                    tag: offsetParent.tagName.toLowerCase(),
                    className: safeClass(offsetParent),
                  }
                : null,
              offsetLeft: round(element.offsetLeft || 0),
              offsetTop: round(element.offsetTop || 0),
              position: style.position,
              display: style.display,
              visibility: style.visibility,
              opacity: style.opacity,
              overflow: style.overflow,
              overflowX: style.overflowX,
              overflowY: style.overflowY,
              transform: style.transform === "none" ? "none" : "present",
              left: style.left,
              right: style.right,
              top: style.top,
              width: style.width,
              height: style.height,
              minWidth: style.minWidth,
              maxWidth: style.maxWidth,
              zIndex: style.zIndex,
              clipPresent: style.clip !== "auto",
              clipPathPresent: !["none", ""].includes(style.clipPath),
            };
          };
          const tableRoot = scroll.closest(
            ".el-table,.rtxpc-table,[role='table'],[role='grid']"
          );
          const fixedRight = cell.closest(
            ".el-table__fixed-right,.el-table__fixed-right-wrapper,[class*='fixed-right'],[class*='fixedRight']"
          );
          const fixedBody = cell.closest(
            ".el-table__fixed-body-wrapper,.rtxpc-table__fixed-body-wrapper,[class*='fixed-body']"
          );
          const operation = cell.querySelector(
            ".operation.operate-option"
          );
          const group = cell.querySelector(".rt-list-button-group");
          const groupChildren = group
            ? [...group.querySelectorAll("*")].filter((element) => {
                const box = element.getBoundingClientRect();
                return box.width > 0 && box.height > 0;
              })
            : [];
          const nodes = [
            ["scrollContainer", scroll],
            ["bodyWrapper", scroll],
            ["fixedRight", fixedRight],
            ["fixedRightBodyWrapper", fixedBody],
            ["targetFixedRow", fixedRow],
            ["operationCell", cell],
            ["cell", cell.querySelector(".cell")],
            ["operation", operation],
            ["buttonGroup", group],
          ].map(([label, element]) => layout(element, label));
          const visible = (element) => {
            const box = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return (
              box.width > 0 &&
              box.height > 0 &&
              style.display !== "none" &&
              style.visibility !== "hidden"
            );
          };
          const receipt = (element) =>
            String(
              element.getAttribute("aria-label") ||
                element.getAttribute("title") ||
                element.innerText ||
                element.textContent ||
                ""
            ).trim() === "签收";
          const interactive = (element) => {
            const style = getComputedStyle(element);
            return (
              ["button", "a"].includes(element.tagName.toLowerCase()) ||
              ["button", "link"].includes(element.getAttribute("role")) ||
              element.hasAttribute("tabindex") ||
              element.hasAttribute("onclick") ||
              style.cursor === "pointer"
            );
          };
          const candidates = [
            ...cell.querySelectorAll("*"),
            ...document.querySelectorAll(
              "[role='tooltip'],[role='menu'],.el-popper,.el-popover,.el-tooltip__popper,[class*='portal'],[class*='teleport']"
            ),
          ].filter(
            (element) =>
              visible(element) && interactive(element) && receipt(element)
          );
          const deepest = candidates.filter(
            (element) =>
              !candidates.some(
                (other) => other !== element && element.contains(other)
              )
          );
          const cellBox = cell.getBoundingClientRect();
          const pointHits = [0.05, 0.5, 0.95].flatMap((ratio) =>
            document
              .elementsFromPoint(
                cellBox.x + cellBox.width * ratio,
                cellBox.y + cellBox.height / 2
              )
              .slice(0, 8)
              .map((element) => ({
                position: ratio,
                tag: element.tagName.toLowerCase(),
                className: safeClass(element),
                rolePresent: element.hasAttribute("role"),
                ariaLabelPresent: element.hasAttribute("aria-label"),
                bounds: bounds(element),
              }))
          );
          const clippingAncestors = [];
          for (let current = group || cell; current; current = current.parentElement) {
            const style = getComputedStyle(current);
            if (
              ["hidden", "clip"].includes(style.overflow) ||
              ["hidden", "clip"].includes(style.overflowX) ||
              ["hidden", "clip"].includes(style.overflowY) ||
              style.clip !== "auto" ||
              !["none", ""].includes(style.clipPath)
            ) {
              clippingAncestors.push({
                tag: current.tagName.toLowerCase(),
                className: safeClass(current),
              });
            }
            if (current === tableRoot) break;
          }
          const groupBox = group?.getBoundingClientRect();
          const fixedBox = fixedRight?.getBoundingClientRect();
          const coveredByFixed =
            Boolean(groupBox && fixedBox && groupBox.width > 0) &&
            groupBox.x < fixedBox.x + fixedBox.width &&
            groupBox.x + groupBox.width > fixedBox.x;
          const positionedOffscreen = Boolean(
            groupBox &&
              (groupBox.right < 0 ||
                groupBox.left > window.innerWidth ||
                groupBox.bottom < 0 ||
                groupBox.top > window.innerHeight)
          );
          const render = {
            pseudoBeforePresent: group
              ? !["none", "normal", '""', ""].includes(
                  getComputedStyle(group, "::before").content
                )
              : false,
            pseudoAfterPresent: group
              ? !["none", "normal", '""', ""].includes(
                  getComputedStyle(group, "::after").content
                )
              : false,
            svgCount: group?.querySelectorAll("svg,use").length || 0,
            canvasCount: group?.querySelectorAll("canvas").length || 0,
            portalCount: document.querySelectorAll(
              "[role='tooltip'],[role='menu'],.el-popper,.el-popover,.el-tooltip__popper,[class*='portal'],[class*='teleport']"
            ).length,
            absoluteDescendantCount: group
              ? [...group.querySelectorAll("*")].filter(
                  (element) =>
                    ["absolute", "fixed"].includes(
                      getComputedStyle(element).position
                    )
                ).length
              : 0,
          };
          return {
            targetsUnique: true,
            position,
            phase,
            scrollLeft: round(scroll.scrollLeft),
            layouts: nodes,
            pointHits,
            candidateCount: deepest.length,
            candidateBounds:
              deepest.length === 1 ? bounds(deepest[0]) : null,
            candidateMatchedBy:
              deepest.length === 1
                ? cell.contains(deepest[0])
                  ? "operationCell"
                  : "associatedPortal"
                : "",
            clippingDetected: clippingAncestors.length > 0,
            clippingAncestors,
            positionedOffscreen,
            coveredByFixed,
            groupZeroSizedWithVisibleChildren: Boolean(
              groupBox &&
                (groupBox.width === 0 || groupBox.height === 0) &&
                groupChildren.length > 0
            ),
            render,
          };
        },
        { markers, position, phase }
      );

    base.layoutBeforeHover = await collect("current", "before");
    for (const position of positions) {
      await page.evaluate(
        ({ marker, value, name }) => {
          const scroll = document.querySelector(`[${marker}="true"]`);
          window.__fieldDeskLayoutMutations.active = name;
          scroll.scrollLeft = value;
        },
        { marker: markers.scroll, value: position.value, name: position.name }
      );
      await page.waitForTimeout(100);
      const main = page.locator(`[${markers.main}="true"]`);
      if ((await main.count()) !== 1) {
        return {
          ...base,
          networkWriteBlocked: true,
          missingFields: ["receiptForm.mainRow"],
          errorCode: "RECLOUD_RECEIPT_FIXED_ROW_AMBIGUOUS",
        };
      }
      const mainBox = await main.boundingBox();
      if (!mainBox || mainBox.height <= 0 || mainBox.width <= 0) {
        return {
          ...base,
          networkWriteBlocked: true,
          missingFields: ["receiptForm.mainRow"],
          errorCode: "RECLOUD_RECEIPT_FIXED_ROW_AMBIGUOUS",
        };
      }
      const viewportWidth = page.viewportSize()?.width || 1280;
      await page.mouse.move(
        Math.max(
          mainBox.x + 1,
          Math.min(viewportWidth / 2, mainBox.x + mainBox.width - 1)
        ),
        mainBox.y + mainBox.height / 2
      );
      for (const delay of [100, 500, 1000]) {
        await page.waitForTimeout(delay);
        snapshots.push(await collect(position.name, delay));
      }
    }
    await networkGuard.assertSafe();
    const mutations = await page.evaluate(() => {
      const state = window.__fieldDeskLayoutMutations;
      state?.observer?.disconnect();
      return (state?.records || []).slice(0, 40);
    });
    const maximumCandidates = Math.max(
      0,
      ...snapshots.map((item) => item.candidateCount || 0)
    );
    const unique = snapshots.find((item) => item.candidateCount === 1);
    const result = {
      ...base,
      scrollContainerFound: true,
      scrollPositionsChecked: positions.map((item) => item.name),
      layoutByScrollPosition: positions.map((position) => {
        const snapshot =
          [...snapshots]
            .reverse()
            .find((item) => item.position === position.name) || {};
        return {
          position: position.name,
          scrollLeft: snapshot.scrollLeft,
          layouts: snapshot.layouts || [],
          candidateCount: snapshot.candidateCount || 0,
          clippingDetected: Boolean(snapshot.clippingDetected),
          positionedOffscreen: Boolean(snapshot.positionedOffscreen),
          coveredByFixed: Boolean(snapshot.coveredByFixed),
        };
      }),
      mutationDiagnostics: mutations,
      pointHitDiagnostics: snapshots.flatMap((item) =>
        (item.pointHits || []).map((hit) => ({
          position: item.position,
          phase: item.phase,
          ...hit,
        }))
      ).slice(0, 72),
      clippingDetected: snapshots.some((item) => item.clippingDetected),
      positionedOffscreen: snapshots.some((item) => item.positionedOffscreen),
      coveredByFixedColumn: snapshots.some((item) => item.coveredByFixed),
      groupZeroSizedWithVisibleChildren: snapshots.some(
        (item) => item.groupZeroSizedWithVisibleChildren
      ),
      renderMechanismDiagnostics: snapshots.at(-1)?.render || {},
      receiptControlCandidateCount: maximumCandidates,
      uniqueReceiptControlFound: Boolean(unique),
      matchedBy: unique?.candidateMatchedBy || "",
      receiptControlBounds: unique?.candidateBounds || null,
      revealedByScroll: Boolean(
        unique && unique.position !== "current"
      ),
      networkWriteBlocked: true,
      blockedRequestCount: guardState.blockedRequestCount,
      confirmClicked: false,
    };
    result.errorCode = classifyReceiptLayoutDiagnostics(result);
    result.missingFields = result.errorCode &&
      result.errorCode !== "RECLOUD_RECEIPT_CONTROL_REVEALED_BY_SCROLL"
      ? ["receiptForm.entry"]
      : [];
    return result;
  } finally {
    await page
      .evaluate(
        ({ markers, originalScrollLeft }) => {
          window.__fieldDeskLayoutMutations?.observer?.disconnect();
          delete window.__fieldDeskLayoutMutations;
          const scroll = document.querySelector(
            `[${markers.scroll}="true"]`
          );
          if (scroll) scroll.scrollLeft = originalScrollLeft;
          Object.values(markers).forEach((marker) =>
            document
              .querySelectorAll(`[${marker}]`)
              .forEach((element) => element.removeAttribute(marker))
          );
        },
        { markers, originalScrollLeft: marked.originalScrollLeft }
      )
      .then(() => {
        base.originalScrollLeftRestored = true;
      })
      .catch(() => {});
    await networkGuard?.stop();
  }
}

function classifyReceiptVueState(result = {}) {
  if (!result.vueStateAvailable) {
    return "RECLOUD_RECEIPT_VUE_STATE_UNAVAILABLE";
  }
  if (result.permissionDenied === true) {
    return "RECLOUD_RECEIPT_HIDDEN_BY_PERMISSION";
  }
  if (result.statusAllowsReceipt === false) {
    return "RECLOUD_RECEIPT_HIDDEN_BY_STATUS";
  }
  if ((result.requiredMissingFieldNames || []).length > 0) {
    return "RECLOUD_RECEIPT_REQUIRED_ROW_FIELD_MISSING";
  }
  if (result.operationDataLoaded === false) {
    return "RECLOUD_RECEIPT_OPERATION_DATA_NOT_LOADED";
  }
  if (
    result.operationDataLoaded === true &&
    result.operationDefinitionExists === false
  ) {
    return "RECLOUD_RECEIPT_OPERATION_LIST_EMPTY";
  }
  if (
    result.operationListFound &&
    (result.filteredOperationCount || 0) === 0
  ) {
    return "RECLOUD_RECEIPT_OPERATION_LIST_EMPTY";
  }
  return null;
}

async function diagnoseReceiptVueState(page, options = {}) {
  if (options.dryRun !== true || options.writeEnabled !== false) {
    const error = new Error("签收 Vue 状态诊断只允许在严格只读模式下执行");
    error.code = "RECLOUD_RECEIPT_INSPECTION_UNSAFE";
    error.status = 403;
    throw error;
  }
  assertRecloudAuthenticated(page);
  const fixed = await diagnoseFixedReceiptOperation(page, options);
  const base = {
    vueStateAvailable: false,
    vueVersionHints: [],
    componentCount: 0,
    componentNames: [],
    inspectedStateFieldNames: [],
    operationDefinitionExists: false,
    operationListFound: false,
    rawOperationCount: 0,
    filteredOperationCount: 0,
    operationItems: [],
    filteringConditions: {
      vIfPresent: false,
      vShowPresent: false,
      permissionDirectivePresent: false,
      statusConditionPresent: false,
    },
    statusFieldNames: [],
    statusEnums: [],
    statusAllowsReceipt: null,
    permissionFieldNames: [],
    permissionBooleans: [],
    permissionDenied: null,
    requiredMissingFieldNames: [],
    asyncFieldNames: [],
    operationDataLoaded: null,
    networkWriteBlocked: false,
    blockedRequestCount: 0,
    confirmClicked: false,
    missingFields: [],
    errorCode: null,
  };
  if (!fixed.fixedRightRowMatched || !fixed.operationCellFound) {
    return {
      ...base,
      missingFields: fixed.missingFields,
      errorCode: fixed.errorCode,
    };
  }

  const guardState = createSimulationState();
  let networkGuard;
  try {
    networkGuard = await createReceiptNetworkGuard(page, guardState);
    const result = await page.evaluate(
      ({ cellBounds }) => {
        const close = (a, b) => Math.abs(Number(a) - Number(b)) <= 2;
        const cells = [
          ...document.querySelectorAll(
            ".el-table__fixed-right td,.el-table__fixed-right-wrapper td,[class*='fixed-right'] td,[class*='fixedRight'] td"
          ),
        ].filter((element) => {
          const box = element.getBoundingClientRect();
          return (
            close(box.x, cellBounds.x) &&
            close(box.y, cellBounds.y) &&
            close(box.width, cellBounds.width) &&
            close(box.height, cellBounds.height)
          );
        });
        if (cells.length !== 1) {
          return { uniqueCell: false };
        }
        const cell = cells[0];
        const componentRecords = [];
        const seen = new Set();
        const addComponent = (instance, version, sourceDepth) => {
          if (!instance || typeof instance !== "object" || seen.has(instance))
            return;
          seen.add(instance);
          componentRecords.push({ instance, version, sourceDepth });
        };
        let element = cell;
        for (let depth = 0; element && depth < 10; depth += 1) {
          for (const property of Object.getOwnPropertyNames(element)) {
            if (
              property === "__vue__" ||
              property === "__vueParentComponent" ||
              property.startsWith("__vueParentComponent$")
            ) {
              addComponent(
                element[property],
                property === "__vue__" ? "vue2" : "vue3",
                depth
              );
            }
          }
          element = element.parentElement;
        }
        const expanded = [...componentRecords];
        for (const record of expanded) {
          let parent =
            record.version === "vue3"
              ? record.instance.parent
              : record.instance.$parent;
          for (let depth = 0; parent && depth < 8; depth += 1) {
            addComponent(parent, record.version, record.sourceDepth + depth + 1);
            parent =
              record.version === "vue3" ? parent.parent : parent.$parent;
          }
        }
        const safeKey = (value) =>
          /^[A-Za-z_$][A-Za-z0-9_$.-]{0,79}$/.test(String(value || ""));
        const safeCode = (value) =>
          /^[A-Z][A-Z0-9_-]{1,39}$/.test(String(value || ""))
            ? String(value)
            : "";
        const allowedNames = new Set([
          "签收",
          "查看",
          "详情",
          "编辑",
          "删除",
          "更多",
        ]);
        const allowedEnums = new Set([
          "待签收",
          "已签收",
          "不可签收",
          "签收中",
          "PENDING_RECEIPT",
          "RECEIPT_PENDING",
          "RECEIVED",
          "SIGNED",
          "DISABLED",
          "ENABLED",
          "LOADING",
          "LOADED",
        ]);
        const stateKeyPattern =
          /action|operation|button|menu|permission|auth|receive|receipt|sign|status|state|visible|enable|disable|loading|loaded|row|item/i;
        const operationKeyPattern = /action|operation|button|menu/i;
        const permissionKeyPattern =
          /permission|auth|receive|receipt|sign|visible|enable|disable/i;
        const statusKeyPattern = /status|state/i;
        const asyncKeyPattern = /loading|loaded|pending|fetch|request/i;
        const requiredKeyPattern =
          /(?:^|_)(?:id|status|state|permission|product|item|row|receive|receipt|sign)(?:$|_)/i;
        const componentNames = [];
        const fieldNames = new Set();
        const statusFieldNames = new Set();
        const statusEnums = new Set();
        const permissionFieldNames = new Set();
        const permissionBooleans = [];
        const requiredMissing = new Set();
        const asyncFieldNames = new Set();
        const operationLists = [];
        let permissionDirectivePresent = false;
        let vIfPresent = false;
        let vShowPresent = false;
        const inspectObject = (object, source, depth = 0) => {
          if (!object || typeof object !== "object" || depth > 1) return;
          for (const key of Object.keys(object).slice(0, 300)) {
            if (!safeKey(key) || !stateKeyPattern.test(key)) continue;
            fieldNames.add(key);
            let value;
            try {
              value = object[key];
            } catch {
              continue;
            }
            if (statusKeyPattern.test(key)) {
              statusFieldNames.add(key);
              if (allowedEnums.has(value)) statusEnums.add(value);
            }
            if (permissionKeyPattern.test(key)) {
              permissionFieldNames.add(key);
              if (typeof value === "boolean") {
                permissionBooleans.push({ fieldName: key, value });
              }
            }
            if (asyncKeyPattern.test(key)) asyncFieldNames.add(key);
            if (
              requiredKeyPattern.test(key) &&
              (value === null || value === undefined || value === "")
            ) {
              requiredMissing.add(key);
            }
            if (operationKeyPattern.test(key) && Array.isArray(value)) {
              operationLists.push({ fieldName: key, value, source });
            }
            if (
              depth === 0 &&
              value &&
              typeof value === "object" &&
              !Array.isArray(value)
            ) {
              inspectObject(value, `${source}.${key}`, depth + 1);
            }
          }
        };
        for (const record of componentRecords.slice(0, 20)) {
          const instance = record.instance;
          const type =
            record.version === "vue3"
              ? instance.type
              : instance.$options;
          const componentName =
            type?.name || type?.__name || type?._componentTag || "";
          if (
            typeof componentName === "string" &&
            /^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(componentName)
          ) {
            componentNames.push(componentName);
          }
          const sources =
            record.version === "vue3"
              ? [
                  ["props", instance.props],
                  ["data", instance.data],
                  ["setupState", instance.setupState],
                  ["ctx", instance.ctx],
                ]
              : [
                  ["props", instance.$props],
                  ["data", instance.$data],
                ];
          for (const [source, object] of sources) {
            inspectObject(object, source);
          }
          const vnode =
            record.version === "vue3" ? instance.vnode : instance._vnode;
          const directives =
            vnode?.dirs || vnode?.data?.directives || [];
          for (const directive of Array.isArray(directives) ? directives : []) {
            const name =
              directive?.dir?.name ||
              directive?.name ||
              directive?.rawName ||
              "";
            if (/permission|auth/i.test(name))
              permissionDirectivePresent = true;
            if (/^v?-?show$/i.test(name)) vShowPresent = true;
            if (/^v?-?if$/i.test(name)) vIfPresent = true;
          }
        }
        const operationItems = [];
        let rawOperationCount = 0;
        let filteredOperationCount = 0;
        for (const list of operationLists.slice(0, 10)) {
          rawOperationCount = Math.max(rawOperationCount, list.value.length);
          for (const item of list.value.slice(0, 30)) {
            if (!item || typeof item !== "object") continue;
            const fieldNames = Object.keys(item)
              .filter(safeKey)
              .filter((key) =>
                /code|type|name|label|visible|enable|disable|permission|auth/i.test(
                  key
                )
              )
              .slice(0, 20);
            const code =
              safeCode(item.code) ||
              safeCode(item.type) ||
              safeCode(item.actionCode);
            const nameCandidate =
              item.name || item.label || item.title || item.text;
            const visible =
              typeof item.visible === "boolean"
                ? item.visible
                : typeof item.show === "boolean"
                  ? item.show
                  : null;
            const enabled =
              typeof item.enabled === "boolean"
                ? item.enabled
                : typeof item.disabled === "boolean"
                  ? !item.disabled
                  : null;
            const permission =
              typeof item.permission === "boolean"
                ? item.permission
                : typeof item.authorized === "boolean"
                  ? item.authorized
                  : null;
            if (visible !== false && enabled !== false && permission !== false)
              filteredOperationCount += 1;
            operationItems.push({
              fieldNames,
              operationCode: code,
              operationName: allowedNames.has(nameCandidate)
                ? nameCandidate
                : "",
              visible,
              enabled,
              permission,
            });
          }
        }
        const permissionValues = permissionBooleans.map((item) => item.value);
        const permissionDenied =
          permissionValues.length > 0 && permissionValues.every((value) => !value);
        const statusList = [...statusEnums];
        const statusAllowsReceipt = statusList.includes("待签收") ||
          statusList.includes("PENDING_RECEIPT") ||
          statusList.includes("RECEIPT_PENDING")
          ? true
          : statusList.some((value) =>
              ["已签收", "不可签收", "RECEIVED", "SIGNED", "DISABLED"].includes(
                value
              )
            )
            ? false
            : null;
        const loadingValues = [];
        for (const record of componentRecords.slice(0, 20)) {
          const sources =
            record.version === "vue3"
              ? [record.instance.props, record.instance.data, record.instance.setupState]
              : [record.instance.$props, record.instance.$data];
          for (const source of sources) {
            if (!source || typeof source !== "object") continue;
            for (const key of Object.keys(source)) {
              if (!asyncKeyPattern.test(key)) continue;
              try {
                if (typeof source[key] === "boolean") loadingValues.push({
                  key,
                  value: source[key],
                });
              } catch {}
            }
          }
        }
        const explicitlyLoading = loadingValues.some(
          ({ key, value }) => /loading|pending|fetching/i.test(key) && value
        );
        const explicitlyLoaded = loadingValues.some(
          ({ key, value }) =>
            /(?:^|schema|data)loaded$/i.test(key) && value
        );
        return {
          uniqueCell: true,
          vueStateAvailable: componentRecords.length > 0,
          vueVersionHints: [
            ...new Set(componentRecords.map((record) => record.version)),
          ],
          componentCount: componentRecords.length,
          componentNames: [...new Set(componentNames)].slice(0, 20),
          inspectedStateFieldNames: [...fieldNames].slice(0, 100),
          operationDefinitionExists:
            operationLists.length > 0 || operationItems.length > 0,
          operationListFound: operationLists.length > 0,
          rawOperationCount,
          filteredOperationCount,
          operationItems: operationItems.slice(0, 30),
          filteringConditions: {
            vIfPresent,
            vShowPresent,
            permissionDirectivePresent,
            statusConditionPresent: statusFieldNames.size > 0,
          },
          statusFieldNames: [...statusFieldNames].slice(0, 30),
          statusEnums: statusList,
          statusAllowsReceipt,
          permissionFieldNames: [...permissionFieldNames].slice(0, 30),
          permissionBooleans: permissionBooleans.slice(0, 30),
          permissionDenied:
            permissionValues.length > 0 ? permissionDenied : null,
          requiredMissingFieldNames: [...requiredMissing].slice(0, 30),
          asyncFieldNames: [...asyncFieldNames].slice(0, 30),
          operationDataLoaded: explicitlyLoading
            ? false
            : explicitlyLoaded || operationLists.length > 0
              ? true
              : null,
        };
      },
      { cellBounds: fixed.operationCellBounds }
    );
    await networkGuard.assertSafe();
    if (!result.uniqueCell) {
      return {
        ...base,
        networkWriteBlocked: true,
        missingFields: ["receiptForm.operationCell"],
        errorCode: "RECLOUD_RECEIPT_FIXED_ROW_AMBIGUOUS",
      };
    }
    const output = {
      ...base,
      ...result,
      networkWriteBlocked: true,
      blockedRequestCount: guardState.blockedRequestCount,
      confirmClicked: false,
    };
    output.errorCode = classifyReceiptVueState(output);
    output.missingFields = output.errorCode
      ? ["receiptForm.vueState"]
      : [];
    return output;
  } finally {
    await networkGuard?.stop();
  }
}

function classifyReceiptOperationSource(result = {}) {
  if (
    result.receiptActionPresentBeforeFilter &&
    !result.receiptActionPresentAfterFilter
  ) {
    return "RECLOUD_RECEIPT_ACTION_FILTERED_BY_CONDITION";
  }
  if (
    result.operationSourceType === "rowData" &&
    !result.receiptActionPresentBeforeFilter
  ) {
    return "RECLOUD_RECEIPT_ACTION_MISSING_FROM_ROW_DATA";
  }
  if (
    result.operationSourceType === "apiResponse" &&
    !result.receiptActionPresentBeforeFilter
  ) {
    return "RECLOUD_RECEIPT_ACTION_MISSING_FROM_API";
  }
  if (
    result.operationColumnFound &&
    ["columnSchema", "scopedSlot", "pageActions"].includes(
      result.operationSourceType
    ) &&
    !result.receiptActionPresentBeforeFilter
  ) {
    return "RECLOUD_RECEIPT_ACTION_MISSING_FROM_SCHEMA";
  }
  return "RECLOUD_RECEIPT_OPERATION_SOURCE_UNAVAILABLE";
}

async function diagnoseReceiptOperationSource(page, options = {}) {
  if (options.dryRun !== true || options.writeEnabled !== false) {
    const error = new Error("签收操作来源诊断只允许在严格只读模式下执行");
    error.code = "RECLOUD_RECEIPT_INSPECTION_UNSAFE";
    error.status = 403;
    throw error;
  }
  assertRecloudAuthenticated(page);
  const fixed = await diagnoseFixedReceiptOperation(page, options);
  const base = {
    operationSourceType: "unavailable",
    operationColumnFound: false,
    operationSlotFound: false,
    actionConfigFound: false,
    rowActionFieldNames: [],
    rawActionCount: 0,
    filteredActionCount: 0,
    actionNames: [],
    actionFilterConditionNames: [],
    receiptActionPresentBeforeFilter: false,
    receiptActionPresentAfterFilter: false,
    componentDiagnostics: [],
    columnSchemaFieldNames: [],
    networkActionResponses: options.networkActionResponses || [],
    networkWriteBlocked: false,
    blockedRequestCount: 0,
    confirmClicked: false,
    missingFields: [],
    errorCode: null,
  };
  if (!fixed.fixedRightRowMatched || !fixed.operationCellFound) {
    return {
      ...base,
      missingFields: fixed.missingFields,
      errorCode: fixed.errorCode,
    };
  }
  const guardState = createSimulationState();
  let networkGuard;
  try {
    networkGuard = await createReceiptNetworkGuard(page, guardState);
    const state = await page.evaluate(
      ({ cellBounds }) => {
        const close = (a, b) => Math.abs(Number(a) - Number(b)) <= 2;
        const cells = [
          ...document.querySelectorAll(
            ".el-table__fixed-right td,.el-table__fixed-right-wrapper td,[class*='fixed-right'] td,[class*='fixedRight'] td"
          ),
        ].filter((element) => {
          const box = element.getBoundingClientRect();
          return (
            close(box.x, cellBounds.x) &&
            close(box.y, cellBounds.y) &&
            close(box.width, cellBounds.width) &&
            close(box.height, cellBounds.height)
          );
        });
        if (cells.length !== 1) return { uniqueCell: false };
        const safeKey = (value) =>
          /^[A-Za-z_$][A-Za-z0-9_$.-]{0,79}$/.test(String(value || ""));
        const allowedActions = new Set([
          "签收",
          "查看",
          "详情",
          "编辑",
          "删除",
          "更多",
        ]);
        const components = [];
        const seenComponents = new Set();
        const add = (instance, depth) => {
          if (!instance || typeof instance !== "object" || seenComponents.has(instance))
            return;
          seenComponents.add(instance);
          components.push({ instance, depth });
        };
        let element = cells[0];
        for (let depth = 0; element && depth < 10; depth += 1) {
          if (element.__vue__) add(element.__vue__, depth);
          element = element.parentElement;
        }
        for (const record of [...components]) {
          let parent = record.instance.$parent;
          for (let depth = 0; parent && depth < 10; depth += 1) {
            add(parent, record.depth + depth + 1);
            parent = parent.$parent;
          }
        }
        const componentDiagnostics = [];
        const schemaFields = new Set();
        const rowActionFields = new Set();
        const actionFilterConditions = new Set();
        const actionNames = new Set();
        const actionRecords = [];
        let operationColumnFound = false;
        let operationSlotFound = false;
        let columnSchemaFound = false;
        let pageActionsFound = false;
        let rowActionsFound = false;
        const visited = new Set();
        const actionCandidate = (item) => {
          if (!item || typeof item !== "object") return null;
          const candidate =
            item.name || item.label || item.title || item.text;
          const name = allowedActions.has(candidate) ? candidate : "";
          const visible =
            typeof item.visible === "boolean"
              ? item.visible
              : typeof item.show === "boolean"
                ? item.show
                : null;
          const enabled =
            typeof item.enabled === "boolean"
              ? item.enabled
              : typeof item.disabled === "boolean"
                ? !item.disabled
                : null;
          const permission =
            typeof item.permission === "boolean"
              ? item.permission
              : typeof item.authorized === "boolean"
                ? item.authorized
                : null;
          for (const key of Object.keys(item)) {
            if (
              safeKey(key) &&
              /visible|show|enable|disable|permission|auth|status|state/i.test(
                key
              )
            ) {
              actionFilterConditions.add(key);
            }
          }
          return {
            name,
            visible,
            enabled,
            permission,
            afterFilter:
              visible !== false && enabled !== false && permission !== false,
          };
        };
        const inspect = (value, path = [], source = "component", depth = 0) => {
          if (!value || typeof value !== "object" || depth > 5) return;
          if (visited.has(value)) return;
          visited.add(value);
          if (Array.isArray(value)) {
            const fieldName = path.at(-1) || "";
            if (/column|schema/i.test(fieldName)) {
              columnSchemaFound = true;
              schemaFields.add(fieldName);
              for (const column of value.slice(0, 100)) {
                if (!column || typeof column !== "object") continue;
                const label =
                  column.label ||
                  column.title ||
                  column.name ||
                  column.header;
                const prop =
                  column.prop || column.key || column.field || column.type;
                if (
                  label === "操作" ||
                  /operation|action/i.test(String(prop || ""))
                ) {
                  operationColumnFound = true;
                }
              }
            }
            if (/action|operation|button|menu/i.test(fieldName)) {
              if (source === "row") {
                rowActionsFound = true;
                rowActionFields.add(fieldName);
              } else {
                pageActionsFound = true;
              }
              for (const item of value.slice(0, 100)) {
                const record = actionCandidate(item);
                if (!record) continue;
                actionRecords.push(record);
                if (record.name) actionNames.add(record.name);
              }
            }
            for (const item of value.slice(0, 100)) {
              inspect(item, path, source, depth + 1);
            }
            return;
          }
          for (const [key, child] of Object.entries(value).slice(0, 300)) {
            if (!safeKey(key)) continue;
            if (/column|schema/i.test(key)) schemaFields.add(key);
            inspect(child, [...path, key], source, depth + 1);
          }
        };
        for (const { instance } of components.slice(0, 25)) {
          const options = instance.$options || {};
          const componentName =
            options.name || options._componentTag || "";
          const scopedSlotNames = Object.keys(instance.$scopedSlots || {})
            .filter(safeKey)
            .slice(0, 30);
          const slotNames = Object.keys(instance.$slots || {})
            .filter(safeKey)
            .slice(0, 30);
          const operationSlots = [...scopedSlotNames, ...slotNames].filter(
            (name) => /operation|action|button|menu/i.test(name)
          );
          if (operationSlots.length > 0) operationSlotFound = true;
          componentDiagnostics.push({
            componentName:
              typeof componentName === "string" &&
              /^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(componentName)
                ? componentName
                : "",
            scopedSlotNames,
            slotNames,
            renderFunctionPresent: typeof options.render === "function",
            operationSlotNames: operationSlots,
          });
          inspect(instance.$props, ["props"], "component");
          inspect(instance.$data, ["data"], "component");
          const row =
            instance.$props?.row ||
            instance.$data?.row ||
            instance.$props?.scope?.row ||
            instance.$data?.currentRow;
          if (row && typeof row === "object") {
            for (const key of Object.keys(row)) {
              if (
                safeKey(key) &&
                /action|operation|button|menu/i.test(key)
              ) {
                rowActionFields.add(key);
              }
            }
            inspect(row, ["row"], "row");
          }
        }
        const rawActionCount = actionRecords.length;
        const filteredActionCount = actionRecords.filter(
          (item) => item.afterFilter
        ).length;
        const receiptBefore = actionRecords.some(
          (item) => item.name === "签收"
        );
        const receiptAfter = actionRecords.some(
          (item) => item.name === "签收" && item.afterFilter
        );
        let operationSourceType = "unavailable";
        if (rowActionsFound || rowActionFields.size > 0)
          operationSourceType = "rowData";
        else if (pageActionsFound) operationSourceType = "pageActions";
        else if (operationSlotFound) operationSourceType = "scopedSlot";
        else if (columnSchemaFound || operationColumnFound)
          operationSourceType = "columnSchema";
        return {
          uniqueCell: true,
          operationSourceType,
          operationColumnFound,
          operationSlotFound,
          actionConfigFound: rawActionCount > 0,
          rowActionFieldNames: [...rowActionFields].slice(0, 30),
          rawActionCount,
          filteredActionCount,
          actionNames: [...actionNames],
          actionFilterConditionNames: [...actionFilterConditions].slice(0, 30),
          receiptActionPresentBeforeFilter: receiptBefore,
          receiptActionPresentAfterFilter: receiptAfter,
          componentDiagnostics: componentDiagnostics.slice(0, 25),
          columnSchemaFieldNames: [...schemaFields].slice(0, 50),
        };
      },
      { cellBounds: fixed.operationCellBounds }
    );
    await networkGuard.assertSafe();
    if (!state.uniqueCell) {
      return {
        ...base,
        networkWriteBlocked: true,
        missingFields: ["receiptForm.operationCell"],
        errorCode: "RECLOUD_RECEIPT_FIXED_ROW_AMBIGUOUS",
      };
    }
    const networkResponses = options.networkActionResponses || [];
    const networkActionCount = networkResponses.reduce(
      (total, response) =>
        total +
        (response.actionArrays || []).reduce(
          (count, array) => count + Number(array.count || 0),
          0
        ),
      0
    );
    const networkNames = [
      ...new Set(
        networkResponses.flatMap((response) =>
          (response.actionArrays || []).flatMap(
            (array) => array.actionNames || []
          )
        )
      ),
    ];
    const merged = {
      ...base,
      ...state,
      networkActionResponses: networkResponses,
      networkWriteBlocked: true,
      blockedRequestCount: guardState.blockedRequestCount,
      confirmClicked: false,
    };
    if (
      merged.operationSourceType === "unavailable" &&
      networkActionCount > 0
    ) {
      merged.operationSourceType = "apiResponse";
      merged.actionConfigFound = true;
      merged.rawActionCount = networkActionCount;
      merged.filteredActionCount = networkActionCount;
      merged.actionNames = networkNames;
      merged.receiptActionPresentBeforeFilter =
        networkNames.includes("签收");
      merged.receiptActionPresentAfterFilter =
        networkNames.includes("签收");
    }
    merged.errorCode = classifyReceiptOperationSource(merged);
    merged.missingFields = merged.errorCode
      ? ["receiptForm.operationSource"]
      : [];
    return merged;
  } finally {
    await networkGuard?.stop();
  }
}

function classifyReceiptRendererConfig(result = {}) {
  if (!result.mainOperationColumnFound || !result.fixedOperationColumnFound) {
    return "RECLOUD_RECEIPT_OPERATION_SOURCE_UNAVAILABLE";
  }
  if (result.configLostInFixedClone) {
    return "RECLOUD_RECEIPT_RENDERER_LOST_IN_FIXED_CLONE";
  }
  if (!result.mainRendererKeyPresent) {
    return "RECLOUD_RECEIPT_RENDERER_KEY_MISSING";
  }
  if (!result.rendererRegistered) {
    return "RECLOUD_RECEIPT_RENDERER_NOT_REGISTERED";
  }
  if (
    result.pageActionSourceKeyPresent &&
    !result.pageActionConfigPresent
  ) {
    return "RECLOUD_RECEIPT_PAGE_ACTION_CONFIG_MISSING";
  }
  return "RECLOUD_RECEIPT_RENDERER_CONFIG_EMPTY";
}

async function diagnoseReceiptRendererConfig(page, options = {}) {
  if (options.dryRun !== true || options.writeEnabled !== false) {
    const error = new Error("签收 renderer 配置诊断只允许在严格只读模式下执行");
    error.code = "RECLOUD_RECEIPT_INSPECTION_UNSAFE";
    error.status = 403;
    throw error;
  }
  assertRecloudAuthenticated(page);
  const fixed = await diagnoseFixedReceiptOperation(page, options);
  const base = {
    mainOperationColumnFound: false,
    fixedOperationColumnFound: false,
    mainRendererKeyPresent: false,
    fixedRendererKeyPresent: false,
    rendererRegistered: false,
    pageActionSourceKeyPresent: false,
    pageActionConfigPresent: false,
    pageActionCount: 0,
    configLostInFixedClone: false,
    mainColumnConfig: [],
    fixedColumnConfig: [],
    rendererRegistrationDiagnostics: [],
    missingFields: [],
    networkWriteBlocked: false,
    blockedRequestCount: 0,
    confirmClicked: false,
    errorCode: "",
  };
  if (!fixed.fixedRightRowMatched || !fixed.operationCellFound) {
    return {
      ...base,
      missingFields: fixed.missingFields,
      errorCode: "RECLOUD_RECEIPT_OPERATION_SOURCE_UNAVAILABLE",
    };
  }
  const guardState = createSimulationState();
  let networkGuard;
  try {
    networkGuard = await createReceiptNetworkGuard(page, guardState);
    const result = await page.evaluate(
      ({ cellBounds }) => {
        const close = (a, b) => Math.abs(Number(a) - Number(b)) <= 2;
        const fixedCells = [
          ...document.querySelectorAll(
            ".el-table__fixed-right td,.el-table__fixed-right-wrapper td,[class*='fixed-right'] td,[class*='fixedRight'] td"
          ),
        ].filter((element) => {
          const box = element.getBoundingClientRect();
          return (
            close(box.x, cellBounds.x) &&
            close(box.y, cellBounds.y) &&
            close(box.width, cellBounds.width) &&
            close(box.height, cellBounds.height)
          );
        });
        if (fixedCells.length !== 1) return { uniqueCell: false };
        const cell = fixedCells[0];
        const classTokens = String(cell.className || "").split(/\s+/);
        const columnClass =
          classTokens.find((token) => /column[_-]\d+$/i.test(token)) || "";
        const safeKey = (value) =>
          /^[A-Za-z_$][A-Za-z0-9_$.-]{0,79}$/.test(String(value || ""));
        const safeEnum = (value) => {
          if (
            typeof value !== "string" ||
            value.length > 80 ||
            !/^[A-Za-z_$][A-Za-z0-9_$.-]*$/.test(value)
          )
            return "";
          return value;
        };
        const allowedConfigKeys = new Set([
          "columns",
          "originColumns",
          "rightFixedColumns",
          "columnConfig",
          "tableColumnProps",
          "schema",
          "schemas",
          "slots",
          "scopedSlots",
          "render",
          "renderer",
          "renderCell",
          "component",
          "componentName",
          "actions",
          "operation",
          "menu",
          "buttons",
          "prop",
          "field",
          "key",
          "type",
          "name",
          "dependencies",
          "dependencyKeys",
          "rendererKey",
          "slotName",
          "actionSourceKey",
          "columnKey",
          "id",
          "columnId",
          "label",
          "title",
          "fixed",
        ]);
        const rendererKeyNames = [
          "rendererKey",
          "slotName",
          "renderer",
          "render",
          "renderCell",
          "component",
          "componentName",
        ];
        const actionSourceNames = [
          "actionSourceKey",
          "actions",
          "operation",
          "menu",
          "buttons",
        ];
        const components = [];
        const seen = new Set();
        const add = (instance) => {
          if (!instance || typeof instance !== "object" || seen.has(instance))
            return;
          seen.add(instance);
          components.push(instance);
        };
        let element = cell;
        for (let depth = 0; element && depth < 10; depth += 1) {
          if (element.__vue__) add(element.__vue__);
          element = element.parentElement;
        }
        for (const instance of [...components]) {
          let parent = instance.$parent;
          for (let depth = 0; parent && depth < 10; depth += 1) {
            add(parent);
            parent = parent.$parent;
          }
        }
        const arraySources = [];
        const registrySources = [];
        const pageSources = [];
        const visited = new Set();
        const collect = (value, key = "", depth = 0) => {
          if (!value || typeof value !== "object" || depth > 5) return;
          if (visited.has(value)) return;
          visited.add(value);
          if (Array.isArray(value)) {
            if (
              ["columns", "originColumns", "rightFixedColumns"].includes(key)
            ) {
              arraySources.push({ key, value });
            }
            for (const item of value.slice(0, 100)) {
              collect(item, key, depth + 1);
            }
            return;
          }
          for (const [childKey, child] of Object.entries(value).slice(0, 300)) {
            if (!safeKey(childKey)) continue;
            if (
              /renderer|component|registry|renderMap/i.test(childKey) &&
              child &&
              typeof child === "object"
            ) {
              registrySources.push({ key: childKey, value: child });
            }
            if (
              /action|operation|button|menu/i.test(childKey)
            ) {
              pageSources.push({ key: childKey, value: child });
            }
            collect(child, childKey, depth + 1);
          }
        };
        for (const instance of components.slice(0, 25)) {
          collect(instance.$props, "props");
          collect(instance.$data, "data");
          collect(instance.$options?.components, "components");
          if (instance.store?.states) collect(instance.store.states, "states");
        }
        const isOperationColumn = (column) => {
          if (!column || typeof column !== "object") return false;
          const label =
            column.label || column.title || column.name || column.header;
          const identifier =
            column.id ||
            column.columnId ||
            column.columnKey ||
            column.key ||
            column.prop ||
            column.field;
          return (
            label === "操作" ||
            (columnClass && identifier === columnClass) ||
            /operation|action/i.test(String(identifier || ""))
          );
        };
        const mainCandidates = [];
        const fixedCandidates = [];
        for (const source of arraySources) {
          for (const column of source.value) {
            if (!isOperationColumn(column)) continue;
            if (source.key === "rightFixedColumns") {
              fixedCandidates.push(column);
            } else {
              mainCandidates.push(column);
            }
          }
        }
        const uniqueObjects = (items) => [...new Set(items)];
        const mainColumns = uniqueObjects(mainCandidates);
        const fixedColumns = uniqueObjects(fixedCandidates);
        const summarizeValue = (key, value) => {
          const type = Array.isArray(value)
            ? "array"
            : value === null
              ? "null"
              : typeof value;
          const record = { key, type };
          if (Array.isArray(value)) record.arrayLength = value.length;
          if (typeof value === "boolean") record.booleanValue = value;
          if (typeof value === "string") {
            const enumName = safeEnum(value);
            if (enumName) record.enumName = enumName;
          }
          if (typeof value === "function") record.functionPresent = true;
          return record;
        };
        const summarizeColumn = (column) => {
          if (!column) return [];
          return Object.keys(column)
            .filter((key) => allowedConfigKeys.has(key))
            .slice(0, 80)
            .map((key) => {
              let value;
              try {
                value = column[key];
              } catch {
                return { key, type: "unavailable" };
              }
              return summarizeValue(key, value);
            });
        };
        const mainColumn = mainColumns.length === 1 ? mainColumns[0] : null;
        const fixedColumn =
          fixedColumns.length === 1 ? fixedColumns[0] : null;
        const rendererInfo = (column) => {
          const fields = [];
          if (!column) return { present: false, fields };
          for (const key of rendererKeyNames) {
            if (!(key in column)) continue;
            const value = column[key];
            const present =
              typeof value === "function" ||
              (typeof value === "string" && value.length > 0) ||
              (value && typeof value === "object");
            if (present) {
              fields.push({
                key,
                type: typeof value,
                enumName:
                  typeof value === "string" ? safeEnum(value) : "",
              });
            }
          }
          return { present: fields.length > 0, fields };
        };
        const mainRenderer = rendererInfo(mainColumn);
        const fixedRenderer = rendererInfo(fixedColumn);
        const referencedKeys = [
          ...mainRenderer.fields,
          ...fixedRenderer.fields,
        ]
          .map((field) => field.enumName)
          .filter(Boolean);
        const registrationDiagnostics = [];
        let rendererRegistered = false;
        for (const registry of registrySources.slice(0, 40)) {
          const keys = Object.keys(registry.value).filter(safeKey).slice(0, 100);
          const matchedKeys = keys.filter((key) =>
            referencedKeys.includes(key)
          );
          if (matchedKeys.length > 0) rendererRegistered = true;
          registrationDiagnostics.push({
            registryKey: registry.key,
            registryEntryCount: keys.length,
            matchingEntryPresent: matchedKeys.length > 0,
          });
        }
        if (
          [...mainRenderer.fields, ...fixedRenderer.fields].some(
            (field) => field.type === "function"
          )
        ) {
          rendererRegistered = true;
        }
        let actionSourceKey = "";
        for (const key of actionSourceNames) {
          const value = mainColumn?.[key];
          if (typeof value === "string" && safeEnum(value)) {
            actionSourceKey = value;
            break;
          }
        }
        let pageActionConfigPresent = false;
        let pageActionCount = 0;
        if (actionSourceKey) {
          for (const source of pageSources) {
            if (source.key !== actionSourceKey) continue;
            pageActionConfigPresent = true;
            pageActionCount = Array.isArray(source.value)
              ? source.value.length
              : 0;
          }
        } else {
          for (const source of pageSources) {
            if (!Array.isArray(source.value)) continue;
            if (source.value.length > pageActionCount) {
              pageActionCount = source.value.length;
            }
          }
          pageActionConfigPresent = pageActionCount > 0;
        }
        const mainConfig = summarizeColumn(mainColumn);
        const fixedConfig = summarizeColumn(fixedColumn);
        const mainActionConfigPresent = mainConfig.some(
          (item) =>
            actionSourceNames.includes(item.key) &&
            (item.arrayLength > 0 ||
              item.functionPresent ||
              Boolean(item.enumName))
        );
        const fixedActionConfigPresent = fixedConfig.some(
          (item) =>
            actionSourceNames.includes(item.key) &&
            (item.arrayLength > 0 ||
              item.functionPresent ||
              Boolean(item.enumName))
        );
        const configLostInFixedClone =
          Boolean(mainColumn && fixedColumn) &&
          ((mainRenderer.present && !fixedRenderer.present) ||
            (mainActionConfigPresent && !fixedActionConfigPresent));
        return {
          uniqueCell: true,
          mainOperationColumnFound: Boolean(mainColumn),
          fixedOperationColumnFound: Boolean(fixedColumn),
          mainRendererKeyPresent: mainRenderer.present,
          fixedRendererKeyPresent: fixedRenderer.present,
          rendererRegistered,
          pageActionSourceKeyPresent: Boolean(actionSourceKey),
          pageActionConfigPresent,
          pageActionCount,
          configLostInFixedClone,
          mainColumnConfig: mainConfig,
          fixedColumnConfig: fixedConfig,
          rendererRegistrationDiagnostics:
            registrationDiagnostics.slice(0, 30),
        };
      },
      { cellBounds: fixed.operationCellBounds }
    );
    await networkGuard.assertSafe();
    if (!result.uniqueCell) {
      return {
        ...base,
        networkWriteBlocked: true,
        missingFields: ["receiptForm.operationCell"],
        errorCode: "RECLOUD_RECEIPT_OPERATION_SOURCE_UNAVAILABLE",
      };
    }
    const output = {
      ...base,
      ...result,
      networkWriteBlocked: true,
      blockedRequestCount: guardState.blockedRequestCount,
      confirmClicked: false,
    };
    output.errorCode = classifyReceiptRendererConfig(output);
    output.missingFields = output.errorCode
      ? ["receiptForm.rendererConfig"]
      : [];
    return output;
  } finally {
    await networkGuard?.stop();
  }
}

async function findMappedReceiptControl(page, options = {}) {
  const operationTimeout = Math.min(
    Number(options.operationTimeout) || 3000,
    3000
  );
  const deadline = Date.now() + Math.min(
    Number(options.actionTimeout) || 15000,
    15000
  );
  const limited = async (work, fallback) => {
    const remaining = Math.max(0, deadline - Date.now());
    if (remaining === 0) return fallback;
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(work),
        new Promise((resolve) => {
          timer = setTimeout(
            () => resolve(fallback),
            Math.min(operationTimeout, remaining)
          );
        }),
      ]);
    } catch {
      return fallback;
    } finally {
      clearTimeout(timer);
    }
  };
  const scopes =
    typeof page.frames === "function"
      ? [page, ...page.frames().filter((frame) => frame !== page.mainFrame?.())]
      : [page];
  const logisticsNo = normalizeText(options.logisticsNo);
  const productLine = normalizeText(options.productLine);
  const expectedRowIndex = Number(options.rowIndex) || 1;

  for (const scope of scopes.slice(0, 6)) {
    const headers = scope.getByText("产品序列号", { exact: true });
    const headerCount = await limited(
      async () => Math.min(await headers.count(), 10),
      0
    );
    for (let headerIndex = 0; headerIndex < headerCount; headerIndex += 1) {
      const header = headers.nth(headerIndex);
      if (!(await limited(() => header.isVisible(), false))) continue;
      const tableRoot = header
        .locator(
          "xpath=ancestor::*[self::table or @role='table' or @role='grid' or contains(concat(' ', normalize-space(@class), ' '), ' el-table ') or contains(concat(' ', normalize-space(@class), ' '), ' rtxpc-table ')][1]"
        )
        .first();
      if (!(await limited(() => tableRoot.isVisible(), false))) continue;

      await limited(
        () =>
          tableRoot.evaluate((root) => {
            const nodes = [root, ...root.querySelectorAll("*")].slice(0, 1000);
            for (const element of nodes) {
              const style = getComputedStyle(element);
              if (
                /(auto|scroll)/.test(style.overflowX) &&
                element.scrollWidth > element.clientWidth + 2
              ) {
                element.scrollLeft = element.scrollWidth;
                element.dispatchEvent(new Event("scroll", { bubbles: true }));
              }
            }
          }),
        undefined
      );
      await limited(() => page.waitForTimeout?.(300), undefined);

      const operationLayerRoot = tableRoot
        .locator(
          "xpath=ancestor::*[.//*[normalize-space()='RMA明细'] and .//*[normalize-space()='签收']][1]"
        )
        .first();
      const mappingRoot = (typeof operationLayerRoot.count === "function" &&
      (await limited(() => operationLayerRoot.isVisible(), false)))
        ? operationLayerRoot
        : tableRoot;

      const targetMarker = "fielddesk-receipt-readonly-target";
      const mapping = await limited(
        () =>
          mappingRoot.evaluate(
            (root, input) => {
              const visible = (element) => {
                const box = element.getBoundingClientRect();
                const style = getComputedStyle(element);
                return (
                  box.width > 0 &&
                  box.height > 0 &&
                  style.display !== "none" &&
                  style.visibility !== "hidden"
                );
              };
              const text = (element) =>
                String(element.innerText || element.textContent || "").trim();
              root
                .querySelectorAll(`[data-${input.marker}]`)
                .forEach((element) =>
                  element.removeAttribute(`data-${input.marker}`)
                );
              const rowSelector = [
                "tbody tr",
                "[role='row']",
                "[data-row-key]",
                "[row-key]",
                "[aria-rowindex]",
                ".el-table__row",
                ".rtxpc-table__row",
                "[class*='virtual'][class*='row']",
              ].join(",");
              const rawRows = [...root.querySelectorAll(rowSelector)]
                .slice(0, 300)
                .filter(visible);
              const rows = [];
              const seen = new Set();
              for (const element of rawRows) {
                const value = text(element);
                const box = element.getBoundingClientRect();
                if (
                  box.height <= 0 ||
                  input.headerNames.filter((title) => value.includes(title))
                    .length >= 3
                ) {
                  continue;
                }
                const rowKey =
                  element.getAttribute("data-row-key") ||
                  element.getAttribute("row-key") ||
                  "";
                const ariaRowIndex =
                  element.getAttribute("aria-rowindex") || "";
                const y = Math.round((box.y + box.height / 2) * 10) / 10;
                const identity = `${rowKey}:${ariaRowIndex}:${Math.round(y)}`;
                if (seen.has(identity)) continue;
                seen.add(identity);
                rows.push({
                  element,
                  rowKey,
                  ariaRowIndex,
                  y,
                  top: Math.round(box.y * 10) / 10,
                  height: Math.round(box.height * 10) / 10,
                  logisticsMatched:
                    Boolean(input.logisticsNo) &&
                    value.includes(input.logisticsNo),
                  productLineMatched:
                    Boolean(input.productLine) &&
                    value.includes(input.productLine),
                  pendingReceipt: /待签收|签收/.test(value),
                });
              }
              rows.sort((left, right) => left.y - right.y);
              rows.forEach((row, index) => {
                row.logicalIndex = index + 1;
              });
              const scored = rows.map((row) => ({
                row,
                score:
                  Number(row.logisticsMatched) * 4 +
                  Number(row.pendingReceipt) * 2 +
                  Number(row.productLineMatched),
              }));
              const bestScore = Math.max(
                0,
                ...scored.map(({ score }) => score)
              );
              const targets = scored
                .filter(
                  ({ row, score }) =>
                    score > 0 &&
                    score === bestScore &&
                    (row.ariaRowIndex
                      ? Number(row.ariaRowIndex) === input.rowIndex
                      : row.logicalIndex === input.rowIndex)
                )
                .map(({ row }) => row);
              if (targets.length !== 1) {
                return {
                  status: "row_not_unique",
                  targetRowCandidateCount: targets.length,
                  diagnostics: [],
                };
              }
              const target = targets[0];
              const fixedRightSelector = [
                ".el-table__fixed-right",
                ".el-table__fixed-right-wrapper",
                ".rtxpc-table__fixed-right",
                "[class*='fixed-right']",
                "[class*='fixedRight']",
                "[class*='fixed'][class*='right']",
              ].join(",");
              const fixedContainers = [
                ...root.querySelectorAll(fixedRightSelector),
              ]
                .slice(0, 30)
                .filter(visible);
              if (fixedContainers.length === 0) {
                return {
                  status: "fixed_right_not_found",
                  targetRowCandidateCount: 1,
                  fixedRightContainerFound: false,
                  fixedRightRowCandidateCount: 0,
                  diagnostics: [],
                };
              }
              const fixedRowElements = [
                ...new Set(
                  fixedContainers.flatMap((container) => [
                    ...container.querySelectorAll(rowSelector),
                  ])
                ),
              ]
                .slice(0, 100)
                .filter(visible);
              const fixedRows = [];
              for (const element of fixedRowElements) {
                const value = text(element);
                const box = element.getBoundingClientRect();
                const targetBottom = target.top + target.height;
                const rowBottom = box.y + box.height;
                const verticalOverlap =
                  Math.min(targetBottom, rowBottom) -
                  Math.max(target.top, box.y);
                if (
                  box.height <= 0 ||
                  verticalOverlap <= 0 ||
                  input.headerNames.filter((title) => value.includes(title))
                    .length >= 3
                ) {
                  continue;
                }
                fixedRows.push({
                  element,
                  rowKey:
                    element.getAttribute("data-row-key") ||
                    element.getAttribute("row-key") ||
                    "",
                  ariaRowIndex: element.getAttribute("aria-rowindex") || "",
                  y: Math.round((box.y + box.height / 2) * 10) / 10,
                  top: box.y,
                  height: box.height,
                  synthetic: false,
                });
              }
              if (fixedRows.length === 0) {
                const cellElements = [
                  ...new Set(
                    fixedContainers.flatMap((container) => [
                      container,
                      ...container.querySelectorAll(
                        "td,[role='gridcell'],.el-table__cell,[class*='cell']"
                      ),
                    ])
                  ),
                ]
                  .slice(0, 100)
                  .filter(visible);
                const seenCellRows = new Set();
                for (const element of cellElements) {
                  const box = element.getBoundingClientRect();
                  const targetBottom = target.top + target.height;
                  const boxBottom = box.y + box.height;
                  const overlap =
                    Math.min(targetBottom, boxBottom) -
                    Math.max(target.top, box.y);
                  if (
                    overlap <= Math.min(target.height, box.height) * 0.5
                  ) {
                    continue;
                  }
                  const identity = `${Math.round(box.y)}:${Math.round(
                    box.height
                  )}`;
                  if (seenCellRows.has(identity) || box.height <= 0) continue;
                  seenCellRows.add(identity);
                  const owner = element.closest(
                    "[data-row-key],[row-key],[aria-rowindex]"
                  );
                  fixedRows.push({
                    element,
                    rowKey:
                      owner?.getAttribute("data-row-key") ||
                      owner?.getAttribute("row-key") ||
                      "",
                    ariaRowIndex:
                      owner?.getAttribute("aria-rowindex") || "",
                    y: Math.round((box.y + box.height / 2) * 10) / 10,
                    top: box.y,
                    height: box.height,
                    synthetic: true,
                  });
                }
              }
              if (fixedRows.length === 0) {
                // Some Recloud table builds render the pinned operation cell
                // in the table root without a row wrapper inside the fixed
                // container. Accept that layout only when an exact visible
                // receipt label belongs to one cell that vertically overlaps
                // the already unique target row.
                const receiptNodes = [root, ...root.querySelectorAll("*")]
                  .slice(0, 2000)
                  .filter(
                    (element) => visible(element) && text(element) === "签收"
                  );
                const receiptCells = [
                  ...new Set(
                    receiptNodes
                      .map((element) =>
                        element.closest(
                          "td,[role='gridcell'],.el-table__cell,[class*='cell']"
                        )
                      )
                      .filter(Boolean)
                  ),
                ];
                for (const element of receiptCells) {
                  const box = element.getBoundingClientRect();
                  const targetBottom = target.top + target.height;
                  const boxBottom = box.y + box.height;
                  const overlap =
                    Math.min(targetBottom, boxBottom) -
                    Math.max(target.top, box.y);
                  if (
                    box.height <= 0 ||
                    overlap <= Math.min(target.height, box.height) * 0.5
                  ) {
                    continue;
                  }
                  fixedRows.push({
                    element,
                    rowKey: "",
                    ariaRowIndex: "",
                    y: Math.round((box.y + box.height / 2) * 10) / 10,
                    top: box.y,
                    height: box.height,
                    synthetic: true,
                  });
                }
              }
              fixedRows.sort((left, right) => left.y - right.y);
              fixedRows.forEach((row, index) => {
                row.logicalIndex = index + 1;
              });
              let matchedBy = "";
              let fixedMatches = [];
              if (target.rowKey) {
                fixedMatches = fixedRows.filter(
                  (row) => row.rowKey === target.rowKey
                );
                if (fixedMatches.length > 0) matchedBy = "rowKey";
              }
              if (fixedMatches.length === 0 && target.ariaRowIndex) {
                fixedMatches = fixedRows.filter(
                  (row) => row.ariaRowIndex === target.ariaRowIndex
                );
                if (fixedMatches.length > 0) matchedBy = "ariaRowIndex";
              }
              if (fixedMatches.length === 0) {
                fixedMatches = fixedRows.filter(
                  (row) =>
                    !row.synthetic &&
                    row.logicalIndex === target.logicalIndex
                );
                if (fixedMatches.length > 0) matchedBy = "rowIndex";
              }
              if (fixedMatches.length === 0) {
                const targetBottom = target.top + target.height;
                fixedMatches = fixedRows.filter((row) => {
                  const rowBottom = row.top + row.height;
                  const overlap = Math.min(targetBottom, rowBottom) -
                    Math.max(target.top, row.top);
                  return overlap > Math.min(target.height, row.height) * 0.5;
                });
                if (fixedMatches.length > 0) matchedBy = "verticalOverlap";
              }
              const interactiveSelector = [
                "button",
                "a",
                "[role='button']",
                "[tabindex]",
                "[onclick]",
                "span[title]",
                "div[title]",
                "span[aria-label]",
                "div[aria-label]",
                "span",
                "div",
              ].join(",");
              const isExplicitReceiptControl = (element) => {
                const style = getComputedStyle(element);
                const box = element.getBoundingClientRect();
                const disabled =
                  element.hasAttribute("disabled") ||
                  element.getAttribute("aria-disabled") === "true";
                return (
                  visible(element) &&
                  box.right > 0 &&
                  box.left < window.innerWidth &&
                  !disabled &&
                  style.pointerEvents !== "none" &&
                  (["button", "a"].includes(element.tagName.toLowerCase()) ||
                    element.getAttribute("role") === "button" ||
                    element.hasAttribute("tabindex") ||
                    element.hasAttribute("onclick") ||
                    element.hasAttribute("title") ||
                    element.hasAttribute("aria-label") ||
                    style.cursor === "pointer") &&
                  (text(element) === "签收" ||
                    element.getAttribute("title") === "签收" ||
                    element.getAttribute("aria-label") === "签收")
                );
              };
              // Recloud may expose the same pinned row through nested row
              // wrappers. Collapse them only when every wrapper leads to the
              // same explicit action; distinct controls remain ambiguous.
              if (fixedMatches.length > 1) {
                const controls = [
                  ...new Set(
                    fixedMatches.flatMap((row) => [
                      row.element,
                      ...row.element.querySelectorAll(interactiveSelector),
                    ])
                  ),
                ].filter(isExplicitReceiptControl);
                const leafControls = controls.filter(
                  (element) =>
                    !controls.some(
                      (other) =>
                        other !== element && element.contains(other)
                    )
                );
                if (leafControls.length === 1) {
                  const control = leafControls[0];
                  const owners = fixedMatches.filter(
                    (row) =>
                      row.element === control || row.element.contains(control)
                  );
                  owners.sort((left, right) => {
                    const leftBox = left.element.getBoundingClientRect();
                    const rightBox = right.element.getBoundingClientRect();
                    return (
                      leftBox.width * leftBox.height -
                      rightBox.width * rightBox.height
                    );
                  });
                  fixedMatches = owners.slice(0, 1);
                  matchedBy = `${matchedBy || "verticalOverlap"}+uniqueControl`;
                }
              }
              if (fixedMatches.length !== 1) {
                return {
                  status: "fixed_row_ambiguous",
                  targetRowCandidateCount: 1,
                  fixedRightContainerFound: true,
                  fixedRightRowCandidateCount: fixedMatches.length,
                  diagnostics: [],
                };
              }
              const fixedRow = fixedMatches[0];
              const cells = [
                fixedRow.element,
                ...fixedRow.element.querySelectorAll(
                  "td,[role='gridcell'],.el-table__cell,[class*='cell']"
                ),
              ]
                .slice(0, 50)
                .filter(visible);
              const operationCells = cells.filter((cell) => {
                const controls = [
                  cell,
                  ...cell.querySelectorAll(interactiveSelector),
                ].slice(0, 30);
                return controls.some(
                  (element) =>
                    text(element) === "签收" ||
                    element.getAttribute("title") === "签收" ||
                    element.getAttribute("aria-label") === "签收"
                );
              });
              const smallestCells = operationCells.filter(
                (cell) =>
                  !operationCells.some(
                    (other) => other !== cell && cell.contains(other)
                  )
              );
              if (smallestCells.length === 0) {
                return {
                  status: "control_not_found",
                  targetRowCandidateCount: 1,
                  fixedRightContainerFound: true,
                  fixedRightRowCandidateCount: 1,
                  fixedRightRowMatchedBy: matchedBy,
                  diagnostics: [],
                };
              }
              if (smallestCells.length !== 1) {
                return {
                  status: "control_ambiguous",
                  targetRowCandidateCount: 1,
                  fixedRightContainerFound: true,
                  fixedRightRowCandidateCount: 1,
                  fixedRightRowMatchedBy: matchedBy,
                  diagnostics: [],
                };
              }
              const cell = smallestCells[0];
              const unique = [
                ...new Set([
                  cell,
                  ...cell.querySelectorAll(interactiveSelector),
                ]),
              ]
                .slice(0, 30)
                .filter(visible);
              const diagnostics = unique.map((element) => {
                const box = element.getBoundingClientRect();
                const style = getComputedStyle(element);
                const disabled =
                  element.hasAttribute("disabled") ||
                  element.getAttribute("aria-disabled") === "true";
                const className = String(element.className || "")
                  .split(/\s+/)
                  .slice(0, 16)
                  .join(" ");
                return {
                  tag: element.tagName.toLowerCase(),
                  role: element.getAttribute("role") || "",
                  className,
                  title: element.getAttribute("title") || "",
                  ariaLabel: element.getAttribute("aria-label") || "",
                  dataTestId: element.getAttribute("data-testid") || "",
                  textEqualsReceipt: text(element) === "签收",
                  visible: true,
                  enabled: !disabled && style.pointerEvents !== "none",
                  boundingBox: {
                    x: Math.round(box.x * 10) / 10,
                    y: Math.round(box.y * 10) / 10,
                    width: Math.round(box.width * 10) / 10,
                    height: Math.round(box.height * 10) / 10,
                  },
                };
              });
              const explicitCandidates = unique.filter(
                isExplicitReceiptControl
              );
              const explicit = explicitCandidates.filter(
                (element) =>
                  !explicitCandidates.some(
                    (other) => other !== element && element.contains(other)
                  )
              );
              if (explicit.length !== 1) {
                return {
                  status: "control_ambiguous",
                  targetRowCandidateCount: 1,
                  fixedRightContainerFound: true,
                  fixedRightRowCandidateCount: 1,
                  fixedRightRowMatchedBy: matchedBy,
                  diagnostics,
                };
              }
              explicit[0].setAttribute(`data-${input.marker}`, "true");
              return {
                status: "found",
                targetRowCandidateCount: 1,
                fixedRightContainerFound: true,
                fixedRightRowCandidateCount: 1,
                fixedRightRowMatchedBy: matchedBy,
                targetRowMatchedBy: [
                  ...(target.logisticsMatched ? ["logisticsNo"] : []),
                  ...(target.pendingReceipt ? ["pendingReceipt"] : []),
                  ...(target.productLineMatched ? ["productLine"] : []),
                ],
                diagnostics,
              };
            },
            {
              marker: targetMarker,
              rowIndex: expectedRowIndex,
              logisticsNo,
              productLine,
              headerNames: ["产品序列号", "项目号", "产品线", "操作"],
            }
          ),
        null
      );
      if (mapping?.status === "found") {
        const entry = scope
          .locator(`[data-${targetMarker}="true"]`)
          .first();
        if (await limited(() => entry.isVisible(), false)) {
          return {
            row: null,
            entry,
            operationDiagnostics: mapping.diagnostics,
            receiptLocator: {
              targetRowCandidateCount: 1,
              targetRowMatchedBy: mapping.targetRowMatchedBy,
              fixedOperationRowMatched: true,
              fixedRightContainerFound: true,
              fixedRightRowCandidateCount:
                mapping.fixedRightRowCandidateCount,
              fixedRightRowMatched: true,
              fixedRightRowMatchedBy: mapping.fixedRightRowMatchedBy,
              operationCellFound: true,
              operationControlCandidateCount: 1,
            },
          };
        }
      }
      if (mapping?.status === "fixed_right_not_found") {
        throw receiptInspectionError(
          "RECLOUD_RECEIPT_FIXED_RIGHT_NOT_FOUND",
          "未找到目标表格的右侧固定操作列",
          ["receiptForm.fixedRight"],
          {
            fixedRightContainerFound: false,
            fixedRightRowCandidateCount: 0,
            fixedRightRowMatched: false,
            operationCellFound: false,
          }
        );
      }
      if (
        mapping?.status === "fixed_row_ambiguous" ||
        mapping?.status === "row_not_unique"
      ) {
        throw receiptInspectionError(
          "RECLOUD_RECEIPT_FIXED_ROW_AMBIGUOUS",
          "无法唯一映射目标主表行对应的右侧固定列行",
          ["receiptForm.fixedRightRow"],
          {
            fixedRightContainerFound:
              mapping.fixedRightContainerFound ?? true,
            fixedRightRowCandidateCount:
              mapping.fixedRightRowCandidateCount ?? 0,
            fixedRightRowMatched: false,
            fixedRightRowMatchedBy: "",
            operationCellFound: false,
          }
        );
      }
      if (mapping?.status === "control_not_found") {
        throw receiptInspectionError(
          "RECLOUD_RECEIPT_CONTROL_NOT_FOUND",
          "目标固定操作行中没有找到签收控件",
          ["receiptForm.entry"],
          {
            fixedRightContainerFound: true,
            fixedRightRowCandidateCount: 1,
            fixedRightRowMatched: true,
            fixedRightRowMatchedBy: mapping.fixedRightRowMatchedBy,
            operationCellFound: true,
            operationControlCandidateCount: 0,
            receiptControlFound: false,
          }
        );
      }
      if (mapping?.status === "control_ambiguous") {
        const error = receiptInspectionError(
          "RECLOUD_RECEIPT_CONTROL_AMBIGUOUS",
          "无法唯一确认目标操作单元格中的签收控件",
          ["receiptForm.entry"],
          {
            operationControlCandidateCount:
              mapping.diagnostics?.filter(
                (item) =>
                  item.visible &&
                  item.enabled &&
                  (item.textEqualsReceipt ||
                    item.title === "签收" ||
                    item.ariaLabel === "签收")
              ).length || 0,
            receiptControlFound: false,
            fixedRightContainerFound: true,
            fixedRightRowCandidateCount: 1,
            fixedRightRowMatched: true,
            fixedRightRowMatchedBy: mapping.fixedRightRowMatchedBy,
            operationCellFound: true,
          }
        );
        error.operationControlCandidates = mapping.diagnostics || [];
        throw error;
      }
      if (mapping) continue;

      const rows = tableRoot.locator(
        "tbody tr, [role='row'], [data-row-key], [row-key], [aria-rowindex], .el-table__row, .rtxpc-table__row, [class*='virtual'][class*='row']"
      );
      const rowCount = await limited(
        async () => Math.min(await rows.count(), 100),
        0
      );
      const rowCandidates = [];
      for (let index = 0; index < rowCount; index += 1) {
        const row = rows.nth(index);
        if (!(await limited(() => row.isVisible(), false))) continue;
        const rowData = await limited(
          () =>
            row.evaluate(
              (element, input) => {
                const value = String(
                  element.innerText || element.textContent || ""
                );
                const box = element.getBoundingClientRect();
                const headerCount = input.headerNames.filter((title) =>
                  value.includes(title)
                ).length;
                if (headerCount >= 3 || box.height <= 0) return null;
                return {
                  domIndex: input.domIndex,
                  rowKey:
                    element.getAttribute("data-row-key") ||
                    element.getAttribute("row-key") ||
                    "",
                  ariaRowIndex: element.getAttribute("aria-rowindex") || "",
                  y: Math.round((box.y + box.height / 2) * 10) / 10,
                  logisticsMatched:
                    Boolean(input.logisticsNo) &&
                    value.includes(input.logisticsNo),
                  productLineMatched:
                    Boolean(input.productLine) &&
                    value.includes(input.productLine),
                  pendingReceipt: /待签收|签收/.test(value),
                };
              },
              {
                domIndex: index + 1,
                logisticsNo,
                productLine,
                headerNames: ["产品序列号", "项目号", "产品线", "操作"],
              }
            ),
          null
        );
        if (rowData) rowCandidates.push({ locator: row, ...rowData });
      }
      const uniqueRows = [];
      const rowKeys = new Set();
      for (const row of rowCandidates) {
        const identity = `${row.rowKey}:${row.ariaRowIndex}:${Math.round(row.y)}`;
        if (rowKeys.has(identity)) continue;
        rowKeys.add(identity);
        uniqueRows.push(row);
      }
      uniqueRows.forEach((row, index) => {
        row.logicalIndex = index + 1;
      });
      const scored = uniqueRows.map((row) => ({
        row,
        score:
          Number(row.logisticsMatched) * 4 +
          Number(row.pendingReceipt) * 2 +
          Number(row.productLineMatched),
      }));
      const bestScore = Math.max(0, ...scored.map(({ score }) => score));
      const matches = scored
        .filter(({ score }) => score > 0 && score === bestScore)
        .map(({ row }) => row);
      if (
        matches.length !== 1 ||
        (matches[0].ariaRowIndex &&
          Number(matches[0].ariaRowIndex) !== expectedRowIndex) ||
        (!matches[0].ariaRowIndex &&
          matches[0].logicalIndex !== expectedRowIndex)
      ) {
        continue;
      }
      const targetRow = matches[0];
      const receiptTexts = tableRoot.getByText("签收", { exact: true });
      const receiptTextCount = await limited(
        async () => Math.min(await receiptTexts.count(), 20),
        0
      );
      const operationCells = [];
      const seenCells = new Set();
      for (let index = 0; index < receiptTextCount; index += 1) {
        const receiptText = receiptTexts.nth(index);
        if (!(await limited(() => receiptText.isVisible(), false))) continue;
        const cell = receiptText
          .locator(
            "xpath=ancestor-or-self::*[self::td or @role='gridcell' or contains(concat(' ', normalize-space(@class), ' '), ' el-table__cell ') or contains(@class,'cell')][1]"
          )
          .first();
        const cellBox = await limited(() => cell.boundingBox(), null);
        if (!cellBox) continue;
        const centerY = cellBox.y + cellBox.height / 2;
        if (Math.abs(centerY - targetRow.y) > Math.max(8, cellBox.height / 2)) {
          continue;
        }
        const identity = `${Math.round(cellBox.x)}:${Math.round(cellBox.y)}`;
        if (seenCells.has(identity)) continue;
        seenCells.add(identity);
        operationCells.push({ cell, receiptText });
      }
      if (operationCells.length !== 1) {
        const error = receiptInspectionError(
          "RECLOUD_RECEIPT_CONTROL_AMBIGUOUS",
          "无法唯一确认目标操作单元格中的签收控件",
          ["receiptForm.entry"],
          {
            operationControlCandidateCount: 0,
            receiptControlFound: false,
          }
        );
        error.operationControlCandidates = [];
        throw error;
      }

      const { cell, receiptText } = operationCells[0];
      const interactive = cell.locator(
        "button, a, [role='button'], [tabindex], [onclick], [title], [aria-label]"
      );
      const interactiveCount = await limited(
        async () => Math.min(await interactive.count(), 30),
        0
      );
      const controls = [];
      const controlKeys = new Set();
      const possibleControls = [];
      for (let index = 0; index < interactiveCount; index += 1) {
        possibleControls.push(interactive.nth(index));
      }
      possibleControls.push(receiptText);
      for (const control of possibleControls) {
        const diagnostic = await limited(
          async () => {
            const visible = await control.isVisible();
            const enabled =
              typeof control.isEnabled === "function"
                ? await control.isEnabled()
                : true;
            const box = await control.boundingBox();
            const structure = await control.evaluate((element) => ({
              tagName: element.tagName.toLowerCase(),
              role: element.getAttribute("role") || "",
              title: element.getAttribute("title") || "",
              ariaLabel: element.getAttribute("aria-label") || "",
              textEqualsReceipt:
                String(element.innerText || element.textContent || "").trim() ===
                "签收",
            }));
            return {
              ...structure,
              visible,
              enabled,
              boundingBox: box,
            };
          },
          null
        );
        if (!diagnostic?.boundingBox) continue;
        const key = [
          Math.round(diagnostic.boundingBox.x),
          Math.round(diagnostic.boundingBox.y),
          Math.round(diagnostic.boundingBox.width),
          Math.round(diagnostic.boundingBox.height),
        ].join(":");
        if (controlKeys.has(key)) continue;
        controlKeys.add(key);
        controls.push({ locator: control, diagnostic });
      }
      const explicit = controls.filter(
        ({ diagnostic }) =>
          diagnostic.visible &&
          diagnostic.enabled &&
          (diagnostic.textEqualsReceipt ||
            diagnostic.title === "签收" ||
            diagnostic.ariaLabel === "签收")
      );
      const safeDiagnostics = controls.map(({ diagnostic }) => diagnostic);
      if (explicit.length !== 1) {
        const error = receiptInspectionError(
          "RECLOUD_RECEIPT_CONTROL_AMBIGUOUS",
          "无法唯一确认目标操作单元格中的签收控件",
          ["receiptForm.entry"],
          {
            operationControlCandidateCount: explicit.length,
            receiptControlFound: false,
          }
        );
        error.operationControlCandidates = safeDiagnostics;
        throw error;
      }
      return {
        row: targetRow.locator,
        entry: explicit[0].locator,
        operationDiagnostics: safeDiagnostics,
        receiptLocator: {
          targetRowCandidateCount: 1,
          targetRowMatchedBy: [
            ...(targetRow.logisticsMatched ? ["logisticsNo"] : []),
            ...(targetRow.pendingReceipt ? ["pendingReceipt"] : []),
            ...(targetRow.productLineMatched ? ["productLine"] : []),
          ],
          fixedOperationRowMatched: true,
          operationControlCandidateCount: explicit.length,
        },
      };
    }
  }
  return null;
}

async function describeReceiptControl(locator, role) {
  return {
    role,
    tagName:
      typeof locator.evaluate === "function"
        ? await locator
            .evaluate((element) => element.tagName.toLowerCase())
            .catch(() => "")
        : "",
    name: await locator.getAttribute("name").catch(() => ""),
    placeholder: await locator.getAttribute("placeholder").catch(() => ""),
    ariaLabel: await locator.getAttribute("aria-label").catch(() => ""),
    dataTestId: await locator.getAttribute("data-testid").catch(() => ""),
  };
}

function receiptInspectionError(code, message, missingFields, inspection = {}) {
  const error = new RecloudQueryError(code, message, {
    status: 502,
    retryable: false,
    missingFields,
  });
  error.inspection = {
    receiptEntryFound: false,
    receiptEntryVisible: false,
    receiptEntryEnabled: false,
    receiptEntryClicked: false,
    dialogOpened: false,
    snInputFound: false,
    remarkInputFound: false,
    confirmButtonFound: false,
    fixedRightContainerFound: false,
    fixedRightRowCandidateCount: 0,
    fixedRightRowMatched: false,
    fixedRightRowMatchedBy: "",
    operationCellFound: false,
    operationControlCandidateCount: 0,
    receiptControlFound: false,
    receiptControlClicked: false,
    blockedRequestCount: 0,
    confirmClicked: false,
    missingFields,
    ...inspection,
  };
  return error;
}

async function inspectReceiptEntry(entry) {
  const visible = await entry.isVisible().catch(() => false);
  const enabled =
    typeof entry.isEnabled === "function"
      ? await entry.isEnabled().catch(() => false)
      : true;
  const box =
    typeof entry.boundingBox === "function"
      ? await entry.boundingBox().catch(() => null)
      : { x: 0, y: 0, width: 1, height: 1 };
  return {
    visible,
    enabled,
    actionable: Boolean(
      visible && enabled && box && box.width > 0 && box.height > 0
    ),
    box,
  };
}

async function safelyClickReceiptEntry(entry, page, options = {}) {
  await entry.scrollIntoViewIfNeeded?.();
  await page.waitForTimeout?.(options.renderSettleDelay ?? 250);
  const state = await inspectReceiptEntry(entry);
  if (!state.actionable) {
    throw receiptInspectionError(
      "RECLOUD_RECEIPT_ENTRY_CLICK_FAILED",
      "瑞云签收入口不可见、不可用或没有可点击区域",
      ["receiptForm.dialog"],
      {
        receiptEntryFound: true,
        receiptEntryVisible: state.visible,
        receiptEntryEnabled: state.enabled,
      }
    );
  }

  const attempts = [
    () => entry.click({ timeout: options.clickTimeout ?? 3000 }),
    () =>
      entry.click({
        position: {
          x: state.box.width / 2,
          y: state.box.height / 2,
        },
        timeout: options.clickTimeout ?? 3000,
      }),
    () =>
      entry.evaluate((element) => {
        const target = element.closest(
          "button, a, [role='button'], [tabindex]"
        );
        (target || element).click();
      }),
  ];
  let lastError;
  for (const attempt of attempts) {
    try {
      await attempt();
      return state;
    } catch (error) {
      lastError = error;
    }
  }
  const failure = receiptInspectionError(
    "RECLOUD_RECEIPT_ENTRY_CLICK_FAILED",
    "无法安全打开瑞云签收入口",
    ["receiptForm.dialog"],
    {
      receiptEntryFound: true,
      receiptEntryVisible: state.visible,
      receiptEntryEnabled: state.enabled,
    }
  );
  failure.cause = lastError;
  throw failure;
}

function receiptFormRoots(scope) {
  return scope.locator(
    [
      '.rt-dialog__wrapper:visible',
      '.el-dialog:visible',
      '[role="dialog"]:visible',
      '.el-drawer:visible',
      '.rt-drawer:visible',
      '[role="complementary"]:visible',
      '.el-overlay:visible',
      '.v-modal:visible',
      '.el-dialog__wrapper:visible',
      "form:visible",
    ].join(", ")
  );
}

async function findReceiptFormRoot(scope, startIndex = 0) {
  const roots = receiptFormRoots(scope);
  const count = await roots.count().catch(() => 0);
  for (let index = count - 1; index >= startIndex; index -= 1) {
    const root = roots.nth(index);
    if (!(await root.isVisible().catch(() => false))) continue;
    const fields = root.locator(
      'input:visible, textarea:visible, [contenteditable="true"]:visible'
    );
    const hasReceiptField =
      (await fields.count().catch(() => 0)) > 0 &&
      ((await root
        .getByText(/SN|序列号|备注|签收说明/i)
        .count()
        .catch(() => 0)) > 0 ||
        (await root
          .locator(
            'input[placeholder*="SN"], input[placeholder*="序列号"], textarea[placeholder*="备注"], input[name*="sn" i], textarea[name*="remark" i]'
          )
          .count()
          .catch(() => 0)) > 0);
    if (hasReceiptField) return root;
  }
  return null;
}

async function waitForReceiptForm(page, baselineUrl, options = {}) {
  const deadline = Date.now() + (options.dialogTimeout ?? 5000);
  const baselineScopes = options.baselineScopes || new Map();
  while (Date.now() < deadline) {
    const pages =
      typeof page.context === "function"
        ? page.context().pages().filter((candidate) => !candidate.isClosed())
        : [page];
    for (const candidate of pages) {
      const scopes =
        typeof candidate.frames === "function"
          ? [candidate, ...candidate.frames()]
          : [candidate];
      for (const scope of scopes) {
        const root = await findReceiptFormRoot(
          scope,
          baselineScopes.get(scope) || 0
        );
        if (root) return { page: candidate, root };
      }
    }
    // URL change is only a signal to inspect the new page; never success by itself.
    void (page.url() !== baselineUrl);
    await page.waitForTimeout?.(100);
  }
  return null;
}

async function snapshotReceiptFormScopes(page) {
  const snapshots = new Map();
  const pages =
    typeof page.context === "function"
      ? page.context().pages().filter((candidate) => !candidate.isClosed())
      : [page];
  for (const candidate of pages) {
    const scopes =
      typeof candidate.frames === "function"
        ? [candidate, ...candidate.frames()]
        : [candidate];
    for (const scope of scopes) {
      snapshots.set(scope, await receiptFormRoots(scope).count().catch(() => 0));
    }
  }
  return snapshots;
}

async function openReceiptFormForDryRun(page, options = {}) {
  const logger = options.logger || console;
  const target = options.mappedRowOnly
    ? await findMappedReceiptControl(page, options)
    : await findPendingReceiptAction(page, logger, options);
  if (!target) {
    throw receiptInspectionError(
      "RECLOUD_RECEIPT_ACTION_NOT_FOUND",
      "未找到 RMA 明细中的待处理签收操作",
      ["receiptForm.entry"]
    );
  }
  logReceiptInspection("receiptEntryFound", logger);
  const baselineUrl = page.url();
  const baselineScopes = await snapshotReceiptFormScopes(page);
  const entryState = await inspectReceiptEntry(target.entry);
  if (entryState.visible) logReceiptInspection("receiptEntryVisible", logger);
  if (entryState.enabled) logReceiptInspection("receiptEntryEnabled", logger);
  await safelyClickReceiptEntry(target.entry, page, options);
  logReceiptInspection("receiptEntryClicked", logger);
  const opened = await waitForReceiptForm(page, baselineUrl, {
    ...options,
    baselineScopes,
  });
  if (!opened) {
    throw receiptInspectionError(
      "RECLOUD_RECEIPT_FORM_NOT_OPENED",
      "点击瑞云签收入口后未检测到签收表单",
      ["receiptForm.dialog"],
      {
        receiptEntryFound: true,
        receiptEntryVisible: entryState.visible,
        receiptEntryEnabled: entryState.enabled,
        receiptEntryClicked: true,
      }
    );
  }
  logReceiptInspection("dialogOpened", logger);
  return {
    entryState,
    formPage: opened.page,
    dialog: opened.root,
    operationDiagnostics: target.operationDiagnostics || [],
    receiptLocator: target.receiptLocator || {
      targetRowCandidateCount: 1,
      targetRowMatchedBy: [],
      fixedOperationRowMatched: true,
    },
  };
}

async function locateReceiptFormControls(dialog) {
  const inputs = dialog.locator("input:visible, textarea:visible");
  const snCandidates = locateDialogField(
    dialog,
    ["SN", "序列号", "设备序列号"],
    ["SN", "序列号"]
  );
  const remarkCandidates = locateDialogField(
    dialog,
    ["备注", "签收说明"],
    ["备注", "说明"]
  );
  const snInput = await firstVisible([
    snCandidates.byLabel,
    snCandidates.byPlaceholder,
    inputs.nth(3),
  ]);
  const remarkInput = await firstVisible([
    remarkCandidates.byLabel,
    remarkCandidates.byPlaceholder,
    dialog.locator("textarea:visible").first(),
    inputs.nth(4),
  ]);
  const confirmButton = await firstVisible([
    dialog
      .getByRole("button", {
        name: /^(确认|确定|提交|签收)$/,
      })
      .last(),
    dialog
      .getByText(/^(确认|确定|提交|签收)$/, { exact: true })
      .last(),
  ]);
  const cancelButton = await firstVisible([
    dialog.getByRole("button", { name: /^(取消|返回)$/ }).last(),
    dialog.getByText(/^(取消|返回)$/, { exact: true }).last(),
  ]);
  const closeButton = await firstVisible([
    dialog
      .locator(
        "button[aria-label*='关闭'], button[title*='关闭'], .el-dialog__headerbtn, .rt-dialog__close, [role='button'][aria-label*='close' i]"
      )
      .last(),
  ]);
  return {
    snInput,
    remarkInput,
    confirmButton,
    cancelButton,
    closeButton,
  };
}

async function inspectReceiptForm(page, options = {}) {
  const logger = options.logger || console;
  if (options.dryRun !== true || options.writeEnabled !== false) {
    const error = new Error("签收表单定位只允许在严格演练模式下执行");
    error.code = "RECLOUD_RECEIPT_INSPECTION_UNSAFE";
    error.status = 403;
    throw error;
  }

  assertRecloudAuthenticated(page);
  let dialog = null;
  let formPage = page;
  let dialogClosed = false;
  let dialogCloseAttempted = false;
  let cancelButton = null;
  let closeButton = null;
  let networkGuard = null;
  const guardState = createSimulationState();
  const closeDialog = async () => {
    if (!dialog || dialogClosed || dialogCloseAttempted) return dialogClosed;
    dialogCloseAttempted = true;
    for (const control of [cancelButton, closeButton]) {
      if (!control) continue;
      const actionable = await inspectReceiptEntry(control);
      if (!actionable.actionable) continue;
      const clicked = await control
        .click({ timeout: options.clickTimeout ?? 3000 })
        .then(() => true)
        .catch(() => false);
      if (clicked) {
        dialogClosed = await dialog
          .isVisible()
          .then((visible) => !visible)
          .catch(() => true);
        if (dialogClosed) return true;
      }
    }
    await formPage.keyboard.press("Escape").catch(() => {});
    dialogClosed = await dialog
      .isVisible()
      .then((visible) => !visible)
      .catch(() => true);
    return dialogClosed;
  };
  try {
    if (
      typeof page.context === "function" &&
      typeof page.context()?.route === "function"
    ) {
      networkGuard = await createReceiptNetworkGuard(page, guardState);
    }
    const opened = await openReceiptFormForDryRun(page, options);
    formPage = opened.formPage;
    dialog = opened.dialog;
    const { entryState } = opened;
    const controls = await locateReceiptFormControls(dialog);
    const { snInput, remarkInput, confirmButton } = controls;
    cancelButton = controls.cancelButton;
    closeButton = controls.closeButton;
    await networkGuard?.assertSafe();

    const missingFields = [
      !snInput && "receipt.snInput",
      !remarkInput && "receipt.remarkInput",
      !confirmButton && "receipt.confirmButton",
    ].filter(Boolean);
    if (missingFields.length > 0) {
      const error = new RecloudQueryError(
        "RECLOUD_SCHEMA_CHANGED",
        "瑞云签收弹窗字段结构已变化",
        {
          status: 502,
          retryable: false,
          missingFields,
        }
      );
      error.inspection = {
        receiptEntryFound: true,
        receiptEntryVisible: entryState.visible,
        receiptEntryEnabled: entryState.enabled,
        receiptEntryClicked: true,
        dialogOpened: true,
        snInputFound: Boolean(snInput),
        remarkInputFound: Boolean(remarkInput),
        confirmButtonFound: Boolean(confirmButton),
        cancelButtonFound: Boolean(cancelButton),
        closeButtonFound: Boolean(closeButton),
        missingFields,
      };
      throw error;
    }

    logReceiptInspection("snInputFound", logger);
    logReceiptInspection("remarkInputFound", logger);
    logReceiptInspection("confirmButtonFound", logger);
    const remarkValue =
      typeof remarkInput.inputValue === "function"
        ? await remarkInput.inputValue().catch(() => "")
        : "";
    const remarkHasDefaultValue = Boolean(remarkValue);
    const confirmStructure = {
      ...(await describeReceiptControl(
        confirmButton,
        "final_confirmation"
      )),
      text: await confirmButton
        .evaluate((element) =>
          String(element.innerText || element.textContent || "").trim()
        )
        .catch(() => ""),
      visible: await confirmButton.isVisible().catch(() => false),
      enabled:
        typeof confirmButton.isEnabled === "function"
          ? await confirmButton.isEnabled().catch(() => false)
          : true,
    };
    await closeDialog();
    await networkGuard?.assertSafe();
    return {
      dryRun: true,
      operationControlCandidateCount:
        opened.receiptLocator.operationControlCandidateCount ?? 1,
      receiptControlFound: true,
      receiptControlClicked: true,
      receiptEntryFound: true,
      receiptEntryVisible: entryState.visible,
      receiptEntryEnabled: entryState.enabled,
      receiptEntryClicked: true,
      dialogOpened: true,
      snInputFound: true,
      remarkInputFound: true,
      remarkHasDefaultValue,
      confirmButtonFound: true,
      confirmButtonVisible: confirmStructure.visible,
      confirmButtonEnabled: confirmStructure.enabled,
      cancelButtonFound: Boolean(cancelButton),
      closeButtonFound: Boolean(closeButton),
      dialogClosed,
      blockedRequestCount: guardState.blockedRequestCount,
      confirmClicked: false,
      missingFields: [],
      operationDiagnostics: opened.operationDiagnostics,
      ...opened.receiptLocator,
      fields: {
        sn: await describeReceiptControl(snInput, "sn"),
        remark: await describeReceiptControl(remarkInput, "remark"),
      },
      finalAction: confirmStructure,
      confirmed: false,
      recloudModified: false,
      message: "已定位瑞云签收表单，未填写字段，未点击最终确认",
    };
  } finally {
    if (dialog && !dialogClosed) {
      await closeDialog();
      logReceiptInspection("dialog_closed_without_changes", logger);
    }
    await networkGuard?.stop();
  }
}

const DETECTION_FIELD_LABELS = Object.freeze([
  "故障分类（快速选择）",
  "是否与客服登记原因一致",
  "保修状态",
  "检测结果",
  "检测无异常",
  "成品功能判断",
  "是否原厂耗材",
  "耗材名称",
  "是否拆封",
  "责任判定",
]);

async function collectDetectionFieldControls(dialog) {
  const controls = [];
  for (const label of DETECTION_FIELD_LABELS) {
    const labelPattern = new RegExp(
      label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[（(]/g, "[（(]").replace(/[）)]/g, "[）)]")
    );
    const items = dialog
      .locator(".rt-form-item:visible, .el-form-item:visible")
      .filter({ hasText: labelPattern });
    const itemCount = await items.count().catch(() => 0);
    const item = items.last();
    const found = itemCount > 0;
    controls.push({
      label,
      found,
      itemCount,
      inputCount: found ? await item.locator("input:visible").count().catch(() => 0) : 0,
      textareaCount: found ? await item.locator("textarea:visible").count().catch(() => 0) : 0,
      comboboxCount: found ? await item.locator("[role='combobox']:visible").count().catch(() => 0) : 0,
      radioCount: found ? await item.locator("input[type='radio'], [role='radio']").count().catch(() => 0) : 0,
    });
  }
  return controls;
}

async function inspectDetectionForm(page, options = {}) {
  if (options.dryRun !== true || options.writeEnabled !== false) {
    const error = new Error("检测弹窗定位只允许在严格只读模式下执行");
    error.code = "RECLOUD_DETECTION_INSPECTION_UNSAFE";
    error.status = 403;
    throw error;
  }
  assertRecloudAuthenticated(page);
  const guardState = createSimulationState();
  let networkGuard = null;
  let dialog = null;
  let dialogClosed = false;
  let faultInput = null;
  let faultInputTouched = false;
  let faultKeywordRestored = true;
  let originalFaultKeyword = "";
  try {
    if (typeof page.context === "function" && typeof page.context()?.route === "function") {
      networkGuard = await createReceiptNetworkGuard(page, guardState);
    }
    if (typeof page.setViewportSize === "function") {
      const viewport = typeof page.viewportSize === "function" ? page.viewportSize() : null;
      if (!viewport || viewport.width < 1600) {
        await page.setViewportSize({ width: 1920, height: Math.max(viewport?.height || 1080, 900) });
        await page.waitForTimeout?.(500);
      }
    }
    const visible = [];
    const scopes = typeof page.frames === "function"
      ? [page, ...page.frames().filter((frame) => typeof page.mainFrame !== "function" || frame !== page.mainFrame())]
      : [page];
    const entryDeadline = Date.now() + (options.actionTimeout ?? 10000);
    while (visible.length === 0 && Date.now() < entryDeadline) {
      for (const scope of scopes) {
        await activateReceiptDetailTabs(scope, page, options.logger || console);
        const region = await prepareRmaDetailRegion(scope, page);
        if (!region) continue;
        const candidates = region
          .locator("button:visible, a:visible, [role='button']:visible")
          .filter({ hasText: /^检测$/ });
        for (let index = 0; index < await candidates.count(); index += 1) {
          const candidate = candidates.nth(index);
          if (await candidate.isVisible().catch(() => false)) visible.push(candidate);
        }
        if (visible.length === 0) {
          const exactTexts = region.getByText("检测", { exact: true });
          for (let index = 0; index < await exactTexts.count(); index += 1) {
            const candidate = exactTexts.nth(index);
            if (await candidate.isVisible().catch(() => false)) visible.push(candidate);
          }
        }
      }
      if (visible.length === 0) await page.waitForTimeout?.(500);
    }
    if (visible.length > 1) {
      const uniqueByPosition = new Map();
      for (const candidate of visible) {
        const box = await candidate.boundingBox().catch(() => null);
        const key = box
          ? `${Math.round(box.x)}:${Math.round(box.y)}:${Math.round(box.width)}:${Math.round(box.height)}`
          : `unpositioned:${uniqueByPosition.size}`;
        const inFixedRight = await candidate.locator("xpath=ancestor::*[contains(@class,'table__fixed-right')][1]").count().catch(() => 0);
        const existing = uniqueByPosition.get(key);
        const existingInFixedRight = existing
          ? await existing.locator("xpath=ancestor::*[contains(@class,'table__fixed-right')][1]").count().catch(() => 0)
          : 0;
        if (!existing || (inFixedRight && !existingInFixedRight)) uniqueByPosition.set(key, candidate);
      }
      visible.splice(0, visible.length, ...uniqueByPosition.values());
    }
    if (visible.length > 1) {
      const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
      const inViewport = [];
      for (const candidate of visible) {
        const box = await candidate.boundingBox().catch(() => null);
        if (box && box.x < viewport.width && box.y < viewport.height && box.x + box.width > 0 && box.y + box.height > 0) {
          inViewport.push(candidate);
        }
      }
      if (inViewport.length === 1) visible.splice(0, visible.length, inViewport[0]);
    }
    if (visible.length !== 1) {
      const candidateDescriptors = [];
      for (const candidate of visible.slice(0, 5)) {
        const structure = await candidate.evaluate((element) => ({
          tag: String(element.tagName || "").toLowerCase(),
          role: String(element.getAttribute("role") || ""),
          classNames: String(element.className || "").split(/\s+/).filter((value) => /^[A-Za-z0-9_-]{1,60}$/.test(value)).slice(0, 8),
          parentTag: String(element.parentElement?.tagName || "").toLowerCase(),
          parentRole: String(element.parentElement?.getAttribute("role") || ""),
        })).catch(() => ({}));
        const box = await candidate.boundingBox().catch(() => null);
        candidateDescriptors.push({ ...structure, box: box ? { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) } : null });
      }
      const error = new Error(visible.length ? "瑞云检测入口不唯一" : "未找到瑞云检测入口");
      error.code = visible.length ? "RECLOUD_DETECTION_ENTRY_AMBIGUOUS" : "RECLOUD_DETECTION_ENTRY_NOT_FOUND";
      error.status = 502;
      error.missingFields = ["detection.entry"];
      error.inspection = { detectionEntryCandidateCount: visible.length, candidateDescriptors, confirmed: false };
      throw error;
    }
    await visible[0].click({ timeout: options.clickTimeout ?? 5000 });
    dialog = page.locator(".rt-dialog__wrapper:visible, .el-dialog__wrapper:visible, [role='dialog']:visible").last();
    await dialog.waitFor({ state: "visible", timeout: options.dialogTimeout ?? 10000 });
    await networkGuard?.assertSafe();
    const fieldLabels = [...new Set((await dialog
      .locator("label:visible, .rt-form-item__label:visible, .el-form-item__label:visible")
      .allInnerTexts())
      .map((value) => normalizeText(value).replace(/^\*+|\*+$/g, "").trim())
      .filter((value) => value && value.length <= 40))];
    const placeholders = [...new Set((await dialog
      .locator("input:visible, textarea:visible")
      .evaluateAll((elements) => elements.map((element) => String(element.getAttribute("placeholder") || "").trim())))
      .filter((value) => value && value.length <= 60))];
    const requiredControls = dialog.locator("[required]:visible, [aria-required='true']:visible, .is-required input:visible, .is-required textarea:visible, .is-required [role='combobox']:visible");
    const requiredFieldCount = await requiredControls.count();
    const requiredFieldLabels = [...new Set((await dialog
      .locator(".is-required:visible")
      .evaluateAll((elements) => elements.map((element) => String(element.querySelector("label, .rt-form-item__label, .el-form-item__label")?.textContent || "").replace(/^\*+|\*+$/g, "").trim())))
      .filter((value) => value && value.length <= 40))];
    const fieldControls = await collectDetectionFieldControls(dialog);
    let faultQuickSelectFound = false;
    let faultOptions = [];
    let faultKeywordFilled = false;
    const faultKeyword = normalizeText(options.faultKeyword || "").slice(0, 30);
    const listAllFaults = options.listAllFaults === true;
    if (faultKeyword || listAllFaults) {
      const faultItems = dialog.locator(".rt-form-item:visible, .el-form-item:visible").filter({ hasText: /故障分类（快速选择）/ });
      const faultItem = faultItems.last();
      if (await faultItem.count()) {
        faultInput = faultItem.locator("input:visible").last();
        if (await faultInput.count()) {
          faultQuickSelectFound = true;
          originalFaultKeyword = await faultInput.inputValue().catch(() => "");
          await faultInput.click({ timeout: 3000 });
          if (faultKeyword) {
            faultInputTouched = true;
            faultKeywordRestored = false;
            await faultInput.fill(faultKeyword);
            faultKeywordFilled = true;
          }
          await page.waitForTimeout?.(500);
          await networkGuard?.assertSafe();
          const optionLocator = page.locator(".rt-select-dropdown:visible [role='option']:visible, .el-select-dropdown:visible [role='option']:visible, .rt-cascader-dropdown:visible li:visible, .el-cascader__dropdown:visible li:visible");
          const dropdownLocator = page.locator(".rt-select-dropdown:visible, .el-select-dropdown:visible, .rt-cascader-dropdown:visible, .el-cascader__dropdown:visible").last();
          const collected = new Set();
          let unchanged = 0;
          for (let pass = 0; pass < (listAllFaults ? 200 : 1) && unchanged < 3; pass += 1) {
            const before = collected.size;
            for (const value of await optionLocator.allInnerTexts()) {
              const normalized = normalizeText(value);
              if (normalized && normalized.length <= 160) collected.add(normalized);
            }
            unchanged = collected.size === before ? unchanged + 1 : 0;
            if (!listAllFaults) break;
            await dropdownLocator.evaluate((element) => {
              const scroller = [element, ...element.querySelectorAll("*")]
                .find((node) => node.scrollHeight > node.clientHeight + 2);
              if (scroller) scroller.scrollTop = Math.min(scroller.scrollTop + Math.max(scroller.clientHeight - 30, 100), scroller.scrollHeight);
            }).catch(() => {});
            await page.waitForTimeout?.(100);
          }
          if (listAllFaults) {
            const fullPaths = new Set();
            for (const seed of [...collected]) {
              faultInputTouched = true;
              faultKeywordRestored = false;
              await faultInput.fill(seed);
              await page.waitForTimeout?.(500);
              await networkGuard?.assertSafe();
              for (const value of await optionLocator.allInnerTexts()) {
                const normalized = normalizeText(value);
                if (normalized.includes("/") && normalized.length <= 240) fullPaths.add(normalized);
              }
              const panelText = await dropdownLocator.innerText().catch(() => "");
              for (const line of panelText.split(/\r?\n/)) {
                const normalized = normalizeText(line);
                if (normalized.includes("/") && normalized.length <= 240) fullPaths.add(normalized);
              }
            }
            faultOptions = [...fullPaths].slice(0, 5000);
          } else {
            faultOptions = [...collected].slice(0, 50);
          }
          if (faultKeywordFilled || listAllFaults) {
            await faultInput.fill(originalFaultKeyword);
            await page.waitForTimeout?.(100);
            await networkGuard?.assertSafe();
            faultKeywordRestored = (await faultInput.inputValue().catch(() => null)) === originalFaultKeyword;
            if (!faultKeywordRestored) {
              const error = new Error("瑞云检测搜索演练内容清理失败");
              error.code = "RECLOUD_DETECTION_SIMULATION_CLEANUP_FAILED";
              error.status = 502;
              error.missingFields = ["detection.faultKeywordRestore"];
              throw error;
            }
          }
        }
      }
    }
    let prefill = null;
    if (options.prefillPlan) {
      try {
        prefill = await executeDetectionPrefillSafely(
          options.prefillPlan,
          createRecloudDetectionControlAdapter(page, dialog)
        );
      } catch (error) {
        if (error?.code !== "RECLOUD_DETECTION_PREFILL_RESTORE_FAILED" || error.valuesVerified !== true) throw error;
        const visibleCloseButtons = dialog.locator("button[aria-label='Close']:visible");
        let topmostClose = null;
        let topmostY = Number.POSITIVE_INFINITY;
        for (let index = 0; index < await visibleCloseButtons.count(); index += 1) {
          const candidate = visibleCloseButtons.nth(index);
          const box = await candidate.boundingBox().catch(() => null);
          if (box && box.y < topmostY) {
            topmostY = box.y;
            topmostClose = candidate;
          }
        }
        const detectionShell = page.locator(".rtxpc-dialog:visible, .el-dialog:visible").filter({
          has: page.locator(".el-dialog__title:visible, .rtxpc-dialog__title:visible").filter({ hasText: /^检测$/ }),
        }).last();
        const rollbackControl = await firstVisible([
          topmostClose,
          detectionShell.locator(":scope > .el-dialog__header button[aria-label='Close'], :scope > .rtxpc-dialog__header button[aria-label='Close'], button[aria-label='Close']").first(),
          dialog.locator(":scope > .el-dialog > .el-dialog__header button[aria-label='Close'], :scope > .rtxpc-dialog > .rtxpc-dialog__header button[aria-label='Close']").first(),
          dialog.getByRole("button", { name: /^(取消|关闭|返回)$/ }).last(),
          dialog.locator("button[aria-label='Close'], button[aria-label*='关闭'], button[title*='关闭'], .el-dialog__headerbtn, .rt-dialog__close").first(),
        ]);
        if (rollbackControl) await rollbackControl.click({ timeout: 3000, force: true }).catch(() => {});
        await page.waitForTimeout?.(300);
        for (let attempt = 0; attempt < 3 && await dialog.isVisible().catch(() => false); attempt += 1) {
          await page.keyboard.press("Escape").catch(() => {});
          await page.waitForTimeout?.(300);
        }
        dialogClosed = await dialog.isVisible().then((value) => !value).catch(() => true);
        await networkGuard?.assertSafe();
        let rollbackMethod = "DIALOG_CLOSE_ROLLBACK";
        if (!dialogClosed && typeof page.close === "function") {
          await page.close({ runBeforeUnload: false });
          dialogClosed = true;
          rollbackMethod = "PAGE_CLOSE_ROLLBACK";
        }
        if (!dialogClosed) {
          error.rollbackDialogText = String(await dialog.innerText().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 500);
          error.rollbackCloseCandidates = await dialog.locator("[class*='close'], [class*='Close'], [aria-label], [title]").evaluateAll((elements) => elements.map((element) => ({
            tag: String(element.tagName || "").toLowerCase(),
            text: String(element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40),
            title: String(element.getAttribute("title") || "").slice(0, 80),
            ariaLabel: String(element.getAttribute("aria-label") || "").slice(0, 80),
            className: String(element.className || "").split(/\s+/).slice(0, 10).join(" ").slice(0, 200),
          })).slice(0, 40)).catch(() => []);
          error.rollbackControls = await dialog.locator("button:visible, [role='button']:visible").evaluateAll((elements) => elements.map((element) => ({
            text: String(element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80),
            title: String(element.getAttribute("title") || "").slice(0, 80),
            ariaLabel: String(element.getAttribute("aria-label") || "").slice(0, 80),
            className: String(element.className || "").split(/\s+/).slice(0, 8).join(" ").slice(0, 160),
          })).slice(0, 30)).catch(() => []);
          throw error;
        }
        prefill = {
          dryRun: true,
          fieldsPlanned: error.fieldsPlanned,
          fieldsWritten: error.fieldsWritten,
          fieldsRestored: [],
          valuesVerified: true,
          valuesRestored: true,
          restoreMethod: rollbackMethod,
          confirmClicked: false,
          confirmed: false,
          recloudModified: false,
        };
      }
      await networkGuard?.assertSafe();
    }
    if (!dialogClosed) {
      const closeControl = await firstVisible([
        page.locator(".rtxpc-dialog:visible, .el-dialog:visible").filter({
          has: page.locator(".el-dialog__title:visible, .rtxpc-dialog__title:visible").filter({ hasText: /^检测$/ }),
        }).last().locator(":scope > .el-dialog__header button[aria-label='Close'], :scope > .rtxpc-dialog__header button[aria-label='Close'], button[aria-label='Close']").first(),
        dialog.locator(":scope > .el-dialog > .el-dialog__header button[aria-label='Close'], :scope > .rtxpc-dialog > .rtxpc-dialog__header button[aria-label='Close']").first(),
        dialog.getByRole("button", { name: /^(取消|关闭|返回)$/ }).last(),
        dialog.locator("button[aria-label='Close'], button[aria-label*='关闭'], button[title*='关闭'], .el-dialog__headerbtn, .rt-dialog__close").first(),
      ]);
      if (closeControl) await closeControl.click({ timeout: 3000, force: true }).catch(() => {});
      await page.waitForTimeout?.(300);
      if (await dialog.isVisible().catch(() => false)) {
        await page.keyboard.press("Escape").catch(() => {});
        await page.waitForTimeout?.(300);
      }
      dialogClosed = await dialog.isVisible().then((value) => !value).catch(() => true);
    }
    await networkGuard?.assertSafe();
    return {
      dryRun: true,
      detectionEntryCandidateCount: 1,
      detectionEntryClicked: true,
      dialogOpened: true,
      fieldLabels,
      placeholders,
      requiredFieldCount,
      requiredFieldLabels,
      fieldControls,
      faultQuickSelectFound,
      faultOptions,
      faultKeywordFilled,
      faultKeywordRestored,
      prefill,
      valuesVerified: faultKeyword ? faultOptions.length > 0 : true,
      modelFieldFound: [...fieldLabels, ...placeholders].some((value) => /型号/.test(value)),
      dialogClosed,
      blockedRequestCount: guardState.blockedRequestCount,
      confirmClicked: false,
      confirmed: false,
      recloudModified: false,
    };
  } finally {
    let cleanupError = null;
    if (faultInput && faultInputTouched && !faultKeywordRestored) {
      try {
        await faultInput.fill(originalFaultKeyword);
        await page.waitForTimeout?.(100);
        await networkGuard?.assertSafe();
        faultKeywordRestored = (await faultInput.inputValue().catch(() => null)) === originalFaultKeyword;
        if (!faultKeywordRestored) throw new Error("检测搜索框未恢复原值");
      } catch (error) {
        cleanupError = new Error("瑞云检测搜索演练内容清理失败");
        cleanupError.code = "RECLOUD_DETECTION_SIMULATION_CLEANUP_FAILED";
        cleanupError.status = 502;
        cleanupError.missingFields = ["detection.faultKeywordRestore"];
        cleanupError.cause = error;
      }
    }
    if (dialog && !dialogClosed) {
      await page.keyboard.press("Escape").catch(() => {});
    }
    await networkGuard?.stop();
    if (cleanupError) throw cleanupError;
  }
}

async function inspectRepairForm(page, options = {}) {
  if (options.dryRun !== true || options.writeEnabled !== false) {
    const error = new Error("维修单定位只允许在严格只读模式下执行");
    error.code = "RECLOUD_REPAIR_INSPECTION_UNSAFE";
    error.status = 403;
    throw error;
  }
  assertRecloudAuthenticated(page);
  const guardState = createSimulationState();
  let networkGuard = null;
  let dialog = null;
  let dialogClosed = false;
  const startingUrl = typeof page.url === "function" ? page.url() : "";
  try {
    if (typeof page.context === "function" && typeof page.context()?.route === "function") {
      networkGuard = await createReceiptNetworkGuard(page, guardState);
    }
    const entries = [];
    const observedActionTexts = new Set();
    const scopes = typeof page.frames === "function"
      ? [page, ...page.frames().filter((frame) => typeof page.mainFrame !== "function" || frame !== page.mainFrame())]
      : [page];
    for (const scope of scopes) {
      await activateReceiptDetailTabs(scope, page, options.logger || console);
      const region = await prepareRmaDetailRegion(scope, page);
      if (!region) continue;
      for (const value of await region.locator("button:visible, a:visible, [role='button']:visible").allInnerTexts().catch(() => [])) {
        const normalized = normalizeText(value);
        if (normalized && normalized.length <= 30) observedActionTexts.add(normalized);
      }
      const candidates = region.locator("button:visible, a:visible, [role='button']:visible").filter({ hasText: /^维修$/ });
      for (let index = 0; index < await candidates.count(); index += 1) {
        const candidate = candidates.nth(index);
        if (await candidate.isVisible().catch(() => false)) entries.push(candidate);
      }
    }
    if (entries.length > 1) {
      const fixedRightEntries = [];
      for (const entry of entries) {
        const inFixedRight = await entry
          .locator("xpath=ancestor::*[contains(@class,'table__fixed-right')][1]")
          .count()
          .catch(() => 0);
        if (inFixedRight) fixedRightEntries.push(entry);
      }
      if (fixedRightEntries.length === 1) entries.splice(0, entries.length, fixedRightEntries[0]);
    }
    if (entries.length > 1) {
      const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
      const inViewport = [];
      for (const entry of entries) {
        const box = await entry.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        }).catch(() => null);
        if (box && box.x < viewport.width && box.y < viewport.height && box.x + box.width > 0 && box.y + box.height > 0) {
          inViewport.push(entry);
        }
      }
      if (inViewport.length === 1) entries.splice(0, entries.length, inViewport[0]);
    }
    if (entries.length !== 1) {
      (options.logger || console).info("RECLOUD_REPAIR_ACTIONS:", JSON.stringify([...observedActionTexts].slice(0, 80)));
      if (entries.length === 0) {
        const rmaBodyText = String(await page.locator("body").innerText().catch(() => ""));
        const serviceOrderCandidates = [...new Set(rmaBodyText.match(/\b(?:FW|WX|SO)[A-Z0-9-]{8,}\b/gi) || [])].slice(0, 30);
        const serialCandidates = [...new Set((rmaBodyText.match(/\b[A-Z0-9]{6,}CN[A-Z0-9]{4,}\b/gi) || [])
          .map((value) => value.toUpperCase()))].slice(0, 20);
        const serviceOrderRegions = (await page.getByText(/服务单|关联服务/, { exact: false }).allInnerTexts().catch(() => []))
          .map(normalizeText)
          .filter((value) => value && value.length <= 80)
          .slice(0, 50);
        (options.logger || console).info("RECLOUD_RMA_SERVICE_ORDER_REFERENCES:", JSON.stringify({
          candidates: serviceOrderCandidates,
          serialCandidateCount: serialCandidates.length,
          labels: [...new Set(serviceOrderRegions)],
        }));
        const directServiceOrder = serviceOrderCandidates.length === 1
          ? page.getByText(serviceOrderCandidates[0], { exact: true }).filter({ visible: true })
          : null;
        if (directServiceOrder && await directServiceOrder.count() === 1) {
          entries.push(directServiceOrder.first());
        }
        const repairOrdersMenu = page.getByText("寄修-维修单", { exact: true }).filter({ visible: true }).first();
        if (entries.length === 0 && serviceOrderCandidates.length === 1 && await repairOrdersMenu.count() && await repairOrdersMenu.isVisible().catch(() => false)) {
          await repairOrdersMenu.click({ timeout: options.clickTimeout ?? 5000 });
          await page.waitForTimeout?.(800);
          const repairSearchInput = page.getByPlaceholder("服务单号/反馈人/反馈电话/联系地址", { exact: true }).filter({ visible: true }).first();
          if (await repairSearchInput.count() && await repairSearchInput.isVisible().catch(() => false)) {
            await repairSearchInput.fill(serviceOrderCandidates[0]);
            await repairSearchInput.press("Enter");
            await page.waitForTimeout?.(800);
          }
          const matchedServiceOrders = page.getByText(serviceOrderCandidates[0], { exact: true }).filter({ visible: true });
          (options.logger || console).info("RECLOUD_REPAIR_SERVICE_ORDER_MATCHES:", JSON.stringify({ count: await matchedServiceOrders.count() }));
          if (await matchedServiceOrders.count() === 1) {
            entries.push(matchedServiceOrders.first());
          } else if (await matchedServiceOrders.count() === 0) {
            const historyMenu = page.getByText("历史维修单查询", { exact: true }).filter({ visible: true }).first();
            if (await historyMenu.count() && await historyMenu.isVisible().catch(() => false)) {
              await historyMenu.click({ timeout: options.clickTimeout ?? 5000 });
              await page.waitForTimeout?.(800);
              const historyInputs = page.locator("input:visible");
              const historyPlaceholders = await historyInputs.evaluateAll((elements) => elements.map((element) => String(element.getAttribute("placeholder") || "").trim())).catch(() => []);
              (options.logger || console).info("RECLOUD_REPAIR_HISTORY_SCHEMA:", JSON.stringify({
                placeholders: [...new Set(historyPlaceholders)].filter(Boolean).slice(0, 50),
              }));
              const historyInput = page.getByPlaceholder("请输入设备序列号/手机号", { exact: true }).filter({ visible: true }).first();
              const historyTerm = serialCandidates.length === 1 ? serialCandidates[0] : "";
              if (historyTerm && await historyInput.count() && await historyInput.isVisible().catch(() => false)) {
                await historyInput.fill(historyTerm);
                await historyInput.press("Enter");
                const historyLoading = page.locator(".el-loading-mask:visible, .rt-loading:visible, [class*='loading']:visible").first();
                if (await historyLoading.count() && await historyLoading.isVisible().catch(() => false)) {
                  await historyLoading.waitFor({ state: "hidden", timeout: options.actionTimeout ?? 10000 }).catch(() => {});
                } else {
                  await page.waitForTimeout?.(1500);
                }
              }
              const historyMatches = page.getByText(serviceOrderCandidates[0], { exact: true }).filter({ visible: true });
              (options.logger || console).info("RECLOUD_REPAIR_HISTORY_MATCHES:", JSON.stringify({
                count: await historyMatches.count(),
                rowCount: await page.locator("tbody tr:visible, [role='row']:visible").count(),
                actions: [...new Set((await page.locator("button:visible, [role='button']:visible").allInnerTexts().catch(() => [])).map(normalizeText).filter((value) => value && value.length <= 30))].slice(0, 50),
              }));
              if (await historyMatches.count() === 1) entries.push(historyMatches.first());
            }
          }
          (options.logger || console).info("RECLOUD_REPAIR_BLOCKED_REQUESTS:", JSON.stringify(guardState.blockedRequests.slice(0, 20)));
        }
      }
      if (entries.length !== 1) {
        const error = new Error(entries.length ? "瑞云维修入口不唯一" : "未找到瑞云维修入口");
        error.code = entries.length ? "RECLOUD_REPAIR_ENTRY_AMBIGUOUS" : "RECLOUD_REPAIR_ENTRY_NOT_FOUND";
        error.status = 502;
        error.missingFields = ["repair.entry"];
        throw error;
      }
    }
    await entries[0].click({ timeout: options.clickTimeout ?? 5000 });
    await page.waitForTimeout?.(800);
    try {
      await networkGuard?.assertSafe();
    } catch (error) {
      (options.logger || console).info("RECLOUD_REPAIR_DETAIL_BLOCKED_REQUESTS:", JSON.stringify(guardState.blockedRequests.slice(0, 20)));
      throw error;
    }
    const serviceReportTab = page.getByText("服务报告", { exact: true }).filter({ visible: true }).first();
    let serviceReportOpened = false;
    if (await serviceReportTab.count() && await serviceReportTab.isVisible().catch(() => false)) {
      await serviceReportTab.click({ timeout: options.clickTimeout ?? 5000 });
      await page.waitForTimeout?.(800);
      await networkGuard?.assertSafe();
      serviceReportOpened = true;
    }
    let repairMeasureSimulation = null;
    const simulationText = String(options.simulateMeasureText || "").trim();
    if (serviceReportOpened && simulationText) {
      const heading = page.getByText("故障模式及责任判定", { exact: true }).filter({ visible: true }).last();
      if (!(await heading.count()) || !(await heading.isVisible().catch(() => false))) {
        const error = new Error("服务报告中没有找到故障模式及责任判定区域");
        error.code = "RECLOUD_REPAIR_MEASURE_SECTION_NOT_FOUND";
        error.status = 502;
        error.missingFields = ["repair.faultModeSection"];
        throw error;
      }
      await heading.scrollIntoViewIfNeeded();
      const headingBox = await heading.boundingBox();
      const rows = page.locator("tbody tr:visible");
      const rowCandidates = [];
      for (let index = 0; index < await rows.count(); index += 1) {
        const row = rows.nth(index);
        const box = await row.boundingBox().catch(() => null);
        if (!box || !headingBox || box.y <= headingBox.y) continue;
        const distance = box.y - (headingBox.y + headingBox.height);
        if (distance >= 0 && distance <= 260) rowCandidates.push({ distance, width: box.width, row, box });
      }
      rowCandidates.sort((left, right) => left.distance - right.distance || right.width - left.width);
      if (!rowCandidates.length) {
        const error = new Error("故障模式及责任判定区域没有找到已有数据行");
        error.code = "RECLOUD_REPAIR_MEASURE_ROW_NOT_FOUND";
        error.status = 502;
        error.missingFields = ["repair.faultModeRow"];
        throw error;
      }
      const editableTextareas = page.locator("textarea:visible:not([disabled])");
      const textareaCountBefore = await editableTextareas.count();
      const target = rowCandidates[0];
      const waitForMeasureEditor = async (timeoutMs = 2500) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          if (await editableTextareas.count() > textareaCountBefore) return true;
          await page.waitForTimeout?.(100);
        }
        return false;
      };
      await target.row.dblclick({
        force: true,
        position: { x: Math.max(12, target.box.width - 36), y: target.box.height / 2 },
        delay: 120,
      });
      if (!(await waitForMeasureEditor())) {
        await target.row.dispatchEvent("dblclick");
        await waitForMeasureEditor();
      }
      await networkGuard?.assertSafe();
      const editableCandidates = [];
      for (let index = 0; index < await editableTextareas.count(); index += 1) {
        const field = editableTextareas.nth(index);
        if (!(await field.isEditable().catch(() => false))) continue;
        const box = await field.boundingBox().catch(() => null);
        if (box) editableCandidates.push({ area: box.width * box.height, index, field });
      }
      editableCandidates.sort((left, right) => right.area - left.area || right.index - left.index);
      if (!editableCandidates.length || await editableTextareas.count() <= textareaCountBefore) {
        const error = new Error("双击已有故障记录后没有打开维修措施编辑框");
        error.code = "RECLOUD_REPAIR_MEASURE_EDITOR_NOT_FOUND";
        error.status = 502;
        error.missingFields = ["repair.measureTextarea"];
        throw error;
      }
      const measureField = editableCandidates[0].field;
      const originalValue = await measureField.inputValue();
      let restored = false;
      try {
        await measureField.fill(simulationText);
        await networkGuard?.assertSafe();
        if (normalizeText(await measureField.inputValue()) !== normalizeText(simulationText)) {
          throw new Error("维修措施演练值校验失败");
        }
      } finally {
        await measureField.fill(originalValue).catch(() => {});
        restored = (await measureField.inputValue().catch(() => null)) === originalValue;
      }
      if (!restored) {
        const error = new Error("维修措施原内容恢复失败");
        error.code = "RECLOUD_REPAIR_MEASURE_RESTORE_FAILED";
        error.status = 502;
        error.missingFields = ["repair.measureRestore"];
        throw error;
      }
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout?.(200);
      repairMeasureSimulation = {
        editorOpened: true,
        valueFilled: true,
        valueVerified: true,
        originalValueRestored: true,
        saveClicked: false,
      };
    }
    const visibleDialogs = page.locator(".rt-dialog__wrapper:visible, .el-dialog__wrapper:visible, [role='dialog']:visible");
    dialog = await visibleDialogs.count() ? visibleDialogs.last() : null;
    const formScope = dialog || page;
    const fieldLabels = [...new Set((await formScope
      .locator("label:visible, .rt-form-item__label:visible, .el-form-item__label:visible")
      .allInnerTexts())
      .map((value) => normalizeText(value).replace(/^\*+|\*+$/g, "").trim())
      .filter((value) => value && value.length <= 50))];
    const placeholders = [...new Set((await formScope
      .locator("input:visible, textarea:visible")
      .evaluateAll((elements) => elements.map((element) => String(element.getAttribute("placeholder") || "").trim())))
      .filter((value) => value && value.length <= 80))];
    const actionTexts = [...new Set((await formScope
      .locator("button:visible, [role='button']:visible")
      .allInnerTexts())
      .map(normalizeText)
      .filter((value) => value && value.length <= 30))];
    const navigationTexts = [...new Set((await formScope
      .locator("a:visible, [role='tab']:visible")
      .allInnerTexts())
      .map(normalizeText)
      .filter((value) => value && value.length <= 30))];
    const repairSectionNames = ["服务单更换件明细", "故障模式及责任判定", "维修内容", "附件"];
    const sectionTitles = [];
    for (const sectionName of repairSectionNames) {
      const matches = formScope.getByText(sectionName, { exact: true }).filter({ visible: true });
      if (await matches.count()) sectionTitles.push(sectionName);
    }
    const requiredFieldLabels = [...new Set((await formScope
      .locator(".is-required:visible")
      .evaluateAll((elements) => elements.map((element) => String(element.querySelector("label, .rt-form-item__label, .el-form-item__label")?.textContent || "").replace(/^\*+|\*+$/g, "").trim())))
      .filter(Boolean))];
    const directRepairControls = serviceReportOpened
      ? await inspectDirectRepairControls(formScope)
      : [];
    const partsTableSchema = serviceReportOpened
      ? await inspectRepairPartsTable(formScope).catch((error) => ({
          errorCode: error.code || "RECLOUD_REPAIR_PARTS_SCHEMA_CHANGED",
          missingFields: error.missingFields || [],
        }))
      : null;
    const attachmentPanelSchema = serviceReportOpened
      ? await inspectRepairAttachmentPanel(formScope).catch((error) => ({
          errorCode: error.code || "RECLOUD_REPAIR_ATTACHMENT_SCHEMA_CHANGED",
          missingFields: error.missingFields || [],
        }))
      : null;
    let partAddDialogInspection = null;
    if (serviceReportOpened && options.inspectPartAddDialog === true) {
      let partDialog = null;
      try {
        partDialog = await openRepairPartAddDialog(page, {
          assertSafe: () => networkGuard?.assertSafe(),
          timeoutMs: options.actionTimeout ?? 5000,
        });
        partAddDialogInspection = await inspectAndCloseRepairPartAddDialog(page, partDialog);
      } catch (error) {
        if (partDialog && await partDialog.isVisible().catch(() => false)) await page.keyboard.press("Escape").catch(() => {});
        if (options.allowUnavailablePartAdd === true && error.code === "RECLOUD_REPAIR_PART_ADD_NOT_FOUND") {
          partAddDialogInspection = {
            unavailable: true,
            errorCode: error.code,
            missingFields: error.missingFields || ["repair.partsAddButton"],
          };
        } else {
          throw error;
        }
      }
    }
    let executionInspection = null;
    let executionReadiness = null;
    if (serviceReportOpened && options.inspectExecutionControls === true) {
      const execution = await inspectRepairExecutionControls(
        page,
        String(options.targetAssignee || "").trim(),
        {
          dryRun: true,
          writeEnabled: false,
          openAssignmentDialog: true,
          inspectPartAddDialog: true,
          assertSafe: () => networkGuard?.assertSafe(),
          guardState,
          timeoutMs: options.actionTimeout ?? 5000,
        }
      );
      executionInspection = execution.inspection;
      executionReadiness = execution.readiness;
    }
    const closeControl = dialog ? await firstVisible([
      dialog.getByRole("button", { name: /^(取消|关闭|返回)$/ }).last(),
      dialog.locator("button[aria-label*='关闭'], button[title*='关闭'], .el-dialog__headerbtn, .rt-dialog__close").last(),
    ]) : null;
    if (closeControl) await closeControl.click({ timeout: 3000 }).catch(() => {});
    if (dialog && await dialog.isVisible().catch(() => false)) await page.keyboard.press("Escape").catch(() => {});
    if (!dialog && startingUrl && typeof page.url === "function" && page.url() !== startingUrl) {
      await page.goBack({ waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
    }
    dialogClosed = dialog ? await dialog.isVisible().then((value) => !value).catch(() => true) : true;
    await networkGuard?.assertSafe();
    return {
      dryRun: true,
      repairEntryCandidateCount: 1,
      repairEntryClicked: true,
      serviceReportOpened,
      repairMeasureSimulation,
      formOpened: true,
      fieldLabels,
      placeholders,
      actionTexts,
      navigationTexts,
      sectionTitles,
      requiredFieldLabels,
      directRepairControls,
      partsTableSchema,
      attachmentPanelSchema,
      partAddDialogInspection,
      executionInspection,
      executionReadiness,
      dialogClosed,
      blockedRequestCount: guardState.blockedRequestCount,
      confirmClicked: false,
      confirmed: false,
      recloudModified: false,
    };
  } finally {
    if (dialog && !dialogClosed) await page.keyboard.press("Escape").catch(() => {});
    await networkGuard?.stop();
  }
}

function createSimulationState(overrides = {}) {
  return {
    receiptEntryClicked: false,
    dialogOpened: false,
    snFilled: false,
    remarkFilled: false,
    valuesVerified: false,
    snCleared: false,
    remarkRestored: false,
    dialogClosed: false,
    confirmClicked: false,
    networkGuardEnabled: false,
    mutationRequestDetected: false,
    blockedRequestCount: 0,
    blockedMethods: [],
    readRequestCount: 0,
    blockedRequests: [],
    readRequests: [],
    missingFields: [],
    errorCode: null,
    ...overrides,
  };
}

function logReceiptSimulation(stage, logger = console) {
  logger.info(`RECLOUD_RECEIPT_SIMULATION: ${stage}`);
}

function sanitizeRecloudRequestPath(url) {
  try {
    const pathname = new URL(url).pathname;
    return (
      pathname
        .split("/")
        .map((segment) => {
          if (!segment) return "";
          const decoded = decodeURIComponent(segment);
          if (
            decoded.length > 32 ||
            /\d{5,}/.test(decoded) ||
            /^[a-f0-9-]{16,}$/i.test(decoded)
          ) {
            return ":redacted";
          }
          return decoded.replace(/[^\p{L}\p{N}._~-]/gu, "");
        })
        .join("/") || "/"
    );
  } catch {
    return "/";
  }
}

function createReceiptActionResponseObserver(page) {
  const summaries = [];
  const pending = new Set();
  const allowedActionNames = new Set([
    "签收",
    "查看",
    "详情",
    "编辑",
    "删除",
    "更多",
  ]);
  const safeKey = (value) =>
    /^[A-Za-z_$][A-Za-z0-9_$.-]{0,79}$/.test(String(value || ""));
  const handler = (response) => {
    const task = (async () => {
      const request = response.request();
      const resourceType = request.resourceType?.() || "";
      if (!["xhr", "fetch"].includes(resourceType)) return;
      const contentType = String(
        response.headers?.()["content-type"] || ""
      ).toLowerCase();
      if (!contentType.includes("json")) return;
      const contentLength = Number(
        response.headers?.()["content-length"] || 0
      );
      if (contentLength > 2_000_000) return;
      let payload;
      try {
        payload = await response.json();
      } catch {
        return;
      }
      const topLevelFieldNames =
        payload && typeof payload === "object" && !Array.isArray(payload)
          ? Object.keys(payload).filter(safeKey).slice(0, 50)
          : [];
      const actionArrays = [];
      const seen = new Set();
      const visit = (value, path = [], depth = 0) => {
        if (!value || typeof value !== "object" || depth > 6) return;
        if (seen.has(value)) return;
        seen.add(value);
        if (Array.isArray(value)) {
          const fieldName = path.at(-1) || "";
          if (/action|operation|button|menu/i.test(fieldName)) {
            const names = new Set();
            for (const item of value.slice(0, 100)) {
              if (!item || typeof item !== "object") continue;
              const candidate =
                item.name || item.label || item.title || item.text;
              if (allowedActionNames.has(candidate)) names.add(candidate);
            }
            actionArrays.push({
              fieldName: safeKey(fieldName) ? fieldName : "",
              actionNames: [...names],
              count: value.length,
            });
          }
          for (const item of value.slice(0, 100)) {
            visit(item, path, depth + 1);
          }
          return;
        }
        for (const [key, child] of Object.entries(value).slice(0, 200)) {
          if (!safeKey(key)) continue;
          visit(child, [...path, key], depth + 1);
        }
      };
      visit(payload);
      summaries.push({
        method: String(request.method?.() || "GET").toUpperCase(),
        pathTemplate: sanitizeRecloudRequestPath(request.url?.() || ""),
        status: Number(response.status?.() || 0),
        topLevelFieldNames,
        actionArrays: actionArrays.slice(0, 20),
      });
    })();
    pending.add(task);
    task.finally(() => pending.delete(task));
  };
  page.on("response", handler);
  return {
    async stop() {
      page.off("response", handler);
      await Promise.allSettled([...pending]);
      return summaries.slice(0, 50);
    },
  };
}

function classifyRecloudRequest(request) {
  const method = String(request.method?.() || "GET").toUpperCase();
  const path = sanitizeRecloudRequestPath(request.url?.() || "");
  const descriptor = { method, path };
  if (["GET", "HEAD", "OPTIONS"].includes(method)) {
    return { kind: "read", descriptor };
  }

  const exactReadOnlyPostPaths = new Set([
    "/t/dreame/api/common/menuclick",
    "/t/dreame/api/vlist/ExecuteQuery",
    "/t/dreame/api/vlist/GetQueryListBadges",
    "/t/dreame/api/systemparameter/getvalues",
  ]);
  if (method === "POST" && exactReadOnlyPostPaths.has(path)) {
    return { kind: "read", descriptor };
  }

  const readPath =
    /(?:^|\/)(?:query|search|detail|list|page|find|get|load|lookup|preview|validate|check|options?|dictionary|config)(?:\/|$)/i.test(
      path
    ) ||
    /scanSignin\/query/i.test(path);
  const mutationPath =
    /(?:^|\/)(?:save|submit|confirm|receive|receipt|update|create|delete|remove|finish|complete|deliver|shipment|stock|inventory|consume|return)(?:\/|$)/i.test(
      path
    );
  if (method === "POST" && readPath && !mutationPath) {
    return { kind: "read", descriptor };
  }
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    return { kind: "mutation", descriptor };
  }
  return { kind: "read", descriptor };
}

async function createReceiptNetworkGuard(page, state) {
  const router =
    typeof page.context === "function" &&
    typeof page.context()?.route === "function"
      ? page.context()
      : page;
  const handler = async (route) => {
    const classification = classifyRecloudRequest(route.request());
    if (classification.kind === "mutation") {
      state.mutationRequestDetected = true;
      state.blockedRequestCount += 1;
      if (!state.blockedMethods.includes(classification.descriptor.method)) {
        state.blockedMethods.push(classification.descriptor.method);
      }
      state.blockedRequests.push(classification.descriptor);
      // route.abort resolves the intercepted request without sending it.
      await route.abort("blockedbyclient");
      return;
    }
    state.readRequestCount += 1;
    state.readRequests.push(classification.descriptor);
    await route.continue();
  };
  await router.route("**/*", handler);
  state.networkGuardEnabled = true;
  return {
    async assertSafe() {
      if (typeof page.isClosed !== "function" || !page.isClosed()) {
        await page.waitForTimeout?.(50);
      }
      if (!state.mutationRequestDetected) return;
      const error = new Error("演练期间检测并阻止了非预期写请求");
      error.code = "RECLOUD_UNEXPECTED_WRITE_REQUEST";
      error.status = 502;
      error.missingFields = [];
      throw error;
    },
    async stop() {
      await router.unroute("**/*", handler).catch(() => {});
    },
  };
}

async function simulateReceiptForm(page, sn, remark, options = {}) {
  const logger = options.logger || console;
  if (options.dryRun !== true || options.writeEnabled !== false) {
    const error = new Error("签收填写演练只允许在严格演练模式下执行");
    error.code = "RECLOUD_RECEIPT_SIMULATION_UNSAFE";
    error.status = 403;
    throw error;
  }
  assertRecloudAuthenticated(page);

  const requestedSn = String(sn ?? "");
  const requestedRemark = String(remark ?? "");
  if (!requestedSn.trim() || !requestedRemark.trim()) {
    const error = new Error("签收填写演练缺少 SN 或备注");
    error.code = "RECLOUD_RECEIPT_SIMULATION_INVALID";
    error.status = 400;
    error.missingFields = [
      !requestedSn.trim() && "sn",
      !requestedRemark.trim() && "remark",
    ].filter(Boolean);
    throw error;
  }

  const state = createSimulationState();
  let dialog = null;
  let formPage = page;
  let snInput = null;
  let remarkInput = null;
  let originalSn = "";
  let originalRemark = "";
  let networkGuard = null;
  let pendingError = null;
  try {
    const opened = await openReceiptFormForDryRun(page, options);
    dialog = opened.dialog;
    formPage = opened.formPage;
    state.receiptEntryClicked = true;
    state.dialogOpened = true;

    const controls = await locateReceiptFormControls(dialog);
    snInput = controls.snInput;
    remarkInput = controls.remarkInput;
    state.missingFields = [
      !snInput && "receipt.snInput",
      !remarkInput && "receipt.remarkInput",
      !controls.confirmButton && "receipt.confirmButton",
    ].filter(Boolean);
    if (state.missingFields.length > 0) {
      throw receiptInspectionError(
        "RECLOUD_SCHEMA_CHANGED",
        "瑞云签收弹窗字段结构已变化",
        state.missingFields,
        state
      );
    }

    networkGuard = await createReceiptNetworkGuard(formPage, state);
    logReceiptSimulation("networkGuardEnabled", logger);
    originalSn = await snInput.inputValue();
    originalRemark = await remarkInput.inputValue();
    if (originalSn !== "") {
      const error = new Error("测试工单 SN 输入框并非空白，已停止演练");
      error.code = "RECLOUD_RECEIPT_SIMULATION_DIRTY_FORM";
      error.status = 409;
      error.missingFields = [];
      throw error;
    }

    await snInput.fill(requestedSn);
    state.snFilled = true;
    logReceiptSimulation("snFilled", logger);
    await networkGuard.assertSafe();
    await remarkInput.fill(requestedRemark);
    state.remarkFilled = true;
    logReceiptSimulation("remarkFilled", logger);
    await networkGuard.assertSafe();

    if (
      (await snInput.inputValue()) !== requestedSn ||
      (await remarkInput.inputValue()) !== requestedRemark
    ) {
      const error = new Error("瑞云签收表单演练值校验失败");
      error.code = "RECLOUD_RECEIPT_SIMULATION_VALUE_MISMATCH";
      error.status = 502;
      error.missingFields = [];
      throw error;
    }
    state.valuesVerified = true;
    logReceiptSimulation("valuesVerified", logger);
  } catch (error) {
    pendingError = error;
  } finally {
    if (dialog) {
      try {
        if (snInput && state.snFilled) {
          await snInput.fill("");
          await networkGuard?.assertSafe().catch((error) => {
            pendingError ||= error;
          });
          state.snCleared = (await snInput.inputValue()) === "";
        } else if (snInput) {
          state.snCleared = originalSn === "";
        }
        if (remarkInput && state.remarkFilled) {
          await remarkInput.fill(originalRemark);
          await networkGuard?.assertSafe().catch((error) => {
            pendingError ||= error;
          });
          state.remarkRestored =
            (await remarkInput.inputValue()) === originalRemark;
        } else if (remarkInput) {
          state.remarkRestored =
            (await remarkInput.inputValue()) === originalRemark;
        }
        if (
          (state.snFilled && !state.snCleared) ||
          (state.remarkFilled && !state.remarkRestored)
        ) {
          const cleanupError = new Error("瑞云签收表单演练内容清理失败");
          cleanupError.code = "RECLOUD_RECEIPT_SIMULATION_CLEANUP_FAILED";
          cleanupError.status = 502;
          cleanupError.missingFields = [
            !state.snCleared && "receipt.snCleanup",
            !state.remarkRestored && "receipt.remarkRestore",
          ].filter(Boolean);
          pendingError ||= cleanupError;
        } else {
          logReceiptSimulation("valuesRestored", logger);
        }
      } catch {
        const cleanupError = new Error("瑞云签收表单演练内容清理失败");
        cleanupError.code = "RECLOUD_RECEIPT_SIMULATION_CLEANUP_FAILED";
        cleanupError.status = 502;
        cleanupError.missingFields = ["receipt.formCleanup"];
        pendingError ||= cleanupError;
      }
      try {
        await formPage.keyboard.press("Escape");
        state.dialogClosed = true;
        logReceiptSimulation("dialogClosed", logger);
      } catch {
        const closeError = new Error("瑞云签收表单演练结束后无法关闭表单");
        closeError.code = "RECLOUD_RECEIPT_SIMULATION_CLEANUP_FAILED";
        closeError.status = 502;
        closeError.missingFields = ["receipt.formClose"];
        pendingError ||= closeError;
      }
      await networkGuard?.assertSafe().catch((error) => {
        pendingError ||= error;
      });
      await networkGuard?.stop();
    }
  }

  if (pendingError) {
    state.errorCode = pendingError.code || "RECLOUD_ERROR";
    state.missingFields = Array.isArray(pendingError.missingFields)
      ? pendingError.missingFields
      : state.missingFields;
    pendingError.simulation = state;
    throw pendingError;
  }
  return state;
}

async function fillReceiptFields(dialog, sn, remark) {
  const inputs = dialog.locator("input:visible, textarea:visible");
  const snCandidates = locateDialogField(
    dialog,
    ["SN", "序列号", "设备序列号"],
    ["SN", "序列号"]
  );
  const remarkCandidates = locateDialogField(
    dialog,
    ["备注", "签收说明"],
    ["备注", "说明"]
  );

  const snInput = await firstVisible([
    snCandidates.byLabel,
    snCandidates.byPlaceholder,
    inputs.nth(3),
  ]);
  const remarkInput = await firstVisible([
    remarkCandidates.byLabel,
    remarkCandidates.byPlaceholder,
    dialog.locator("textarea:visible").first(),
    inputs.nth(4),
  ]);

  if (!snInput) throw new Error("瑞云签收弹窗中未找到 SN 输入框");
  if (!remarkInput) throw new Error("瑞云签收弹窗中未找到备注输入框");
  await snInput.fill(sn);
  await remarkInput.fill(remark);
}

async function confirmSign(page, sn, productType, remark, options = {}) {
  const serialNumber = normalizeText(sn);
  if (!serialNumber) throw new Error("签收前必须填写 SN");

  const receiptRemark =
    normalizeText(remark) || normalizeText(productType) || "寄修机器签收";
  const target = await findMappedReceiptControl(page, {
    ...options,
    logisticsNo: options.logisticsNo,
    productLine: options.productLine || productType,
    rowIndex: options.rowIndex || 1,
  });
  const baselineUrl = page.url();
  const baselineScopes = await snapshotReceiptFormScopes(page);
  await safelyClickReceiptEntry(target.entry, page, options);
  const opened = await waitForReceiptForm(page, baselineUrl, {
    ...options,
    baselineScopes,
  });
  if (!opened) {
    throw receiptInspectionError(
      "RECLOUD_RECEIPT_FORM_NOT_OPENED",
      "点击目标物流单的签收入口后未检测到签收表单",
      ["receiptForm.dialog"]
    );
  }
  const dialog = opened.root;
  await fillReceiptFields(dialog, serialNumber, receiptRemark);

  if (options.dryRun !== false) {
    return {
      success: true,
      dryRun: true,
      confirmed: false,
      sn: serialNumber,
      remark: receiptRemark,
      message: "DRY_RUN：SN 和备注已填写，未点击确认签收",
    };
  }

  const confirmButton = dialog
    .getByRole("button", { name: /^(确认|确定)$/ })
    .or(dialog.getByText(/^(确认|确定)$/, { exact: true }))
    .last();
  await confirmButton.waitFor({ state: "visible" });
  await confirmButton.click();

  await Promise.race([
    dialog.waitFor({ state: "hidden" }),
    page.getByText(/签收成功/).waitFor({ state: "visible" }),
  ]);

  return {
    success: true,
    dryRun: false,
    confirmed: true,
    sn: serialNumber,
    remark: receiptRemark,
    message: "签收完成",
  };
}

async function correctRmaProjectModel(page, input = {}, options = {}) {
  const values = validateProjectCorrectionInput(input);
  if (values.currentProjectCode.toUpperCase() === values.expectedProjectCode.toUpperCase()) {
    return { success: true, changed: false, reason: "PROJECT_ALREADY_MATCHED", ...values };
  }

  const productRow = page.locator("tr:visible").filter({ hasText: values.sn }).first();
  await productRow.waitFor({ state: "visible" });
  const projectCell = productRow.getByText(values.currentProjectCode, { exact: true }).first();
  await projectCell.waitFor({ state: "visible" });
  await projectCell.dblclick();

  const editDialog = page.locator('.rt-dialog__wrapper:visible, [role="dialog"]:visible').last();
  await editDialog.waitFor({ state: "visible" });
  const productNameItem = editDialog
    .locator('.rt-form-item, .el-form-item, [class*="form-item"]')
    .filter({ hasText: /产品名称/ })
    .first();
  await productNameItem.waitFor({ state: "visible" });
  const searchButton = productNameItem
    .locator('button:visible, [role="button"]:visible, .rt-input__suffix:visible, .el-input__suffix:visible')
    .last();
  await searchButton.click();

  const lookupDialog = page.locator('.rt-dialog__wrapper:visible, [role="dialog"]:visible').last();
  await lookupDialog.waitFor({ state: "visible" });
  const searchInput = await firstVisible([
    lookupDialog.getByPlaceholder(/产品型号.*产品名称.*配件编码/),
    lookupDialog.locator('input[type="text"]:visible').last(),
  ]);
  if (!searchInput) throw new Error("产品查找弹窗中未找到搜索框");
  await searchInput.fill(values.productModelCode);
  await searchInput.press("Enter");

  const exactRows = lookupDialog.locator("tr:visible").filter({ hasText: values.productModelCode });
  const resultCount = await exactRows.count();
  if (resultCount !== 1) {
    throw new Error(`产品型号编码 ${values.productModelCode} 搜索结果不是唯一项`);
  }
  const resultRow = exactRows.first();
  const checkbox = resultRow.locator('input[type="checkbox"], [role="checkbox"]').first();
  await checkbox.click();
  const lookupConfirm = lookupDialog
    .getByRole("button", { name: /^(确认|确定)$/ })
    .or(lookupDialog.getByText(/^(确认|确定)$/, { exact: true }))
    .last();
  await lookupConfirm.click();
  await lookupDialog.waitFor({ state: "hidden" });

  if (options.dryRun !== false) {
    return {
      success: true,
      changed: false,
      dryRun: true,
      selected: true,
      ...values,
      message: "DRY_RUN：已选择正确产品型号，未保存项目号修改",
    };
  }

  const saveButton = editDialog
    .getByRole("button", { name: /^保存$/ })
    .or(editDialog.getByText(/^保存$/, { exact: true }))
    .last();
  await saveButton.click();
  await editDialog.waitFor({ state: "hidden" });
  await productRow.getByText(values.expectedProjectCode, { exact: true }).first().waitFor({ state: "visible" });
  return { success: true, changed: true, dryRun: false, ...values, message: "项目号修改完成" };
}

module.exports = {
  RECLOUD_URL,
  RECLOUD_PENDING_LIST_URL,
  LOGIN_STATE,
  LOGIN_REQUIRED_MESSAGE,
  LOGISTICS_INPUT_PLACEHOLDER,
  openRecloud,
  closeRecloud,
  isRecloudLoginPage,
  assertRecloudAuthenticated,
  getLogisticsInput,
  collectRtxpcFormItemPairs,
  findFeedbackPhoneRevealButton,
  getFeedbackPhoneSearchScope,
  getRmaDetailSignals,
  isRmaDetailReady,
  isScanQueryUrl,
  getSelectAllShortcut,
  isCompleteMobilePhone,
  parseRmaDateTime,
  extractCompleteMobilePhone,
  collectStringValues,
  createPhoneResponseListener,
  findCurrentFeedbackPhoneItem,
  findRevealedPhone,
  selectMatchingPhone,
  isRevealPhoneEnabled,
  logPhoneReveal,
  ensureScanPage,
  logRecloudStage,
  waitForVisibleText,
  enterRmaQuery,
  waitForRmaDetail,
  readRmaDetail,
  readProductLine,
  selectCellByHeaderCoordinate,
  revealFeedbackPhone,
  queryRmaByLogisticsNo,
  queryRmaByPhone,
  queryRmaByIdentifier,
  selectAllRmaListView,
  enterAllRmaPhoneQuery,
  readPendingReceiptOrders,
  readRecentRmaOrders,
  toQueryError,
  scanSign,
  getRepairDetail,
  findPendingReceiptAction,
  findMappedReceiptControl,
  activateReceiptDetailTabs,
  prepareRmaDetailRegion,
  selectReceiptCandidate,
  findTargetReceiptRow,
  findCorrespondingOperationRows,
  diagnoseReceiptOperation,
  diagnoseReceiptByCoordinates,
  collectOperationCellDiagnostics,
  collectReceiptTableContainers,
  diagnoseReceiptTableStructure,
  diagnoseFixedReceiptOperation,
  summarizeReceiptHoverSnapshots,
  diagnoseReceiptControlAfterHover,
  classifyReceiptRowHoverDiagnostics,
  diagnoseReceiptControlAfterRowHover,
  classifyReceiptLayoutDiagnostics,
  diagnoseReceiptControlLayout,
  classifyReceiptVueState,
  diagnoseReceiptVueState,
  classifyReceiptOperationSource,
  diagnoseReceiptOperationSource,
  classifyReceiptRendererConfig,
  diagnoseReceiptRendererConfig,
  inspectReceiptForm,
  collectDetectionFieldControls,
  inspectDetectionForm,
  inspectRepairForm,
  logReceiptInspection,
  simulateReceiptForm,
  logReceiptSimulation,
  sanitizeRecloudRequestPath,
  createReceiptActionResponseObserver,
  classifyRecloudRequest,
  createReceiptNetworkGuard,
  confirmSign,
  validateProjectCorrectionInput,
  correctRmaProjectModel,
  fillReceiptFields,
  parseRepairDetail,
  readPendingRmaSupervisionOrders,
  readRmaSupervisionOrderStatuses,
  readSupervisionOrders,
};
