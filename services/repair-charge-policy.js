const LOGISTICS_CHARGE_MODES = Object.freeze({
  ROUND_TRIP: { label: "收取往返运费", multiplier: 2 },
  ONE_WAY: { label: "只收单边运费", multiplier: 1 },
  WAIVED: { label: "运费全免", multiplier: 0 },
});

const DISCOUNT_SCOPES = Object.freeze({
  ORDER_TOTAL: "整体打折",
  SERVICE_ONLY: "配件＋维修费打折",
});

function normalizeMoney(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) {
    const error = new Error("单程物流费必须是大于或等于 0 的数字");
    error.code = "LOGISTICS_FEE_INVALID";
    throw error;
  }
  return Number(amount.toFixed(2));
}

function normalizeDiscountRate(enabled, value) {
  if (!enabled) return 10;
  const rate = Number(value);
  if (!Number.isFinite(rate) || rate <= 0 || rate >= 10) {
    const error = new Error("折扣必须是大于 0 且小于 10 的数字，例如 5.5 表示五五折");
    error.code = "DISCOUNT_RATE_INVALID";
    throw error;
  }
  return Number(rate.toFixed(2));
}

function resolveRepairCharge({
  partsFee = 0,
  repairFee = 0,
  oneWayLogisticsFee = 0,
  logisticsChargeMode = "ROUND_TRIP",
  discountEnabled = false,
  discountScope = "ORDER_TOTAL",
  discountRate = 10,
} = {}) {
  const mode = LOGISTICS_CHARGE_MODES[logisticsChargeMode];
  if (!mode) {
    const error = new Error("请选择正确的运费收取方式");
    error.code = "LOGISTICS_CHARGE_MODE_INVALID";
    throw error;
  }

  const normalizedPartsFee = normalizeMoney(partsFee);
  const normalizedRepairFee = normalizeMoney(repairFee);
  const normalizedOneWayFee = normalizeMoney(oneWayLogisticsFee);
  const logisticsFee = Number((normalizedOneWayFee * mode.multiplier).toFixed(2));
  const normalizedDiscountRate = normalizeDiscountRate(discountEnabled, discountRate);
  const normalizedDiscountScope = String(discountScope || "ORDER_TOTAL").trim();
  if (discountEnabled && !DISCOUNT_SCOPES[normalizedDiscountScope]) {
    const error = new Error("请选择正确的打折方案");
    error.code = "DISCOUNT_SCOPE_INVALID";
    throw error;
  }
  const originalServiceFee = Number((normalizedPartsFee + normalizedRepairFee).toFixed(2));
  const originalTotalFee = Number((originalServiceFee + logisticsFee).toFixed(2));
  const discountBaseAmount = discountEnabled && normalizedDiscountScope === "ORDER_TOTAL"
    ? originalTotalFee
    : originalServiceFee;
  const discountedBaseAmount = Number((discountBaseAmount * normalizedDiscountRate / 10).toFixed(2));
  const discountAmount = discountEnabled
    ? Number((discountBaseAmount - discountedBaseAmount).toFixed(2))
    : 0;
  const discountedServiceFee = discountEnabled && normalizedDiscountScope === "SERVICE_ONLY"
    ? discountedBaseAmount
    : originalServiceFee;
  const totalFee = discountEnabled && normalizedDiscountScope === "ORDER_TOTAL"
    ? discountedBaseAmount
    : Number((discountedServiceFee + logisticsFee).toFixed(2));
  const primaryRemark = logisticsChargeMode === "ROUND_TRIP" ? "无减免" : "申请运费减免";
  const logisticsDescription = logisticsChargeMode === "ROUND_TRIP"
    ? `来回运费${logisticsFee}元`
    : logisticsChargeMode === "ONE_WAY"
      ? `单边运费${logisticsFee}元（另一程减免）`
      : `运费全免（单程参考${normalizedOneWayFee}元）`;
  const discountDescription = discountEnabled
    ? normalizedDiscountScope === "ORDER_TOTAL"
      ? `整体费用原价${originalTotalFee}元，按${normalizedDiscountRate}折优惠${discountAmount}元`
      : `配件及维修费原价${originalServiceFee}元，按${normalizedDiscountRate}折优惠${discountAmount}元，折后${discountedServiceFee}元，运费不打折`
    : "不打折";

  return {
    logisticsChargeMode,
    logisticsChargeLabel: mode.label,
    logisticsMultiplier: mode.multiplier,
    oneWayLogisticsFee: normalizedOneWayFee,
    logisticsFee,
    discountEnabled: Boolean(discountEnabled),
    discountScope: normalizedDiscountScope,
    discountScopeLabel: DISCOUNT_SCOPES[normalizedDiscountScope],
    discountRate: normalizedDiscountRate,
    originalServiceFee,
    originalTotalFee,
    discountBaseAmount,
    discountedServiceFee,
    discountAmount,
    totalFee,
    primaryRemark,
    secondaryRemark: `配件费${normalizedPartsFee}元，维修费${normalizedRepairFee}元，${discountDescription}，${logisticsDescription}，合计：${totalFee}元`,
  };
}

module.exports = { DISCOUNT_SCOPES, LOGISTICS_CHARGE_MODES, resolveRepairCharge };
