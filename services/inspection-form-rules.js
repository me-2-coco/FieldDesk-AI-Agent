const WARRANTY_TYPES = new Set(["保内", "保外"]);

function requiredText(value) {
  return String(value || "").trim();
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
  return {
    status: "READY",
    canAutoSubmit: true,
    fields: {
      faultCategory,
      customerReasonConsistent: "是",
      warrantyStatus: technicianWarranty,
      detectionResult: "维修",
      inspectionAbnormal: "否",
      productFunctionDecision: "功能问题",
      originalConsumables: "是",
      consumableName: "",
    },
  };
}

module.exports = { buildInspectionFormDecision };
