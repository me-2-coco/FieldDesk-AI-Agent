const test = require("node:test");
const assert = require("node:assert/strict");
const { executeRepairPrefillSafely } = require("../services/repair-prefill-executor");

function memoryAdapter(initial, hooks = {}) {
  const values = new Map(Object.entries(initial));
  const writes = [];
  let safetyChecks = 0;
  return {
    values,
    writes,
    get safetyChecks() { return safetyChecks; },
    async assertSafe() { safetyChecks += 1; if (hooks.assertSafe) await hooks.assertSafe(safetyChecks); },
    async read(key) { return values.get(key); },
    async write(key, value) {
      writes.push([key, value]);
      if (hooks.write) return hooks.write(key, value, values, writes);
      values.set(key, value);
    },
  };
}

const PLAN = {
  readyToPrefill: true,
  missingFields: [],
  canAutoConfirm: false,
  safeWrites: [
    { key: "repairMeasure", value: "维修措施演练" },
    { key: "highestRepairLevel", value: "中修" },
    { key: "customerPaidAmount", value: 447 },
    { key: "usedParts", value: [{ partCode: "SAFE-MOCK", quantity: 1 }] },
    { key: "attachments", value: [{ id: "SAFE-MOCK-FILE" }] },
  ],
};

test("repair prefill verifies and restores reversible fields without saving", async () => {
  const adapter = memoryAdapter({ repairMeasure: "原措施", highestRepairLevel: "小修", customerPaidAmount: 0 });
  const result = await executeRepairPrefillSafely(PLAN, adapter);
  assert.deepEqual(Object.fromEntries(adapter.values), {
    repairMeasure: "原措施", highestRepairLevel: "小修", customerPaidAmount: 0,
  });
  assert.deepEqual(result.deferredFields, ["usedParts", "attachments"]);
  assert.deepEqual(result.deferredActions, []);
  assert.equal(result.valuesVerified, true);
  assert.equal(result.valuesRestored, true);
  assert.equal(result.saveClicked, false);
  assert.equal(result.confirmClicked, false);
  assert.equal(result.recloudModified, false);
  assert.ok(adapter.safetyChecks >= 9);
});

test("one-shot warranty conversion is deferred and never simulated as a reversible field", async () => {
  const adapter = memoryAdapter({ repairMeasure: "原措施", warrantyConversion: "按钮存在" });
  const result = await executeRepairPrefillSafely({
    ...PLAN,
    safeWrites: [{ key: "repairMeasure", value: "维修措施演练" }],
    requiredActions: [{ key: "warrantyConversion", action: "CLICK_IF_VISIBLE" }],
  }, adapter);

  assert.deepEqual(result.deferredActions, ["warrantyConversion"]);
  assert.equal(adapter.writes.some(([key]) => key === "warrantyConversion"), false);
});

test("repair prefill restores snapshots when verification fails", async () => {
  const adapter = memoryAdapter(
    { repairMeasure: "原措施", highestRepairLevel: "小修", customerPaidAmount: 0 },
    { write(key, value, values) {
      if (key === "highestRepairLevel" && value === "中修") values.set(key, "小修");
      else values.set(key, value);
    } }
  );
  await assert.rejects(executeRepairPrefillSafely(PLAN, adapter), {
    code: "RECLOUD_REPAIR_PREFILL_VERIFY_FAILED", fieldKey: "highestRepairLevel", phase: "VERIFY",
  });
  assert.deepEqual(Object.fromEntries(adapter.values), {
    repairMeasure: "原措施", highestRepairLevel: "小修", customerPaidAmount: 0,
  });
});

test("repair prefill stops before reading controls when the plan is incomplete", async () => {
  const adapter = memoryAdapter({ repairMeasure: "原措施" });
  await assert.rejects(
    executeRepairPrefillSafely({ safeWrites: [], missingFields: ["faultLevel3"], readyToPrefill: false }, adapter),
    { code: "RECLOUD_REPAIR_PREFILL_PLAN_INVALID", phase: "PLAN" }
  );
  assert.deepEqual(adapter.writes, []);
});

test("network guard failure still restores every snapshotted repair field", async () => {
  let failed = false;
  const adapter = memoryAdapter(
    { repairMeasure: "原措施", highestRepairLevel: "小修", customerPaidAmount: 0 },
    { assertSafe(checks) {
      if (!failed && checks === 4) {
        failed = true;
        const error = new Error("blocked");
        error.code = "RECLOUD_UNEXPECTED_WRITE_REQUEST";
        throw error;
      }
    } }
  );
  await assert.rejects(executeRepairPrefillSafely(PLAN, adapter), { code: "RECLOUD_UNEXPECTED_WRITE_REQUEST" });
  assert.deepEqual(Object.fromEntries(adapter.values), {
    repairMeasure: "原措施", highestRepairLevel: "小修", customerPaidAmount: 0,
  });
});

test("repair prefill verifies detection decisions without rewriting them", async () => {
  const plan = {
    ...PLAN,
    verifyOnlyFields: [
      { key: "faultClassification", value: "产品质量 / 地刷不出水 / 水泵不良" },
      { key: "responsibilityType", value: "保外" },
    ],
  };
  const adapter = memoryAdapter({
    faultClassification: "产品质量 / 地刷不出水 / 水泵不良",
    responsibilityType: "保外",
    repairMeasure: "原措施",
    highestRepairLevel: "小修",
    customerPaidAmount: 0,
  });
  await executeRepairPrefillSafely(plan, adapter);
  assert.equal(adapter.writes.some(([key]) => key === "faultClassification" || key === "responsibilityType"), false);
});

test("repair prefill stops when a detection-stage decision no longer matches", async () => {
  const plan = {
    ...PLAN,
    verifyOnlyFields: [{ key: "responsibilityType", value: "保外" }],
  };
  const adapter = memoryAdapter({
    responsibilityType: "保内",
    repairMeasure: "原措施",
    highestRepairLevel: "小修",
    customerPaidAmount: 0,
  });
  await assert.rejects(executeRepairPrefillSafely(plan, adapter), {
    code: "RECLOUD_REPAIR_PREFILL_PRECONDITION_MISMATCH",
    fieldKey: "responsibilityType",
    phase: "PRECONDITION",
  });
  assert.deepEqual(adapter.writes, []);
});
