const { chromium } = require("playwright");
const { parseSnProductionMonth } = require("./warranty-policy");

const FREIGHT_WAIVER_APPLICATION_SOURCE = "FREIGHT_WAIVER_APPLICATION";
const FREIGHT_WAIVER_TEMPLATE_VERSION = "2026-09-07-filled-sample-v2";

// 这份槽位表对应《保外付费折扣申请单》的一页 13 行表格。
// 用户提供填写样例后，只需修订字段来源/文字规则，不改截图和附件上传链路。
const FREIGHT_WAIVER_TEMPLATE_SLOTS = Object.freeze([
  { row: 0, key: "customerName", label: "客户姓名", source: "order.customerName" },
  { row: 0, key: "customerPhone", label: "客户电话", source: "瑞云查询缓存中的完整联系电话" },
  { row: 1, key: "rmaNo", label: "寄修单号", source: "order.rmaNo" },
  { row: 1, key: "sn", label: "产品SN", source: "order.sn" },
  { row: 2, key: "outOfWarrantyReason", label: "保外收费原因", source: "SN生产年月、购买凭证、报修日期" },
  { row: 3, key: "partsFee", label: "配件费用", source: "pricing.partsFee" },
  { row: 4, key: "serviceFee", label: "服务费用", source: "pricing.fee" },
  { row: 5, key: "expressFee", label: "快递费用", source: "pricing.quotedLogisticsFee" },
  { row: 6, key: "quotedTotalFee", label: "费用合计", source: "pricing.quotedTotalFee" },
  { row: 7, key: "applicationReason", label: "申请折扣原因", source: "弃修免运费固定业务原因" },
  { row: 8, key: "waiverType", label: "申请折扣减免", source: "固定为免运费" },
  { row: 8, key: "actualPaid", label: "实收保外费用", source: "固定为0" },
  { row: 9, key: "applicant", label: "申请人", source: "当前维修师傅" },
  { row: 9, key: "applicationDate", label: "申请时间", source: "提交日期" },
  { row: 10, key: "approvalHeaders", label: "审批人及审批意见", source: "模板保留" },
  { row: 12, key: "approvalRule", label: "保外折扣权限审批规则", source: "模板保留" },
]);

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function amount(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? String(Number(number.toFixed(2))) : "0";
}

function dateParts(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const valid = Number.isNaN(date.getTime()) ? new Date() : date;
  return {
    year: valid.getFullYear(),
    month: valid.getMonth() + 1,
    day: valid.getDate(),
  };
}

function formatDate(value) {
  const { year, month, day } = dateParts(value);
  return `${year}年${month}月${day}日`;
}

function formatApplicationDate(value) {
  const { year, month, day } = dateParts(value);
  return `${year}-${month}-${day}`;
}

function formatMonth(year, month) {
  return year && month ? `${year}年${month}月` : "未能从SN识别";
}

function buildOutOfWarrantyReason(order = {}, now = new Date()) {
  const production = parseSnProductionMonth(order.sn);
  const productionMonth = production.status === "PARSED"
    ? formatMonth(production.year, production.month)
    : "未能从SN识别";
  const purchase = order.purchaseDate ? dateParts(order.purchaseDate) : {};
  const purchaseMonth = purchase.year && purchase.month
    ? `${purchase.year}年${purchase.month}月`
    : "年月";
  const reportedDate = order.reportedAt || order.createdAt || now;
  return `此单机器在追觅旗舰店于${purchaseMonth}购买，根据 SN 确认生产时间是${productionMonth}，机器于${formatDate(reportedDate)}报修，检测机器整机过保，按照《MS-IN-046_中国区售后服务政策管理规范V1.0》该情况属于保外，需客户付费维修。`;
}

function buildFreightWaiverApplicationData({ order = {}, pricing = {}, applicant = {}, now = new Date() } = {}) {
  return {
    templateVersion: FREIGHT_WAIVER_TEMPLATE_VERSION,
    customerName: String(order.customerName || "").trim() || "--",
    customerPhone: String(order.phone || order.phoneMasked || "").trim() || "--",
    rmaNo: String(order.rmaNo || "").trim() || "--",
    sn: String(order.sn || "").trim() || "--",
    outOfWarrantyReason: buildOutOfWarrantyReason(order, now),
    partsFee: amount(pricing.partsFee),
    serviceFee: amount(pricing.fee),
    expressFee: amount(pricing.quotedLogisticsFee ?? pricing.oneWayLogisticsFee),
    quotedTotalFee: amount(pricing.quotedTotalFee),
    applicationReason: "检测机器检测机器整机过保，用户嫌贵且有投诉倾向，此单为避免舆情，提高用户体验度特为用户免运费寄回",
    waiverType: "免运费",
    actualPaid: "0",
    applicant: String(applicant.displayName || order.technicianName || order.operatorName || "").trim() || "--",
    applicationDate: formatApplicationDate(now),
    approvalHeaders: ["组长/二线", "主管/经理", "总监"],
    approvalRule: "保外折扣权限审批规则：\n详见《客服特殊权益审批管理规范》",
  };
}

