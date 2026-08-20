const LOGISTICS_CHARGE_MODES = Object.freeze({
  ROUND_TRIP: { label: "收取往返运费", multiplier: 2 },
  ONE_WAY: { label: "只收单边运费", multiplier: 1 },
  WAIVED: { label: "运费全免", multiplier: 0 },
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

function resolveRepairCharge({
  partsFee = 0,
  repairFee = 0,
  oneWayLogisticsFee = 0,
  logisticsChargeMode = "ROUND_TRIP",
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
  const totalFee = Number((normalizedPartsFee + normalizedRepairFee + logisticsFee).toFixed(2));
  const primaryRemark = logisticsChargeMode === "ROUND_TRIP" ? "无减免" : "申请运费减免";
  const logisticsDescription = logisticsChargeMode === "ROUND_TRIP"
    ? `来回运费${logisticsFee}元`
    : logisticsChargeMode === "ONE_WAY"
      ? `单边运费${logisticsFee}元（另一程减免）`
      : `运费全免（单程参考${normalizedOneWayFee}元）`;

  return {
    logisticsChargeMode,
    logisticsChargeLabel: mode.label,
    logisticsMultiplier: mode.multiplier,
    oneWayLogisticsFee: normalizedOneWayFee,
    logisticsFee,
    totalFee,
    primaryRemark,
    secondaryRemark: `配件费${normalizedPartsFee}元，维修费${normalizedRepairFee}元，${logisticsDescription}，合计：${totalFee}元`,
  };
}

module.exports = { LOGISTICS_CHARGE_MODES, resolveRepairCharge };
