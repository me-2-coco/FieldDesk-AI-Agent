const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

const LOGIN_STATE = path.join(__dirname, "recloud-state.json");
const RECLOUD_URL =
  "https://crm2.recloud.com.cn/t/dreame/webapp/dreame/?mainNavName=serviceprovider#/scanSignin/query";
const DEFAULT_TIMEOUT = Number(process.env.RECLOUD_TIMEOUT_MS) || 15000;

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
    storageState: fs.existsSync(LOGIN_STATE) ? LOGIN_STATE : undefined,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(DEFAULT_TIMEOUT);
  await page.goto(RECLOUD_URL, { waitUntil: "domcontentloaded" });

  return { browser, context, page };
}

async function saveLogin(context) {
  await context.storageState({ path: LOGIN_STATE });
}

async function scanSign(page, logisticsNo) {
  const value = normalizeText(logisticsNo);
  if (!value) throw new Error("缺少物流单号");

  const input = page
    .locator('input[placeholder*="物流"], input[placeholder*="快递"]')
    .first();
  await input.waitFor({ state: "visible" });
  await input.fill(value);
  await input.press("Enter");

  await Promise.race([
    page.getByText("签收", { exact: true }).last().waitFor({ state: "visible" }),
    page.waitForTimeout(8000),
  ]);
}

async function getRepairDetail(page, logisticsNo = "") {
  const text = await page.locator("body").innerText();
  const detail = parseRepairDetail(text, logisticsNo);

  if (!detail.rmaNo && !detail.sn) {
    throw new Error("没有查询到对应的瑞云寄修工单");
  }
  return detail;
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
  openRecloud,
  saveLogin,
  scanSign,
  getRepairDetail,
  confirmSign,
  fillReceiptFields,
  parseRepairDetail,
};
