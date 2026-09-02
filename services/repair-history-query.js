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
    completedAt: repairRecordTime(record),
  };
}

function rmaCreatedAt(rmaNo) {
  const match = String(rmaNo || "").trim().match(/^JXTH(\d{4})(\d{2})(\d{2})/i);
  if (!match) return "";
  const value = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00+08:00`);
  return Number.isNaN(value.getTime()) ? "" : value.toISOString();
}

function repairRecordTime(record) {
  return record.repairCompletion?.submittedAt
    || record.completedAt
    || record.receiptCompletedAt
    || record.sourceCreatedAt
    || rmaCreatedAt(record.rmaNo)
    || record.createdAt
    || record.updatedAt
    || "";
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

function shanghaiCalendarDay(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date).reduce((result, part) => {
    if (["year", "month", "day"].includes(part.type)) result[part.type] = Number(part.value);
    return result;
  }, {});
  return parts.year && parts.month && parts.day ? parts : null;
}

function isWithinOneCalendarMonth(left, right) {
  const leftDay = shanghaiCalendarDay(left);
  const rightDay = shanghaiCalendarDay(right);
  if (!leftDay || !rightDay) return false;
  const leftValue = Date.UTC(leftDay.year, leftDay.month - 1, leftDay.day);
  const rightValue = Date.UTC(rightDay.year, rightDay.month - 1, rightDay.day);
  const earlier = leftValue <= rightValue ? leftDay : rightDay;
  const laterValue = leftValue <= rightValue ? rightValue : leftValue;
  const targetMonthIndex = earlier.month;
  const targetYear = earlier.year + Math.floor(targetMonthIndex / 12);
  const targetMonth = targetMonthIndex % 12;
  const lastTargetDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const anniversary = Date.UTC(targetYear, targetMonth, Math.min(earlier.day, lastTargetDay));
  return laterValue <= anniversary;
}

function findMachineRepairHistory(records, { sn, phone, currentRmaNo = "", now = new Date() } = {}) {
  const normalizedSn = String(sn || "").trim().toUpperCase();
  const normalizedPhone = String(phone || "").trim();
  if (!normalizedSn && !normalizedPhone) return { isRepeatRepair: false, previousTechnicianName: "", records: [] };
  const allRecords = Array.isArray(records) ? records : [];
  const currentRecord = allRecords.find((record) => String(record.rmaNo || "").trim() === String(currentRmaNo || "").trim());
  const referenceValue = repairRecordTime(currentRecord || {}) || rmaCreatedAt(currentRmaNo) || now;
  const referenceTime = referenceValue instanceof Date ? referenceValue.getTime() : new Date(referenceValue).getTime();
  const history = allRecords
    .filter((record) => (
      Boolean(normalizedSn && String(record.sn || "").trim().toUpperCase() === normalizedSn)
      || Boolean(normalizedPhone && phoneMatches(record.phoneMasked || record.phone, normalizedPhone))
    ))
    .filter((record) => String(record.rmaNo || "").trim() !== String(currentRmaNo || "").trim())
    .filter((record) => repairRecordTime(record))
    .map(safeHistoryRecord)
    .sort((left, right) => String(right.completedAt).localeCompare(String(left.completedAt)));
  const latest = history[0] || null;
  const repeatRecord = history.find((record) => isWithinOneCalendarMonth(referenceTime, record.completedAt)) || null;
  return {
    isRepeatRepair: Boolean(repeatRecord),
    previousTechnicianName: (repeatRecord || latest)?.technicianName || "",
    previousCompletedAt: (repeatRecord || latest)?.completedAt || "",
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
