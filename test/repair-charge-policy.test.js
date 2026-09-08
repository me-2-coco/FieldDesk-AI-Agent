const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveRepairCharge } = require("../services/repair-charge-policy");

test("往返运费按单程两倍计费并选择无减免", () => {
  const result = resolveRepairCharge({ partsFee: 8, repairFee: 60, oneWayLogisticsFee: 34 });
  assert.equal(result.logisticsFee, 68);
  assert.equal(result.totalFee, 136);
  assert.equal(result.primaryRemark, "无减免");
  assert.equal(result.secondaryRemark, "配件费8元，维修费60元，运费68元，合计136元");
});

test("单边运费只计一次并生成运费减免备注", () => {
  const result = resolveRepairCharge({
    partsFee: 8,
    repairFee: 60,
    oneWayLogisticsFee: 34,
    logisticsChargeMode: "ONE_WAY",
  });
  assert.equal(result.logisticsFee, 34);
  assert.equal(result.totalFee, 102);
  assert.equal(result.primaryRemark, "无减免");
  assert.equal(result.secondaryRemark, "配件费8元，维修费60元，运费34元，合计102元");
});

test("运费全免时保留参考单程费用但客户运费为零", () => {
  const result = resolveRepairCharge({
    partsFee: 8,
    repairFee: 60,
    oneWayLogisticsFee: 34,
    logisticsChargeMode: "WAIVED",
  });
  assert.equal(result.logisticsFee, 0);
  assert.equal(result.totalFee, 68);
  assert.equal(result.primaryRemark, "无减免");
  assert.equal(result.secondaryRemark, "配件费8元，维修费60元，运费0元，合计68元");
});

test("未知运费方式停止计算", () => {
  assert.throws(
    () => resolveRepairCharge({ logisticsChargeMode: "UNKNOWN" }),
    { code: "LOGISTICS_CHARGE_MODE_INVALID" }
  );
});

test("整体打折默认将配件费维修费和运费一起折算", () => {
  const result = resolveRepairCharge({
    partsFee: 40,
    repairFee: 60,
    oneWayLogisticsFee: 10,
    logisticsChargeMode: "ROUND_TRIP",
    discountEnabled: true,
    discountScope: "ORDER_TOTAL",
    discountRate: 5.5,
  });
  assert.equal(result.originalTotalFee, 120);
  assert.equal(result.discountAmount, 54);
  assert.equal(result.totalFee, 66);
  assert.equal(result.discountScopeLabel, "整体打折");
  assert.equal(result.primaryRemark, "申请折扣减免");
  assert.equal(result.secondaryRemark, "配件费40元，维修费60元，运费20元，合计120元，5.5折后费用合计66元");
});

test("维修费用打折后再加原价运费", () => {
  const result = resolveRepairCharge({
    partsFee: 40,
    repairFee: 60,
    oneWayLogisticsFee: 10,
    logisticsChargeMode: "ROUND_TRIP",
    discountEnabled: true,
    discountScope: "SERVICE_ONLY",
    discountRate: 3,
  });
  assert.equal(result.discountedServiceFee, 30);
  assert.equal(result.logisticsFee, 20);
  assert.equal(result.discountAmount, 70);
  assert.equal(result.totalFee, 50);
  assert.equal(result.primaryRemark, "申请折扣减免");
  assert.equal(result.secondaryRemark, "配件费40元，维修费60元，运费20元，合计120元，3折后费用合计50元");
});

test("最终应收默认自动计算，也允许在费用原价内手动覆盖", () => {
  const automatic = resolveRepairCharge({
    partsFee: 448,
    repairFee: 80,
    oneWayLogisticsFee: 33,
    logisticsChargeMode: "ROUND_TRIP",
    discountEnabled: true,
    discountRate: 2.6,
  });
  assert.equal(automatic.automaticTotalFee, 154.44);
  assert.equal(automatic.totalFee, 154.44);
  assert.equal(automatic.manualTotalFee, null);
  assert.equal(automatic.totalFeeSource, "AUTOMATIC");

  const manual = resolveRepairCharge({
    partsFee: 448,
    repairFee: 80,
    oneWayLogisticsFee: 33,
    logisticsChargeMode: "ROUND_TRIP",
    discountEnabled: true,
    discountRate: 2.6,
    finalChargeAmount: 155.4,
  });
  assert.equal(manual.automaticTotalFee, 154.44);
  assert.equal(manual.totalFee, 155.4);
  assert.equal(manual.manualTotalFee, 155.4);
  assert.equal(manual.totalFeeSource, "MANUAL");
  assert.match(manual.secondaryRemark, /费用合计155\.4元/);
});

test("手动最终应收拒绝负数、非数字和超过费用原价", () => {
  for (const finalChargeAmount of [-1, "abc", 137]) {
    assert.throws(
      () => resolveRepairCharge({ partsFee: 8, repairFee: 60, oneWayLogisticsFee: 34, finalChargeAmount }),
      { code: "FINAL_CHARGE_AMOUNT_INVALID" }
    );
  }
});

test("启用打折后拒绝无效折数和未知方案", () => {
  assert.throws(
    () => resolveRepairCharge({ discountEnabled: true, discountRate: 10 }),
    { code: "DISCOUNT_RATE_INVALID" }
  );
  assert.throws(
    () => resolveRepairCharge({ discountEnabled: true, discountRate: 5, discountScope: "UNKNOWN" }),
    { code: "DISCOUNT_SCOPE_INVALID" }
  );
});
