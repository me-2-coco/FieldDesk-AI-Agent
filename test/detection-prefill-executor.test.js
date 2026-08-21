const test = require("node:test");
const assert = require("node:assert/strict");
const { executeDetectionPrefillSafely } = require("../services/detection-prefill-executor");

function memoryAdapter(initial, hooks = {}) {
  const values = new Map(Object.entries(initial));
  const writes = [];
  return {
    values,
    writes,
    async read(key) {
      return hooks.read ? hooks.read(key, values) : values.get(key);
    },
    async write(key, value) {
      writes.push([key, value]);
      if (hooks.write) return hooks.write(key, value, values, writes);
      values.set(key, value);
    },
  };
}

const PLAN = {
  safeWrites: [
    { key: "faultCategory", value: "产品质量 / 不出水 / 水泵不良" },
    { key: "customerReasonConsistent", value: "是" },
    { key: "warrantyStatus", value: "保内" },
  ],
  missingFields: [],
  canAutoConfirm: false,
};

test("safe detection prefill verifies every value and restores the original state", async () => {
  const adapter = memoryAdapter({
    faultCategory: "",
    customerReasonConsistent: "否",
    warrantyStatus: "保外",
  });

  const result = await executeDetectionPrefillSafely(PLAN, adapter);

  assert.equal(result.valuesVerified, true);
  assert.equal(result.valuesRestored, true);
  assert.equal(result.confirmClicked, false);
  assert.equal(result.recloudModified, false);
  assert.deepEqual(Object.fromEntries(adapter.values), {
    faultCategory: "",
    customerReasonConsistent: "否",
    warrantyStatus: "保外",
  });
  assert.deepEqual(adapter.writes.slice(-3).map(([key]) => key), [
    "warrantyStatus",
    "customerReasonConsistent",
    "faultCategory",
  ]);
});

test("verification failure still restores every snapshotted field", async () => {
  const adapter = memoryAdapter(
    { faultCategory: "旧故障", customerReasonConsistent: "否", warrantyStatus: "保外" },
    {
      write(key, value, values) {
        if (key === "customerReasonConsistent" && value === "是") values.set(key, "否");
        else values.set(key, value);
      },
    }
  );

  await assert.rejects(executeDetectionPrefillSafely(PLAN, adapter), {
    code: "RECLOUD_DETECTION_PREFILL_VERIFY_FAILED",
    fieldKey: "customerReasonConsistent",
    phase: "VERIFY",
  });
  assert.deepEqual(Object.fromEntries(adapter.values), {
    faultCategory: "旧故障",
    customerReasonConsistent: "否",
    warrantyStatus: "保外",
  });
});

test("restore failure takes priority because the remote form may remain changed", async () => {
  let restoring = false;
  const adapter = memoryAdapter(
    { faultCategory: "旧故障", customerReasonConsistent: "否", warrantyStatus: "保外" },
    {
      write(key, value, values, writes) {
        restoring ||= writes.length > PLAN.safeWrites.length;
        if (restoring && key === "faultCategory") return;
        values.set(key, value);
      },
    }
  );

  await assert.rejects(executeDetectionPrefillSafely(PLAN, adapter), {
    code: "RECLOUD_DETECTION_PREFILL_RESTORE_FAILED",
    fieldKey: "faultCategory",
    phase: "RESTORE",
  });
});

test("incomplete plans are rejected before reading or writing controls", async () => {
  const adapter = memoryAdapter({ faultCategory: "旧值" });
  await assert.rejects(
    executeDetectionPrefillSafely({ safeWrites: [], missingFields: ["warrantyStatus"] }, adapter),
    { code: "RECLOUD_DETECTION_PREFILL_PLAN_INVALID", phase: "PLAN" }
  );
  assert.deepEqual(adapter.writes, []);
});
