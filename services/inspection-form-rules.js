const WARRANTY_TYPES = new Set(["保内", "保外"]);

function requiredText(value) {
  return String(value || "").trim();
}

function resolveFaultContent(input = {}) {
  const treatmentMode = requiredText(input.treatmentMode);
  if (treatmentMode === "DEBUGGING") return "未复现";
  if (treatmentMode === "INSPECTION_ONLY") {
    const inspectionFaultOutcome = requiredText(input.inspectionFaultOutcome);
    if (inspectionFaultOutcome === "FAULT_REPRODUCED") return "故障复现";
    if (inspectionFaultOutcome === "NO_FAULT") return "未复现";
    // 兼容升级前已保存的只检测工单；新工单由接口强制选择明确结果。
    const faultCategory = requiredText(input.faultCategory);
    return /(无不良|未复现|无异常|检测正常)/.test(faultCategory)
      ? "未复现"
      : "故障复现";
  }
  return "故障复现";
}

function buildInspectionFormDecision(input = {}) {
  const faultCategory = requiredText(input.faultCategory);
  const technicianWarranty = requiredText(input.technicianWarranty);
  const snWarranty = requiredText(input.snWarranty);
  const missingFields = [
    !faultCategory && "faultCategory",
    !technicianWarranty && "technicianWarranty",
    !snWarranty && "snWarranty",
  ].filter(Boolean);
  if (missingFields.length) {
    return { status: "INCOMPLETE", missingFields, canAutoSubmit: false };
  }
  if (!WARRANTY_TYPES.has(technicianWarranty) || !WARRANTY_TYPES.has(snWarranty)) {
    return { status: "INVALID_WARRANTY", missingFields: [], canAutoSubmit: false };
  }
  if (technicianWarranty !== snWarranty) {
    return {
      status: "MANUAL_CONFIRMATION_REQUIRED",
      reason: "师傅选择的保修状态与 SN 规则判断不一致",
      technicianWarranty,
      snWarranty,
      canAutoSubmit: false,
    };
  }
  const treatmentMode = requiredText(input.treatmentMode);
  const requestedResult = requiredText(input.detectionResult)
    || (treatmentMode === "DEBUGGING" ? "调试" : "");
  const detectionResult = ["弃修", "不修"].includes(requestedResult)
    ? "弃修"
    : ["只检测不维修", "检测不维修"].includes(requestedResult)
      ? "检测不维修"
      : "维修";
  return {
    status: "READY",
    canAutoSubmit: true,
    fields: {
      faultCategory,
      customerReasonConsistent: "是",
      warrantyStatus: technicianWarranty,
      detectionResult,
      inspectionAbnormal: "否",
      productFunctionDecision: treatmentMode === "DEBUGGING" || requestedResult === "调试" ? "无异常" : "功能问题",
      faultContent: resolveFaultContent({
        treatmentMode: treatmentMode || (requestedResult === "调试" ? "DEBUGGING" : ""),
        faultCategory,
        inspectionFaultOutcome: input.inspectionFaultOutcome,
      }),
      originalConsumables: "是",
      consumableName: "",
    },
  };
}

module.exports = { buildInspectionFormDecision, resolveFaultContent };
