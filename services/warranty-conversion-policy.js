function normalizeText(value) {
  return String(value || "").trim();
}

function resolveWarrantyConversion(input = {}) {
  const warrantyStatus = normalizeText(input.warrantyStatus);
  const approved = input.manufacturerApproved === true;
  const approvalNo = normalizeText(input.manufacturerApprovalNo);

  if (approved && !approvalNo) {
    return {
      value: null,
      status: "MANUAL_CONFIRMATION_REQUIRED",
      reason: "标记为保外转保内，但缺少厂家特殊申请单号",
    };
  }

  if (approved && approvalNo) {
    return {
      value: "是",
      status: "APPROVED",
      approvalNo,
      reason: "存在厂家保外转保内特殊申请",
    };
  }

  return {
    value: "否",
    status: "NOT_APPLICABLE",
    reason: warrantyStatus === "保外" ? "普通保外" : "普通保内",
  };
}

module.exports = { resolveWarrantyConversion };
