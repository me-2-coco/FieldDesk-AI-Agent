const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");
const {
  RecloudQueryError,
  extractTextFieldPairs,
  parseRmaFieldPairs,
} = require("./recloud-rma-parser");

const LOGIN_STATE = path.join(__dirname, "recloud-state.json");
const RECLOUD_URL =
  "https://crm2.recloud.com.cn/t/dreame/webapp/dreame/?mainNavName=serviceprovider#/scanSignin/query";
const DEFAULT_TIMEOUT = Number(process.env.RECLOUD_TIMEOUT_MS) || 15000;
const LOGIN_REQUIRED_MESSAGE = "请重新初始化瑞云登录状态";
const LOGISTICS_INPUT_PLACEHOLDER =
  "请用扫码枪输入物流单号/工单号/订单号/退换单";

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
  const browser = await chromium.launch({
    headless:
      options.headless ??
      !["0", "false"].includes(String(process.env.RECLOUD_HEADLESS).toLowerCase()),
  });

  const context = await browser.newContext({
    storageState:
      options.useStorageState !== false && fs.existsSync(LOGIN_STATE)
        ? LOGIN_STATE
        : undefined,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(DEFAULT_TIMEOUT);
  await page.goto(RECLOUD_URL, { waitUntil: "domcontentloaded" });

  return { browser, context, page };
}

async function saveLogin(context) {
  await context.storageState({ path: LOGIN_STATE });
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
  return page.locator(`input[placeholder="${LOGISTICS_INPUT_PLACEHOLDER}"]`).first();
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

async function enterRmaQuery(page, logisticsNo) {
  const value = normalizeText(logisticsNo);
  if (!value) throw new Error("缺少物流单号");

  assertRecloudAuthenticated(page);
  const input = getLogisticsInput(page);
  try {
    await input.waitFor({ state: "visible" });
  } catch (error) {
    assertRecloudAuthenticated(page);
    throw new RecloudQueryError(
      "RECLOUD_SCHEMA_CHANGED",
      "瑞云扫码签收页输入框结构已变化",
      { status: 502, retryable: false }
    );
  }
  await input.fill(value);
  await input.press("Enter");
}

async function readRmaDetail(page, logisticsNo = "") {
  assertRecloudAuthenticated(page);
  const bodyText = await page.locator("body").innerText();
  const pairs = extractTextFieldPairs(bodyText);
  return parseRmaFieldPairs(pairs, logisticsNo);
}

async function waitForRmaDetail(page, logisticsNo = "") {
  const queryInput = getLogisticsInput(page);
  const deadline = Date.now() + DEFAULT_TIMEOUT;
  let detailPageObserved = false;
  let schemaError = null;

  while (Date.now() < deadline) {
    assertRecloudAuthenticated(page);

    const inputVisible = await queryInput.isVisible().catch(() => false);
    if (!inputVisible) {
      detailPageObserved = true;
      try {
        return await readRmaDetail(page, logisticsNo);
      } catch (error) {
        if (error.code !== "RECLOUD_SCHEMA_CHANGED") throw error;
        schemaError = error;
        await page.waitForTimeout(200);
        continue;
      }
    }

    const bodyText = await page.locator("body").innerText().catch(() => "");
    if (/未找到|查询不到|暂无(?:相关)?(?:工单|数据)|工单不存在/.test(bodyText)) {
      throw new RecloudQueryError(
        "RECLOUD_ORDER_NOT_FOUND",
        "没有查询到对应的瑞云 RMA 寄修单",
        { status: 404, retryable: false }
      );
    }

    await page.waitForTimeout(200);
  }

  if (detailPageObserved && schemaError) throw schemaError;

  throw new RecloudQueryError("RECLOUD_QUERY_TIMEOUT", "瑞云工单查询超时", {
    status: 504,
    retryable: true,
  });
}

async function queryRmaByLogisticsNo(page, logisticsNo) {
  try {
    await enterRmaQuery(page, logisticsNo);
    return await waitForRmaDetail(page, logisticsNo);
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
  saveLogin,
  isRecloudLoginPage,
  assertRecloudAuthenticated,
  getLogisticsInput,
  enterRmaQuery,
  waitForRmaDetail,
  readRmaDetail,
  queryRmaByLogisticsNo,
  toQueryError,
  scanSign,
  getRepairDetail,
  confirmSign,
  fillReceiptFields,
  parseRepairDetail,
};
