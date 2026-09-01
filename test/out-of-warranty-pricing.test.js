const test = require("node:test");
const assert = require("node:assert/strict");
const { resolvePartsFee, resolveOutOfWarrantyFee, buildPricingPreview } = require("../services/out-of-warranty-pricing");

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

test("prepares fees but does not apply them before warranty is out of warranty", () => {
  const result = buildPricingPreview({ modelRepairFees: fees, usedParts: [], warrantyStatus: "" });
  assert.equal(result.status, "PREPARED_NOT_APPLIED");
  assert.deepEqual(result.repairSchedule, { 小修: 50, 中修: 70, 大修: 80 });
});

test("shows repair fee, parts fee and known total immediately for out-of-warranty parts", () => {
  const result = buildPricingPreview({
    modelRepairFees: fees,
    warrantyStatus: "保外",
    usedParts: [{ retailPrice: 120, quantity: 2, repairLevel: "中修" }],
  });
  assert.equal(result.repairFee, 70);
  assert.equal(result.partsFee, 240);
  assert.equal(result.knownTotal, 310);
});

test("W2458S live-table example calculates three known parts and medium repair fee", () => {
  const result = buildPricingPreview({
    modelRepairFees: { 大修: 60, 中修: 40, 小修: 20 },
    warrantyStatus: "保外",
    usedParts: [
      { partCode: "20020100013703", retailPrice: 29, quantity: 1, repairLevel: "中修" },
      { partCode: "20020100013687", retailPrice: 5, quantity: 1, repairLevel: "中修" },
      { partCode: "20020100007849", retailPrice: 1, quantity: 1, repairLevel: "小修" },
    ],
  });
  assert.equal(result.highestLevel, "中修");
  assert.equal(result.repairFee, 40);
  assert.equal(result.partsFee, 35);
  assert.equal(result.knownTotal, 75);
});

test("missing retail price never becomes a free part", () => {
  assert.deepEqual(
    resolvePartsFee([{ partCode: "20020100010822", retailPrice: null, quantity: 1 }]),
    {
      status: "PART_PRICE_MISSING",
      canPrice: false,
      partsFee: null,
      unresolvedParts: [{ partCode: "20020100010822", partName: "" }],
    }
  );
  const result = buildPricingPreview({
    modelRepairFees: fees,
    warrantyStatus: "保外",
    usedParts: [{ partCode: "20020100010822", retailPrice: null, quantity: 1, repairLevel: "小修" }],
  });
  assert.equal(result.status, "PART_PRICE_MISSING");
  assert.equal(result.canPrice, false);
  assert.equal(result.knownTotal, null);
});
