const MAPPING_VERSION = "v6";
const { resolveWarrantyConversion } = require("../services/warranty-conversion-policy");

const NODE_REQUIRED_FIELDS = Object.freeze({
  RECEIPT: ["sn", "remark", "attachments"],
  INSPECTION_COMPLETED: ["inspectionResult"],
  REPAIR_COMPLETED: ["faultLevel1", "faultLevel2", "faultLevel3", "responsibilityType", "detectionResult", "repairMeasure", "attachments"],
  RETURN_SHIPPED: ["logisticsCompany", "trackingNo", "shippedAt"],
  ORDER_COMPLETED: ["completedAt"],
});

const RECLOUD_RECEIPT_FIELD_TARGETS = Object.freeze({
  attachments: { target: "寄修单附件", section: "问题涉及的场景照片、视频、APP截图、地图截屏、录屏", status: "CONFIRMED" },
});

const RECLOUD_REPAIR_FIELD_TARGETS = Object.freeze({
  faultClassification: { target: "故障模式及责任判定/故障一级、二级、三级分类", status: "CONFIRMED" },
  detectionResult: { target: "检测结果", status: "CONFIRMED" },
  responsibilityType: { target: "保内保外", status: "CONFIRMED" },
  repairMeasure: { target: "故障模式及责任判定/维修措施", status: "CONFIRMED" },
  usedParts: { target: "服务单更换件明细", status: "CONFIRMED" },
  highestRepairLevel: { target: "维修等级", status: "CONFIRMED" },
  partsRetailAmount: { target: "配件销售金额", status: "SYSTEM_CALCULATED" },
  repairFeeReceivable: { target: "应收服务费金额", status: "SYSTEM_CALCULATED" },
  serviceFeeCost: { target: "服务费实收（成本）", status: "SYSTEM_CALCULATED" },
  partsCostAmount: { target: "配件费用合计", status: "SYSTEM_CALCULATED" },
  customerPaidAmount: { target: "客户实际支付金额", status: "CONFIRMED" },
  logisticsAmount: { target: "快递金额", status: "CONFIRMED" },
  personalizedLogisticsAmount: { target: "快递金额（个性化）", status: "EXCLUDED" },
  attachments: { target: "附件", status: "CONFIRMED" },
  detectionReportAttachments: { target: "附件（检测报告）", status: "EXCLUDED" },
  warrantyConversion: { target: "保外转保内", status: "CONFIRMED" },
});

function compactParts(parts) {
  return (Array.isArray(parts) ? parts : []).map((part) => ({
    partCode: String(part.partCode || part.code || "").trim(),
    partName: String(part.partName || part.name || "").trim(),
    quantity: Number(part.quantity || 0),
    repairLevel: String(part.repairLevel || "").trim(),
    retailPrice: Number(part.retailPrice || 0),
    returnRequired: Boolean(part.returnRequired),
  })).filter((part) => part.partCode && part.quantity > 0);
}

function compactPricing(pricing) {
  if (!pricing || typeof pricing !== "object") return null;
  return {
    warrantyStatus: String(pricing.status || "").trim(),
    highestRepairLevel: String(pricing.highestLevel || "").trim(),
    partsFee: Number(pricing.partsFee || 0),
    repairFee: Number(pricing.fee || 0),
    oneWayLogisticsFee: Number(pricing.oneWayLogisticsFee || 0),
    roundTripLogisticsFee: Number(pricing.logisticsFee || 0),
    totalFee: Number(pricing.totalFee || 0),
  };
}

function normalizeWarrantyForRecloud(value) {
  const text = String(value || "").trim();
  if (text === "保外维修" || text === "保外") return "保外";
  if (text === "保内质保" || text === "保内") return "保内";
  return text;
}

