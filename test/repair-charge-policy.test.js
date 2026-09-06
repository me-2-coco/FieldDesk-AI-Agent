const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveRepairCharge } = require("../services/repair-charge-policy");

test("往返运费按单程两倍计费并选择无减免", () => {
  const result = resolveRepairCharge({ partsFee: 8, repairFee: 60, oneWayLogisticsFee: 34 });
  assert.equal(result.logisticsFee, 68);
  assert.equal(result.totalFee, 136);
  assert.equal(result.primaryRemark, "无减免");
  assert.match(result.secondaryRemark, /来回运费68元/);
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
  assert.equal(result.primaryRemark, "申请运费减免");
  assert.match(result.secondaryRemark, /另一程减免/);
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
  assert.equal(result.primaryRemark, "申请运费减免");
  assert.match(result.secondaryRemark, /运费全免/);
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
  assert.match(result.secondaryRemark, /整体费用原价120元，按5.5折优惠54元/);
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
  assert.match(result.secondaryRemark, /运费不打折/);
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
