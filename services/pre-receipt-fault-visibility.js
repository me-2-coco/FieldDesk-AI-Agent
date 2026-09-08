function receiptIsComplete(detail = {}) {
  return Boolean(
    detail.receiptCompletedAt
    || detail.localWorkflow?.receiptCompletedAt
  );
}

function hideFaultForUnsignedOrder(detail = {}) {
  if (receiptIsComplete(detail)) return detail;
  return {
    ...detail,
    reportedFault: "",
    reportedFaultHiddenUntilReceipt: true,
    localWorkflow: detail.localWorkflow ? { ...detail.localWorkflow, reportedFault: "" } : detail.localWorkflow,
    repairHistory: Array.isArray(detail.repairHistory)
      ? detail.repairHistory.map((record) => ({ ...record, reportedFault: "" }))
      : detail.repairHistory,
  };
}

function protectPreReceiptFaults(data, { restricted = false } = {}) {
  if (!restricted || !data) return data;
  if (Array.isArray(data)) return data.map(hideFaultForUnsignedOrder);
  if (Array.isArray(data.matches)) {
    return { ...data, matches: data.matches.map(hideFaultForUnsignedOrder) };
  }
  return hideFaultForUnsignedOrder(data);
}

function restrictFaultVisibilityForUser(user = {}) {
  return ["TECHNICIAN", "INFORMATION_CLERK"].includes(
    String(user.role || "").trim().toUpperCase()
  );
}

module.exports = { receiptIsComplete, protectPreReceiptFaults, restrictFaultVisibilityForUser };
