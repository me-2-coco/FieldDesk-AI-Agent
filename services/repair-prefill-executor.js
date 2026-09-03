const { valuesMatch } = require("./detection-prefill-executor");

const REVERSIBLE_REPAIR_FIELDS = new Set([
  "faultClassification",
  "detectionResult",
  "responsibilityType",
  "repairMeasure",
  "highestRepairLevel",
  "customerPaidAmount",
  "logisticsAmount",
]);

function repairPrefillError(message, code, fieldKey, phase, cause) {
  const error = new Error(message);
  error.code = code;
  error.status = 502;
  error.fieldKey = fieldKey || "";
  error.phase = phase;
  if (cause) error.cause = cause;
  return error;
}

async function assertAdapterSafe(adapter) {
  if (typeof adapter.assertSafe === "function") await adapter.assertSafe();
}

async function executeRepairPrefillSafely(plan, adapter) {
  if (!plan || !Array.isArray(plan.safeWrites) || plan.missingFields?.length || plan.readyToPrefill === false) {
    throw repairPrefillError(
      "维修完工预填计划不完整，已停止演练",
      "RECLOUD_REPAIR_PREFILL_PLAN_INVALID",
      "",
      "PLAN"
    );
  }
  if (!adapter || typeof adapter.read !== "function" || typeof adapter.write !== "function") {
    throw repairPrefillError(
      "维修完工预填控件适配器不可用",
      "RECLOUD_REPAIR_PREFILL_ADAPTER_INVALID",
      "",
      "PLAN"
    );
  }

  const reversibleWrites = plan.safeWrites.filter((item) => REVERSIBLE_REPAIR_FIELDS.has(item.key));
  const deferredFields = plan.safeWrites
    .filter((item) => !REVERSIBLE_REPAIR_FIELDS.has(item.key))
    .map((item) => item.key);
  const snapshots = [];
  const writtenFields = [];
  const restoredFields = [];
  let primaryError = null;
  let restoreError = null;

  try {
    for (const field of Array.isArray(plan.verifyOnlyFields) ? plan.verifyOnlyFields : []) {
      const actual = await adapter.read(field.key);
      await assertAdapterSafe(adapter);
      if (!valuesMatch(actual, field.value)) {
        throw repairPrefillError(
          `维修前置字段 ${field.key} 与检测阶段不一致`,
          "RECLOUD_REPAIR_PREFILL_PRECONDITION_MISMATCH",
          field.key,
          "PRECONDITION"
        );
      }
    }
    for (const write of reversibleWrites) {
      const key = String(write.key || "").trim();
      if (!key) {
        throw repairPrefillError("维修预填字段缺少标识", "RECLOUD_REPAIR_PREFILL_PLAN_INVALID", key, "SNAPSHOT");
      }
      snapshots.push({ key, value: await adapter.read(key) });
      await assertAdapterSafe(adapter);
    }
    for (const write of reversibleWrites) {
      await adapter.write(write.key, write.value);
      await assertAdapterSafe(adapter);
      const actual = await adapter.read(write.key);
      if (!valuesMatch(actual, write.value)) {
        throw repairPrefillError(
          `维修字段 ${write.key} 写入校验失败`,
          "RECLOUD_REPAIR_PREFILL_VERIFY_FAILED",
          write.key,
          "VERIFY"
        );
      }
      writtenFields.push(write.key);
    }
  } catch (error) {
    primaryError = error;
  } finally {
    for (const snapshot of [...snapshots].reverse()) {
      try {
        await adapter.write(snapshot.key, snapshot.value);
        await assertAdapterSafe(adapter);
        if (!valuesMatch(await adapter.read(snapshot.key), snapshot.value)) {
          throw repairPrefillError(
            `维修字段 ${snapshot.key} 恢复校验失败`,
            "RECLOUD_REPAIR_PREFILL_RESTORE_FAILED",
            snapshot.key,
            "RESTORE"
          );
        }
        restoredFields.push(snapshot.key);
      } catch (error) {
        restoreError ||= repairPrefillError(
          `维修字段 ${snapshot.key} 恢复失败，已停止演练`,
          "RECLOUD_REPAIR_PREFILL_RESTORE_FAILED",
          snapshot.key,
          "RESTORE",
          error
        );
      }
    }
  }

  if (restoreError) {
    restoreError.primaryCode = primaryError?.code || "";
    restoreError.fieldsWritten = [...writtenFields];
    throw restoreError;
  }
  if (primaryError) throw primaryError;
  return {
    dryRun: true,
    fieldsPlanned: reversibleWrites.map((item) => item.key),
    fieldsWritten: writtenFields,
    fieldsRestored: restoredFields.reverse(),
    deferredFields,
    deferredActions: Array.isArray(plan.requiredActions)
      ? plan.requiredActions.map((item) => item.key)
      : [],
    valuesVerified: writtenFields.length === reversibleWrites.length,
    valuesRestored: restoredFields.length === snapshots.length,
    saveClicked: false,
    confirmClicked: false,
    confirmed: false,
    recloudModified: false,
  };
}

module.exports = {
  REVERSIBLE_REPAIR_FIELDS,
  executeRepairPrefillSafely,
};
