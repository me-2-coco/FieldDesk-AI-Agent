const test = require("node:test");
const assert = require("node:assert/strict");
const {
  compactDesiredParts,
  buildRecloudRepairPartsPlan,
} = require("../services/recloud-repair-parts-plan");

test("repair parts plan skips an exact existing part and adds only the missing part", () => {
  const plan = buildRecloudRepairPartsPlan([
    { partCode: "20020100013703", partName: "水泵", quantity: 1, repairLevel: "中修" },
    { partCode: "20020100023188", partName: "水箱组件", quantity: 1, repairLevel: "中修" },
  ], [
    { partCode: "20020100013703", partName: "水泵", quantity: 1 },
  ]);
  assert.deepEqual(plan.skipped, [
    { partCode: "20020100013703", quantity: 1, reason: "ALREADY_MATCHED" },
  ]);
  assert.deepEqual(plan.additions.map((item) => item.partCode), ["20020100023188"]);
  assert.equal(plan.readyToAdd, true);
  assert.equal(plan.mayDeleteExisting, false);
  assert.equal(plan.mayUpdateExisting, false);
});

test("repair parts plan stops on quantity mismatch instead of overwriting", () => {
  const plan = buildRecloudRepairPartsPlan(
    [{ partCode: "PART-1", quantity: 2 }],
    [{ partCode: "PART-1", quantity: 1 }]
  );
  assert.equal(plan.readyToAdd, false);
  assert.deepEqual(plan.conflicts, [{
    partCode: "PART-1", expectedQuantity: 2, existingQuantity: 1, reason: "QUANTITY_MISMATCH",
  }]);
  assert.deepEqual(plan.additions, []);
});

test("repair parts plan stops when Recloud contains an unplanned part", () => {
  const plan = buildRecloudRepairPartsPlan([], [{ partCode: "EXISTING-ONLY", quantity: 1 }]);
  assert.equal(plan.readyToAdd, false);
  assert.equal(plan.conflicts[0].reason, "UNPLANNED_EXISTING_PART");
});

test("repair parts plan refuses duplicate existing rows", () => {
  assert.throws(() => buildRecloudRepairPartsPlan(
    [{ partCode: "PART-1", quantity: 2 }],
    [{ partCode: "PART-1", quantity: 1 }, { partCode: "part-1", quantity: 1 }]
  ), { code: "RECLOUD_REPAIR_EXISTING_PART_DUPLICATE", partCode: "PART-1" });
});

test("local duplicate desired parts aggregate only when their business identity agrees", () => {
  assert.deepEqual(compactDesiredParts([
    { partCode: "part-1", partName: "水泵", quantity: 1, repairLevel: "中修" },
    { partCode: "PART-1", partName: "水泵", quantity: 2, repairLevel: "中修" },
  ]), [{ partCode: "PART-1", partName: "水泵", quantity: 3, repairLevel: "中修" }]);
  assert.throws(() => compactDesiredParts([
    { partCode: "PART-1", partName: "水泵", quantity: 1 },
    { partCode: "PART-1", partName: "水箱", quantity: 1 },
  ]), { code: "RECLOUD_REPAIR_PART_CONFLICT", partCode: "PART-1" });
});
