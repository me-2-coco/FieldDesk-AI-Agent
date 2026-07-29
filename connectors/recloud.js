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

const LOGIN_STATE = path.join(__dirname, "recloud-state.json");
const RECLOUD_URL =
  "https://crm2.recloud.com.cn/t/dreame/webapp/dreame/?mainNavName=serviceprovider#/scanSignin/query";
const DEFAULT_TIMEOUT = Number(process.env.RECLOUD_TIMEOUT_MS) || 30000;
const SCAN_PAGE_PROBE_TIMEOUT = 1200;
const QUERY_RETRY_DELAY = 3000;
const SCANNER_KEY_DELAY = 30;
const ENTER_SETTLE_DELAY = 300;
const PHONE_REVEAL_TIMEOUT = 5000;
const LOGIN_REQUIRED_MESSAGE = "请重新初始化瑞云登录状态";
const LOGISTICS_INPUT_PLACEHOLDER =
  "请用扫码枪输入物流单号/工单号/订单号/退换单";
const sessionManager = createRecloudSessionManager({
  defaultTimeout: DEFAULT_TIMEOUT,
  isLoginPage: isRecloudLoginPage,
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
  const scope = await getFeedbackPhoneSearchScope(item);
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
  const match = String(value || "").match(/(\d{3})\D*(\d{4})\s*$/);
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

function createPhoneResponseListener(page, maskedValue) {
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
      phone = selectMatchingPhone(
        collectStringValues(payload),
        maskedValue
      );
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
    values.push(...await readControlValues(
      currentItem.locator("input, textarea")
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
    const network = createPhoneResponseListener(page, originalValue);
    try {
      await button.click();
      logPhoneReveal("clicked", logger);

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
  if (!(await input.isVisible().catch(() => false))) {
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

async function readProductLine(page, logger = console) {
  const fail = (reason) => {
    logger.warn?.(`RECLOUD_PRODUCT_LINE: failed ${reason}`);
    return "";
  };
  if (typeof page.getByText !== "function") return "";

  try {
    const marker = page
      .getByText("RMA明细", { exact: true })
      .filter({ visible: true })
      .first();
    if (!(await marker.isVisible().catch(() => false))) {
      return fail("RMA_DETAIL_REGION_NOT_FOUND");
    }
    const region = marker
      .locator(
        "xpath=ancestor::*[.//*[normalize-space()='产品线'] and .//*[normalize-space()='签收']][1]"
      )
      .first();
    if (!(await region.isVisible().catch(() => false))) {
      return fail("RMA_DETAIL_REGION_NOT_FOUND");
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
        "xpath=ancestor::*[@role='row' or self::tr or contains(@class, 'row')][1]"
      )
      .first();
    if (!(await row.isVisible().catch(() => false))) {
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

async function readRmaDetail(page, logisticsNo = "") {
  assertRecloudAuthenticated(page);
  const bodyText = await page.locator("body").innerText();
  const revealPhoneEnabled = isRevealPhoneEnabled();
  const formItemPairs = await collectRtxpcFormItemPairs(page, {
    revealPhoneEnabled,
  });
  const productLine = await readProductLine(page);
  const textPairs = extractTextFieldPairs(bodyText);
  return parseRmaFieldPairs([...formItemPairs, ...textPairs], logisticsNo, {
    rmaNoFromTitle: extractRmaNoFromTitle(bodyText),
    allowFullPhone: revealPhoneEnabled,
    productLine,
  });
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
      return readRmaDetail(page, logisticsNo);
    }

    if (!enterRetried && Date.now() >= retryAt) {
      if (!scanInputHidden) {
        await page.keyboard.press("Enter");
        logRecloudStage("enter_retried", logger);
        enterRetried = true;
      }
    }

    if (/未找到|查询不到|暂无(?:相关)?(?:工单|数据)|工单不存在/.test(bodyText)) {
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
    return await waitForRmaDetail(page, logisticsNo, options);
  } catch (error) {
    throw toQueryError(error);
  }
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
    if ((await locator.count()) > 0 && (await locator.isVisible().catch(() => false))) {
      return locator;
    }
  }
  return null;
}

function logReceiptInspection(stage, logger = console) {
  logger.info(`RECLOUD_RECEIPT_INSPECTION: ${stage}`);
}

async function findPendingReceiptAction(page, logger = console) {
  const scopes =
    typeof page.frames === "function" ? [page, ...page.frames()] : [page];
  const candidates = [];
  for (const scope of scopes) {
    const marker = scope
      .getByText("RMA明细", { exact: true })
      .filter({ visible: true })
      .first();
    if (!(await marker.isVisible().catch(() => false))) continue;
    const region = marker
      .locator("xpath=ancestor::*[.//*[normalize-space()='签收']][1]")
      .first();
    if (!(await region.isVisible().catch(() => false))) continue;
    const actions = region
      .getByText("签收", { exact: true })
      .filter({ visible: true });
    const count = await actions.count().catch(() => 0);

    for (let index = 0; index < count; index += 1) {
      const text = actions.nth(index);
      const row = text
        .locator(
          "xpath=ancestor::*[self::tr or @role='row' or @data-row-key or contains(concat(' ', normalize-space(@class), ' '), ' el-table__row ') or contains(concat(' ', normalize-space(@class), ' '), ' table-row ') or contains(concat(' ', normalize-space(@class), ' '), ' grid-row ') or contains(concat(' ', normalize-space(@class), ' '), ' vxe-body--row ') or contains(concat(' ', normalize-space(@class), ' '), ' rtxpc-table__row ')][1]"
        )
        .first();
      if (!(await row.isVisible().catch(() => false))) continue;
      const entry = await firstVisible([
        row.getByRole("button", { name: "签收", exact: true }),
        row.getByRole("link", { name: "签收", exact: true }),
        row.locator("button:visible, a:visible, [role='button']:visible").filter({
          hasText: /^签收$/,
        }),
        row.getByText("签收", { exact: true }).filter({ visible: true }),
      ]);
      if (entry) candidates.push({ row, entry });
    }
  }
  if (candidates.length === 0) return null;
  if (candidates.length > 1) {
    logger.warn?.("RECLOUD_RECEIPT_INSPECTION: ambiguous_rows_using_first");
  }
  return candidates[0];
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
  const target = await findPendingReceiptAction(page, logger);
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
  return { entryState, formPage: opened.page, dialog: opened.root };
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
  return { snInput, remarkInput, confirmButton };
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
  try {
    const opened = await openReceiptFormForDryRun(page, options);
    formPage = opened.formPage;
    dialog = opened.dialog;
    const { entryState } = opened;
    const { snInput, remarkInput, confirmButton } =
      await locateReceiptFormControls(dialog);

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
        missingFields,
      };
      throw error;
    }

    logReceiptInspection("snInputFound", logger);
    logReceiptInspection("remarkInputFound", logger);
    logReceiptInspection("confirmButtonFound", logger);
    return {
      dryRun: true,
      receiptEntryFound: true,
      receiptEntryVisible: entryState.visible,
      receiptEntryEnabled: entryState.enabled,
      receiptEntryClicked: true,
      dialogOpened: true,
      snInputFound: true,
      remarkInputFound: true,
      confirmButtonFound: true,
      missingFields: [],
      fields: {
        sn: await describeReceiptControl(snInput, "sn"),
        remark: await describeReceiptControl(remarkInput, "remark"),
      },
      finalAction: await describeReceiptControl(
        confirmButton,
        "final_confirmation"
      ),
      confirmed: false,
      recloudModified: false,
      message: "已定位瑞云签收表单，未填写字段，未点击最终确认",
    };
  } finally {
    if (dialog) {
      await formPage.keyboard.press("Escape").catch(() => {});
      logReceiptInspection("dialog_closed_without_changes", logger);
    }
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

function classifyRecloudRequest(request) {
  const method = String(request.method?.() || "GET").toUpperCase();
  const resourceType = String(request.resourceType?.() || "").toLowerCase();
  const path = sanitizeRecloudRequestPath(request.url?.() || "");
  const descriptor = { method, path };
  if (["GET", "HEAD", "OPTIONS"].includes(method)) {
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
  if (readPath && !mutationPath) return { kind: "read", descriptor };
  if (
    mutationPath ||
    (["POST", "PUT", "PATCH", "DELETE"].includes(method) &&
      ["xhr", "fetch"].includes(resourceType))
  ) {
    return { kind: "mutation", descriptor };
  }
  return { kind: "read", descriptor };
}

async function createReceiptNetworkGuard(page, state) {
  const handler = async (route) => {
    const classification = classifyRecloudRequest(route.request());
    if (classification.kind === "mutation") {
      state.mutationRequestDetected = true;
      state.blockedRequestCount += 1;
      state.blockedRequests.push(classification.descriptor);
      await route.abort("blockedbyclient");
      return;
    }
    state.readRequestCount += 1;
    state.readRequests.push(classification.descriptor);
    await route.continue();
  };
  await page.route("**/*", handler);
  state.networkGuardEnabled = true;
  return {
    async assertSafe() {
      await page.waitForTimeout?.(50);
      if (!state.mutationRequestDetected) return;
      const error = new Error("演练期间检测并阻止了非预期写请求");
      error.code = "RECLOUD_UNEXPECTED_WRITE_REQUEST";
      error.status = 502;
      error.missingFields = [];
      throw error;
    },
    async stop() {
      await page.unroute("**/*", handler).catch(() => {});
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
  const signButton = page.getByText("签收", { exact: true }).last();
  await signButton.waitFor({ state: "visible" });
  await signButton.click();

  const dialog = page
    .locator('.rt-dialog__wrapper:visible, [role="dialog"]:visible')
    .last();
  await dialog.waitFor({ state: "visible" });
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

module.exports = {
  RECLOUD_URL,
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
  toQueryError,
  scanSign,
  getRepairDetail,
  findPendingReceiptAction,
  inspectReceiptForm,
  logReceiptInspection,
  simulateReceiptForm,
  logReceiptSimulation,
  sanitizeRecloudRequestPath,
  classifyRecloudRequest,
  createReceiptNetworkGuard,
  confirmSign,
  fillReceiptFields,
  parseRepairDetail,
};
