const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveOutOfWarrantyFee } = require("../services/out-of-warranty-pricing");

const fees = { 大修: 80, 中修: 70, 小修: 50 };

test("uses medium repair price when parts contain medium and minor levels", () => {
  const result = resolveOutOfWarrantyFee(fees, [{ name: "件1", repairLevel: "小修" }, { name: "件2", repairLevel: "中修" }]);
  assert.deepEqual(result, { status: "READY", canPrice: true, highestLevel: "中修", fee: 70 });
});

test("uses major repair price whenever any replaced part is major", () => {
  const result = resolveOutOfWarrantyFee(fees, [{ name: "件1", repairLevel: "小修" }, { name: "件2", repairLevel: "大修" }, { name: "件3", repairLevel: "中修" }]);
  assert.equal(result.highestLevel, "大修");
  assert.equal(result.fee, 80);
});

test("stops instead of guessing when a part has no repair level", () => {
  const result = resolveOutOfWarrantyFee(fees, [{ name: "未知件" }]);
  assert.equal(result.status, "PART_LEVEL_MISSING");
  assert.equal(result.canPrice, false);
});