function renderFreightWaiverApplicationHtml(data) {
  const cell = (value) => escapeHtml(value);
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><style>
*{box-sizing:border-box}html,body{margin:0;background:#fff;color:#111;font-family:"Microsoft YaHei","PingFang SC","Noto Sans CJK SC",sans-serif}
body{padding:0}.capture{position:relative;width:1120px;height:1584px;padding:28px 62px 42px;background:#fff}.header{display:flex;align-items:flex-end;justify-content:space-between;margin:0 10px 10px}.brand{font-size:38px;font-weight:900;letter-spacing:7px;line-height:1}.brand i{display:inline-block;width:9px;height:27px;margin:0 -16px 0 -23px;background:#e8ba00;transform:skew(-18deg);vertical-align:-2px}.brand span{font-size:29px;letter-spacing:1px;margin-left:10px}.company{font-size:20px;color:#666;letter-spacing:2px}.brand-line{height:1px;background:#555;margin:0 38px 44px}.title{text-align:center;font-size:34px;font-weight:800;margin:0 0 34px;letter-spacing:3px}
table{width:100%;border-collapse:collapse;table-layout:fixed;border:2px solid #111;font-size:18px}col.label{width:190px}col.value{width:308px}th,td{border:1px solid #111;padding:11px 10px;vertical-align:middle;line-height:1.55;overflow-wrap:anywhere}th{font-weight:700;text-align:center;background:#fff}.short{height:76px}.reason{height:150px}.fee{height:67px}.application-reason{height:138px}.approval-head{height:70px}.approval-space{height:78px}.rule{height:108px}.money{font-variant-numeric:tabular-nums}.approval{text-align:center;font-weight:700}.muted{color:#111;font-size:16px;white-space:pre-line;font-weight:600}.page-number{position:absolute;bottom:19px;left:0;right:0;text-align:center;color:#777;font-size:15px}.crop{position:absolute;width:34px;height:34px}.crop.tl{left:35px;top:67px;border-left:1px solid #999;border-top:1px solid #999}.crop.tr{right:35px;top:67px;border-right:1px solid #999;border-top:1px solid #999}.crop.bl{left:35px;bottom:35px;border-left:1px solid #999;border-bottom:1px solid #999}.crop.br{right:35px;bottom:35px;border-right:1px solid #999;border-bottom:1px solid #999}
</style></head><body><main class="capture" id="freight-waiver-application">
<i class="crop tl"></i><i class="crop tr"></i><i class="crop bl"></i><i class="crop br"></i>
<div class="header"><div class="brand">DRE<i></i>ME <span>追觅</span></div><div class="company">追觅创新科技（苏州）有限公司</div></div><div class="brand-line"></div><h1 class="title">保外付费折扣申请单</h1>
<table><colgroup><col class="label"><col class="value"><col class="label"><col class="value"></colgroup><tbody>
<tr class="short"><th>客户姓名</th><td>${cell(data.customerName)}</td><th>客户电话</th><td>${cell(data.customerPhone)}</td></tr>
<tr class="short"><th>寄修单号</th><td>${cell(data.rmaNo)}</td><th>产品SN</th><td>${cell(data.sn)}</td></tr>
<tr class="reason"><th>保外收费原因</th><td colspan="3">${cell(data.outOfWarrantyReason)}</td></tr>
<tr class="fee"><th rowspan="4">保外费用明细</th><th>配件费用</th><td colspan="2" class="money">${cell(data.partsFee)}</td></tr>
<tr class="fee"><th>服务费用</th><td colspan="2" class="money">${cell(data.serviceFee)}</td></tr>
<tr class="fee"><th>快递费用</th><td colspan="2" class="money">${cell(data.expressFee)}</td></tr>
<tr class="fee"><th>费用合计</th><td colspan="2" class="money">${cell(data.quotedTotalFee)}</td></tr>
<tr class="application-reason"><th>申请折扣原因</th><td colspan="3">${cell(data.applicationReason)}</td></tr>
<tr class="short"><th>申请折扣减免</th><td class="money">${cell(data.waiverType)}</td><th>实收保外费用</th><td class="money">${cell(data.actualPaid)}</td></tr>
<tr class="short"><th>申请人</th><td>${cell(data.applicant)}</td><th>申请时间</th><td>${cell(data.applicationDate)}</td></tr>
<tr class="approval-head"><th rowspan="2">审批人及审批意见</th><td class="approval">${cell(data.approvalHeaders[0])}</td><td class="approval">${cell(data.approvalHeaders[1])}</td><td class="approval">${cell(data.approvalHeaders[2])}</td></tr>
<tr class="approval-space"><td></td><td></td><td></td></tr>
<tr class="rule"><td colspan="4" class="muted">${cell(data.approvalRule)}</td></tr>
</tbody></table><div class="page-number">第 1 页</div></main></body></html>`;
}

let rendererBrowserPromise = null;

async function rendererBrowser() {
  if (!rendererBrowserPromise) {
    rendererBrowserPromise = chromium.launch({ headless: true }).catch((error) => {
      rendererBrowserPromise = null;
      throw error;
    });
  }
  return rendererBrowserPromise;
}

async function renderFreightWaiverApplicationPng(data) {
  const browser = await rendererBrowser();
  const page = await browser.newPage({ viewport: { width: 1200, height: 1700 }, deviceScaleFactor: 1.5 });
  try {
    await page.setContent(renderFreightWaiverApplicationHtml(data), { waitUntil: "load" });
    return await page.locator("#freight-waiver-application").screenshot({ type: "png" });
  } finally {
    await page.close();
  }
}

async function closeFreightWaiverApplicationRenderer() {
  const promise = rendererBrowserPromise;
  rendererBrowserPromise = null;
  if (promise) await (await promise).close();
}

module.exports = {
  FREIGHT_WAIVER_APPLICATION_SOURCE,
  FREIGHT_WAIVER_TEMPLATE_SLOTS,
  FREIGHT_WAIVER_TEMPLATE_VERSION,
  buildFreightWaiverApplicationData,
  buildOutOfWarrantyReason,
  closeFreightWaiverApplicationRenderer,
  renderFreightWaiverApplicationHtml,
  renderFreightWaiverApplicationPng,
};