function buildRecloudRepairFormPlan(payload = {}) {
  const pricing = payload.pricing || {};
  const parts = compactParts(payload.usedParts);
  const isOutOfWarranty = pricing.warrantyStatus === "OUT_OF_WARRANTY";
  const warrantyConversion = resolveWarrantyConversion({
    warrantyStatus: normalizeWarrantyForRecloud(payload.responsibilityType),
    manufacturerApproved: payload.manufacturerWarrantyConversion?.approved,
    manufacturerApprovalNo: payload.manufacturerWarrantyConversion?.approvalNo,
  });
  const safeWrites = [
    {
      key: "faultClassification",
      target: RECLOUD_REPAIR_FIELD_TARGETS.faultClassification.target,
      value: [payload.faultLevel1, payload.faultLevel2, payload.faultLevel3]
        .map((item) => String(item || "").trim())
        .filter(Boolean)
        .join(" / "),
    },
    { key: "detectionResult", target: RECLOUD_REPAIR_FIELD_TARGETS.detectionResult.target, value: String(payload.detectionResult || "").trim() },
    { key: "responsibilityType", target: RECLOUD_REPAIR_FIELD_TARGETS.responsibilityType.target, value: normalizeWarrantyForRecloud(payload.responsibilityType) },
    { key: "repairMeasure", target: RECLOUD_REPAIR_FIELD_TARGETS.repairMeasure.target, value: String(payload.repairMeasure || "").trim() },
    { key: "usedParts", target: RECLOUD_REPAIR_FIELD_TARGETS.usedParts.target, value: parts },
    { key: "highestRepairLevel", target: RECLOUD_REPAIR_FIELD_TARGETS.highestRepairLevel.target, value: String(pricing.highestRepairLevel || "").trim() },
    { key: "customerPaidAmount", target: RECLOUD_REPAIR_FIELD_TARGETS.customerPaidAmount.target, value: isOutOfWarranty ? Number(pricing.totalFee || 0) : null },
    { key: "logisticsAmount", target: RECLOUD_REPAIR_FIELD_TARGETS.logisticsAmount.target, value: isOutOfWarranty ? Number(pricing.roundTripLogisticsFee || 0) : null },
    { key: "attachments", target: RECLOUD_REPAIR_FIELD_TARGETS.attachments.target, value: Array.isArray(payload.attachments) ? payload.attachments : [] },
    { key: "warrantyConversion", target: RECLOUD_REPAIR_FIELD_TARGETS.warrantyConversion.target, value: warrantyConversion.value },
  ].filter((field) => field.value !== "" && field.value !== null && field.value !== undefined && (!Array.isArray(field.value) || field.value.length));

  const manualReviewFields = Object.entries(RECLOUD_REPAIR_FIELD_TARGETS)
    .filter(([, config]) => config.status === "FORM_CONFIRMATION_REQUIRED")
    .map(([key, config]) => ({ key, target: config.target }));

  return {
    safeWrites,
    manualReviewFields,
    warrantyConversion,
    canAutoConfirm: false,
    reason: "保外仅填写客户实际支付金额和快递金额；配件及其他费用由瑞云自动计算",
  };
}

function buildNodePayload(order, nodeType) {
  const completion = order.repairCompletion || {};
  const shipment = order.returnShipment || {};
  const payloads = {
    RECEIPT: {
      sn: order.sn,
      remark: order.remark,
      specialty: order.specialty,
      productLine: order.productLine,
      receiptCompletedAt: order.receiptCompletedAt,
      attachments: order.receiptAttachments || [],
      attachmentTarget: "RMA_ATTACHMENT",
    },
    INSPECTION_COMPLETED: {
      inspectionResult: order.inspectionResult,
      inspectionRemark: order.inspectionRemark,
      inspectionCompletedAt: order.inspectionUpdatedAt,
    },
    REPAIR_COMPLETED: {
      faultLevel1: completion.faultLevel1,
      faultLevel2: completion.faultLevel2,
      faultLevel3: completion.faultLevel3,
      responsibilityType: completion.responsibilityType,
      manufacturerWarrantyConversion: order.manufacturerWarrantyConversion || { approved: false, approvalNo: "" },
      detectionResult: completion.detectionResult,
      repairMeasure: completion.repairMeasure,
      attachments: completion.attachments || [],
      attachmentTarget: "REPAIR_ORDER_ATTACHMENT",
      usedParts: compactParts(completion.usedParts),
      pricing: compactPricing(completion.pricing),
      attachmentCount: Array.isArray(completion.attachments) ? completion.attachments.length : 0,
      completedAt: completion.submittedAt,
    },
    RETURN_SHIPPED: {
      logisticsCompany: shipment.logisticsCompany,
      trackingNo: shipment.trackingNo,
      shippedAt: shipment.shippedAt,
      proofCount: Array.isArray(shipment.attachments) ? shipment.attachments.length : 0,
    },
    ORDER_COMPLETED: {
      completedAt: order.completedAt,
    },
  };
  return Object.fromEntries(
    Object.entries(payloads[nodeType] || {}).filter(([, value]) => value !== undefined && value !== null)
  );
}

function validateNodePayload(nodeType, payload = {}) {
  const required = NODE_REQUIRED_FIELDS[nodeType];
  if (!required) {
    throw Object.assign(new Error("不支持的瑞云同步节点"), {
      code: "SYNC_NODE_UNSUPPORTED", permanent: true,
    });
  }
  const missingFields = required.filter((field) => {
    const value = payload[field];
    return value === undefined || value === null || String(value).trim() === "";
  });
  if (missingFields.length) {
    throw Object.assign(new Error("同步字段不完整"), {
      code: "RECLOUD_SYNC_VALIDATION_FAILED", permanent: true, missingFields,
    });
  }
  return payload;
}

module.exports = {
  MAPPING_VERSION,
  NODE_REQUIRED_FIELDS,
  RECLOUD_RECEIPT_FIELD_TARGETS,
  RECLOUD_REPAIR_FIELD_TARGETS,
  buildRecloudRepairFormPlan,
  buildNodePayload,
  validateNodePayload,
};
