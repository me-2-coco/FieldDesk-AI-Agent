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
