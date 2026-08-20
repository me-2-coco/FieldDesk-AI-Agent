const INTENT_RULES = Object.freeze([
  { type: "FEE_DISCOUNT", label: "折扣需求", pattern: /(折扣|优惠|[一二三四五六七八九]|\d+(?:\.\d+)?)\s*折/i },
  { type: "FREIGHT_ADJUSTMENT", label: "运费减免", pattern: /((运费|快递费).*(减免|免除|全免|单边)|(减免|免除|全免|单边).*(运费|快递费))/i },
  { type: "EXPEDITE_REPAIR", label: "催维修", pattern: /(催修|催维修|加急|尽快维修|维修进度|催促)/i },
  { type: "CONTACT_CUSTOMER", label: "联系用户", pattern: /(联系|回电|致电|沟通).{0,8}(用户|客户)|(用户|客户).{0,8}(联系|回电|致电|沟通)/i },
  { type: "WARRANTY_REVIEW", label: "保修政策核对", pattern: /(质保|保修|在保|过保|整机.{0,4}[两二三]年|电池.{0,4}[两二三]年)/i },
  { type: "RETURN_SHIPPING", label: "寄回及物流反馈", pattern: /(寄回|寄出|发回|快递单号|物流单号)/i },
]);

function extractDiscount(content) {
  const rate = content.match(/([一二三四五六七八九]|\d+(?:\.\d+)?)\s*折/i);
  const amount = content.match(/(?:减免|优惠)\s*(\d+(?:\.\d+)?)\s*元/i);
  const chineseRates = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  return {
    discountRate: rate ? (chineseRates[rate[1]] || Number(rate[1])) : null,
    discountAmount: amount ? Number(amount[1]) : null,
  };
}

function analyzeSupervisionOrder(content, context = {}) {
  const originalContent = String(content || "").trim();
  if (!originalContent) {
    const error = new Error("督办单内容不能为空");
    error.code = "SUPERVISION_CONTENT_REQUIRED";
    throw error;
  }
  const detectionText = [context.type, context.subtype, originalContent].filter(Boolean).join(" ");
  const intents = INTENT_RULES
    .filter((rule) => rule.pattern.test(detectionText))
    .map(({ type, label }) => ({ type, label }));
  if (!intents.length) intents.push({ type: "OTHER", label: "其他客服需求" });
  const hasFeeIntent = intents.some((item) => ["FEE_DISCOUNT", "FREIGHT_ADJUSTMENT"].includes(item.type));
  const extracted = extractDiscount(originalContent);
  const technicianActions = [];
  if (intents.some((item) => item.type === "EXPEDITE_REPAIR")) technicianActions.push("优先检查当前维修进度并反馈给信息员");
  if (intents.some((item) => item.type === "CONTACT_CUSTOMER")) technicianActions.push("按信息员安排联系用户并反馈联系结果");
  if (hasFeeIntent) technicianActions.push("不要自行承诺折扣或减免，等待信息员确认收费方案");
  if (intents.some((item) => item.type === "WARRANTY_REVIEW")) technicianActions.push("核对整机与配件保修范围，等待信息员确认保内外结论");
  if (intents.some((item) => item.type === "RETURN_SHIPPING")) technicianActions.push("按通知准备寄回，并把物流单号反馈给信息员");
  if (intents.some((item) => item.type === "OTHER")) technicianActions.push("联系信息员确认具体处理要求");
  return {
    originalContent,
    intents,
    ...extracted,
    feeAction: hasFeeIntent ? "MANUAL_CONFIRMATION_REQUIRED" : "NONE",
    applyFeeAutomatically: false,
    technicianActions,
    replyOwner: "INFORMATION_CLERK",
    technicianCanReply: false,
    systemCanReply: false,
    requiresManualReview: hasFeeIntent || intents.some((item) => item.type === "OTHER"),
  };
}

module.exports = { analyzeSupervisionOrder };
