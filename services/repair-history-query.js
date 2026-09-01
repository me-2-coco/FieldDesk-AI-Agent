function digits(value) {
  return String(value || "").replace(/\D/g, "");
}

function phoneMatches(maskedPhone, query) {
  const stored = String(maskedPhone || "");
  const wanted = digits(query);
  if (wanted.length < 4) return false;
  const storedDigits = digits(stored);
  if (wanted.length >= 11 && storedDigits.length >= 7) {
    return wanted.slice(0, 3) === storedDigits.slice(0, 3) && wanted.slice(-4) === storedDigits.slice(-4);
  }
  return storedDigits.includes(wanted) || wanted.endsWith(storedDigits.slice(-4));
}

function safeHistoryRecord(record) {
  const completion = record.repairCompletion || {};
  const usedParts = Array.isArray(completion.usedParts) ? completion.usedParts : [];
  return {
    rmaNo: record.rmaNo,
    phone: record.phone || record.phoneFull || record.phoneMasked || "",
    customerName: record.customerName || "",
    customerAddress: record.customerAddress || record.address || record.region || "",
    productLine: record.productLine || record.specialty || "",
    sn: record.sn || "",
    reportedFault: record.reportedFault || record.faultDescription || record.originalFault || "",
    replacedParts: usedParts.map((part) => ({
      name: part.partName || part.name || "未命名配件",
      quantity: Number(part.quantity) || 1,
    })),
    technicianName: record.technicianName || completion.operatorName || record.operatorName || "未记录",
    completedAt: completion.submittedAt || record.completedAt || record.updatedAt || "",
  };
}

function queryRepairHistory(records, keyword) {
  const query = String(keyword || "").trim();
  const normalizedSn = query.toUpperCase();
  const isPhone = /^1[3-9]\d{9}$/.test(digits(query));
  const isSn = !isPhone && /^[A-Z0-9-]{8,}$/i.test(query);
  if (!isPhone && !isSn) return [];
  return (Array.isArray(records) ? records : [])
    .filter((record) => record.repairCompletion?.submittedAt)
    .filter((record) => isPhone
      ? phoneMatches(record.phoneMasked || record.phone, query)
      : String(record.sn || "").trim().toUpperCase() === normalizedSn)
    .map(safeHistoryRecord)
    .sort((left, right) => String(right.completedAt).localeCompare(String(left.completedAt)));
}

function queryRepairHistoryByPhone(records, phone) {
  return queryRepairHistory(records, phone);
}

const REPEAT_REPAIR_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function findMachineRepairHistory(records, { sn, currentRmaNo = "", now = new Date() } = {}) {
  const normalizedSn = String(sn || "").trim().toUpperCase();
  if (!normalizedSn) return { isRepeatRepair: false, previousTechnicianName: "", records: [] };
  const nowTime = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const history = (Array.isArray(records) ? records : [])
    .filter((record) => String(record.sn || "").trim().toUpperCase() === normalizedSn)
    .filter((record) => String(record.rmaNo || "").trim() !== String(currentRmaNo || "").trim())
    .filter((record) => record.repairCompletion?.submittedAt)
    .map(safeHistoryRecord)
    .sort((left, right) => String(right.completedAt).localeCompare(String(left.completedAt)));
  const latest = history[0] || null;
  const latestTime = latest ? new Date(latest.completedAt).getTime() : NaN;
  const ageMs = Number.isFinite(nowTime) && Number.isFinite(latestTime) ? nowTime - latestTime : Infinity;
  return {
    isRepeatRepair: Boolean(latest && ageMs >= 0 && ageMs <= REPEAT_REPAIR_WINDOW_MS),
    previousTechnicianName: latest?.technicianName || "",
    previousCompletedAt: latest?.completedAt || "",
    records: history,
  };
}

const IN_HAND_EXCLUDED_STATUSES = new Set(["SHIPPED_PENDING_COMPLETION", "COMPLETED", "TRANSFERRED_TO_HEADQUARTERS", "CANCELLED"]);

function queryMachinesInHand(records, keyword) {
  const query = String(keyword || "").trim();
  if (!query) return [];
  const normalizedLogistics = query.toUpperCase();
  return (Array.isArray(records) ? records : [])
    .filter((record) => !IN_HAND_EXCLUDED_STATUSES.has(record.status))
    .filter((record) => phoneMatches(record.phoneMasked || record.phone, query) || String(record.logisticsNo || "").toUpperCase() === normalizedLogistics)
    .map((record) => ({
      rmaNo: record.rmaNo,
      logisticsNo: record.logisticsNo,
      sn: record.sn,
      productLine: record.productLine || record.specialty || "",
      status: record.status,
      technicianName: record.technicianName || record.operatorName || "未分配",
      receivedAt: record.receiptCompletedAt || record.createdAt || "",
      updatedAt: record.updatedAt || "",
    }))
    .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
}

module.exports = {
  digits,
  phoneMatches,
  queryRepairHistory,
  queryRepairHistoryByPhone,
  findMachineRepairHistory,
  queryMachinesInHand,
};
