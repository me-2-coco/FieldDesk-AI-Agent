function normalize(value) {
  return String(value || "").trim();
}

function parseSnProductionMonth(sn) {
  const normalized = normalize(sn).toUpperCase();
  if (normalized.length < 8 || !/^\d$/.test(normalized[6])) {
    return { status: "INVALID_SN_DATE" };
  }
  const monthCode = normalized[7];
  const month = { A: 10, B: 11, C: 12 }[monthCode] || (/^[1-9]$/.test(monthCode) ? Number(monthCode) : 0);
  if (!month) return { status: "INVALID_SN_DATE" };
  return {
    status: "PARSED",
    year: 2020 + Number(normalized[6]),
    month,
  };
}

function addMonths(date, months) {
  const result = new Date(date.getTime());
  const originalDay = result.getUTCDate();
  const originalMonthEnd = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  const wasMonthEnd = result.getUTCDate() === originalMonthEnd;
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const targetMonthEnd = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(wasMonthEnd ? targetMonthEnd : Math.min(originalDay, targetMonthEnd));
  return result;
}

function evaluateWarranty(input = {}) {
  if (input.isOfficialRefurbished === true) {
    return { status: "MANUAL_CONFIRMATION_REQUIRED", reason: "官翻机不适用普通质保推算规则" };
  }
  const years = Number(input.warrantyYears || 2);
  if (![2, 3].includes(years)) {
    return { status: "MANUAL_CONFIRMATION_REQUIRED", reason: "机型质保年限未配置" };
  }
  const now = input.now ? new Date(input.now) : new Date();
  const purchaseDate = normalize(input.purchaseDate);
  let anchor;
  let source;
  let graceMonths = 0;
  if (purchaseDate) {
    anchor = new Date(`${purchaseDate}T00:00:00.000Z`);
    source = "PURCHASE_DATE";
  } else {
    const production = parseSnProductionMonth(input.sn);
    if (production.status !== "PARSED") return production;
    anchor = new Date(Date.UTC(production.year, production.month, 0, 23, 59, 59, 999));
    source = "SN_PRODUCTION_MONTH";
    graceMonths = 3;
  }
  if (Number.isNaN(anchor.getTime()) || Number.isNaN(now.getTime())) {
    return { status: "INVALID_DATE" };
  }
  const expiresAt = addMonths(anchor, years * 12 + graceMonths);
  const warrantyStatus = now <= expiresAt ? "保内" : "保外";
  return {
    status: "DETERMINED",
    warrantyStatus,
    warrantyYears: years,
    source,
    graceMonths,
    expiresAt: expiresAt.toISOString(),
  };
}

module.exports = { parseSnProductionMonth, evaluateWarranty };
