const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DIRECT_REPAIR_FIELDS,
  normalizeRepairControlValue,
  locateUniqueRepairInput,
} = require("../connectors/recloud-repair-control-adapter");

function itemWithControls(count) {
  return {
    locator(selector) {
      assert.equal(selector, "input:visible, textarea:visible");
      return {
        async count() { return count; },
        first() { return { marker: "only-control" }; },
      };
    },
  };
}

test("repair direct field map contains only the three observed service-report inputs", () => {
  assert.deepEqual(Object.keys(DIRECT_REPAIR_FIELDS).sort(), [
    "customerPaidAmount", "highestRepairLevel", "logisticsAmount",
  ]);
  assert.equal(DIRECT_REPAIR_FIELDS.logisticsAmount.target, "快递金额");
});

test("repair numeric controls normalize separators and blank placeholders", () => {
  assert.equal(normalizeRepairControlValue(" 1,220.00 ", "NUMBER"), "1220");
  assert.equal(normalizeRepairControlValue("--", "NUMBER"), "");
  assert.equal(normalizeRepairControlValue(447, "NUMBER"), "447");
  assert.equal(normalizeRepairControlValue(" 中修 ", "TEXT"), "中修");
});

test("repair input locator requires exactly one visible control", async () => {
  assert.equal((await locateUniqueRepairInput(itemWithControls(1), "logisticsAmount")).marker, "only-control");
  await assert.rejects(locateUniqueRepairInput(itemWithControls(0), "logisticsAmount"), {
    code: "RECLOUD_REPAIR_CONTROL_INCOMPATIBLE", fieldKey: "logisticsAmount",
  });
  await assert.rejects(locateUniqueRepairInput(itemWithControls(2), "logisticsAmount"), {
    code: "RECLOUD_REPAIR_CONTROL_AMBIGUOUS", fieldKey: "logisticsAmount",
  });
});
