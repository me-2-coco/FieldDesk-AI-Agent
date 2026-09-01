const MAPPING_VERSION = "v7";
const { resolveWarrantyConversion } = require("../services/warranty-conversion-policy");

const NODE_REQUIRED_FIELDS = Object.freeze({
  RECEIPT: ["sn", "remark", "attachments"],
  INSPECTION_COMPLETED: ["inspectionResult", "faultCategory", "warrantyStatus", "detectionResult"],
  REPAIR_COMPLETED: ["faultLevel1", "faultLevel2", "faultLevel3", "responsibilityType", "detectionResult", "repairMeasure", "attachments"],
  RETURN_SHIPPED: ["logisticsCompany", "trackingNo", "shippedAt"],
  ORDER_COMPLETED: ["completedAt"],
});

const RECLOUD_RECEIPT_FIELD_TARGETS = Object.freeze({
  projectCorrection: { target: "产品信息/RMA明细/产品名称", status: "CONFIRMED" },
  attachments: { target: "寄修单附件", section: "问题涉及的场景照片、视频、APP截图、地图截屏、录屏", status: "CONFIRMED" },
});

const RECLOUD_INSPECTION_FIELD_TARGETS = Object.freeze({
  faultCategory: { target: "故障分类（快速选择）", status: "CONFIRMED", control: "SEARCH_INPUT" },
  customerReasonConsistent: { target: "是否与客服登记原因一致", status: "FIXED_YES", control: "RADIO" },
  warrantyStatus: { target: "保修状态", status: "CONFIRMED", control: "SELECT" },
  detectionResult: { target: "检测结果", status: "CONFIRMED", control: "SELECT" },
  qualityDescription: { target: "品质描述", status: "EXCLUDED", control: "TEXT_INPUT" },
  inspectionAbnormal: { target: "检测无异常", status: "EXCLUDED", control: "SELECT" },
  productFunctionDecision: { target: "成品功能判断", status: "CONFIRMED", control: "SELECT" },
  originalConsumables: { target: "是否原厂耗材", status: "FIXED_YES", control: "RADIO" },
  consumableName: { target: "耗材名称", status: "EXCLUDED", control: "TEXT_INPUT" },
  dismantled: { target: "是否拆封", status: "FIXED_YES", control: "RADIO" },
  responsibilityDecision: { target: "责任判定", status: "EXCLUDED", control: "SELECT" },
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
  troubleshooting: { target: "是否是排障问题", status: "CONFIRMED" },
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

function buildRecloudInspectionFormPlan(payload = {}) {
  const fields = {
    faultCategory: String(payload.faultCategory || "").trim(),
    customerReasonConsistent: "是",
    warrantyStatus: normalizeWarrantyForRecloud(payload.warrantyStatus),
    detectionResult: String(payload.detectionResult || payload.inspectionResult || "").trim(),
    productFunctionDecision: String(payload.productFunctionDecision || "功能问题").trim(),
    originalConsumables: "是",
    dismantled: "是",
  };
  const missingFields = ["faultCategory", "warrantyStatus", "detectionResult"]
    .filter((key) => !fields[key]);
  return {
    safeWrites: Object.entries(fields).map(([key, value]) => ({
      key,
      target: RECLOUD_INSPECTION_FIELD_TARGETS[key].target,
      value,
    })),
    excludedFields: [
      {
        key: "qualityDescription",
        target: RECLOUD_INSPECTION_FIELD_TARGETS.qualityDescription.target,
        reason: "每单保持空白",
      },
      {
        key: "inspectionAbnormal",
        target: RECLOUD_INSPECTION_FIELD_TARGETS.inspectionAbnormal.target,
        reason: "当前瑞云检测弹窗无此控件，仅保留本地记录",
      },
      {
        key: "consumableName",
        target: RECLOUD_INSPECTION_FIELD_TARGETS.consumableName.target,
        reason: "选择原厂耗材后不填写耗材名称",
      },
      {
        key: "responsibilityDecision",
        target: RECLOUD_INSPECTION_FIELD_TARGETS.responsibilityDecision.target,
        reason: "每单保持空白",
      },
    ],
    missingFields,
    canAutoConfirm: false,
    reason: missingFields.length
      ? "检测字段不完整，停止并转人工"
      : "字段可预填；最终确认继续由安全开关和人工确认控制",
  };
}

function inspectionControlIsCompatible(control, expectedType) {
  if (!control) return false;
  if (expectedType === "RADIO") return Number(control.radioCount || 0) >= 2;
  if (expectedType === "SELECT") {
    return Number(control.comboboxCount || 0) >= 1 || Number(control.inputCount || 0) >= 1;
  }
  if (expectedType === "TEXT_INPUT") {
    return Number(control.inputCount || 0) >= 1 || Number(control.textareaCount || 0) >= 1;
  }
  if (expectedType === "SEARCH_INPUT") return Number(control.inputCount || 0) >= 1;
  return false;
}

function assessRecloudInspectionControlMapping(fieldControls = []) {
  const observedByLabel = new Map(
    (Array.isArray(fieldControls) ? fieldControls : [])
      .filter((control) => control && typeof control === "object")
      .map((control) => [String(control.label || "").trim(), control])
  );
  const fields = [];
  const missingFields = [];
  const ambiguousFields = [];
  const incompatibleFields = [];
  const excludedFields = [];
  for (const [key, definition] of Object.entries(RECLOUD_INSPECTION_FIELD_TARGETS)) {
    const observed = observedByLabel.get(definition.target) || null;
    const itemCount = Number(observed?.itemCount ?? (observed?.found ? 1 : 0));
    const mapping = {
      key,
      target: definition.target,
      expectedControl: definition.control,
      itemCount,
      mapped: itemCount === 1 && inspectionControlIsCompatible(observed, definition.control),
    };
    if (definition.status === "EXCLUDED") {
      excludedFields.push({ ...mapping, reason: "保持空白，不参与自动填写" });
      continue;
    }
    fields.push(mapping);
    if (itemCount === 0) missingFields.push(key);
    else if (itemCount > 1) ambiguousFields.push(key);
    else if (!mapping.mapped) incompatibleFields.push(key);
  }
  return {
    fields,
    excludedFields,
    missingFields,
    ambiguousFields,
    incompatibleFields,
    readyToPrefill:
      missingFields.length === 0 &&
      ambiguousFields.length === 0 &&
      incompatibleFields.length === 0,
    canAutoConfirm: false,
  };
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
    { key: "troubleshooting", target: RECLOUD_REPAIR_FIELD_TARGETS.troubleshooting.target, value: "否" },
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
      projectCorrection: order.modelAuthorization?.status === "CHANGE_REQUIRED" ? {
        currentProjectCode: order.modelAuthorization.currentProjectCode,
        expectedProjectCode: order.modelAuthorization.projectCode,
        productModelCode: order.modelAuthorization.productModelCode,
        model: order.modelAuthorization.model,
      } : null,
    },
    INSPECTION_COMPLETED: {
      inspectionResult: order.inspectionResult,
      inspectionRemark: order.inspectionRemark,
      inspectionCompletedAt: order.inspectionUpdatedAt,
      faultCategory: order.faultCategory,
      warrantyStatus: order.technicianWarranty,
      customerReasonConsistent: order.customerReasonConsistent,
      detectionResult: order.detectionResult,
      inspectionAbnormal: order.inspectionAbnormal,
      productFunctionDecision: order.productFunctionDecision,
      originalConsumables: order.originalConsumables,
      consumableName: order.consumableName,
      dismantled: order.dismantled,
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
  RECLOUD_INSPECTION_FIELD_TARGETS,
  RECLOUD_REPAIR_FIELD_TARGETS,
  buildRecloudInspectionFormPlan,
  assessRecloudInspectionControlMapping,
  buildRecloudRepairFormPlan,
  buildNodePayload,
  validateNodePayload,
};
