function normalize(value) {
  return String(value || "").replace(/\s+/g, "").trim();
}

function hasRecordedTime(value) {
  const text = normalize(value);
  return Boolean(text && !["-", "--", "无", "未签收"].includes(text));
}

const AFTER_RECEIPT_PATTERN = /(已签收|检测|检修|维修|待报价|报价|待发货|待寄回|已发货|待完工|已完工|完成|关闭|结单)/;
const WAITING_RECEIPT_PATTERN = /(待签收|未签收)/;

function classifyRecloudReceiptState(detail = {}) {
  const receiptSignedAt = normalize(detail.receiptSignedAt);
  const pickupStatus = normalize(detail.pickupStatus);
  const orderStatus = normalize(detail.orderStatus || detail.recloudStage);
  const receiptStatus = normalize(detail.receiptStatus);
  const combined = [receiptStatus, orderStatus, pickupStatus].filter(Boolean).join("|");

  if (hasRecordedTime(receiptSignedAt) || AFTER_RECEIPT_PATTERN.test(combined)) {
    return {
      code: "ALREADY_RECEIVED",
      receiptRequired: false,
      receiptSignedAt,
      label: orderStatus || receiptStatus || "瑞云已签收",
    };
  }
  if (WAITING_RECEIPT_PATTERN.test(combined) || (pickupStatus === "已取件" && !receiptSignedAt)) {
    return {
      code: "RECEIPT_REQUIRED",
      receiptRequired: true,
      receiptSignedAt: "",
      label: orderStatus || receiptStatus || "待签收",
    };
  }
  return {
    code: "UNKNOWN",
    receiptRequired: null,
    receiptSignedAt: "",
    label: orderStatus || receiptStatus || pickupStatus || "状态待确认",
  };
}

module.exports = { classifyRecloudReceiptState, hasRecordedTime };
