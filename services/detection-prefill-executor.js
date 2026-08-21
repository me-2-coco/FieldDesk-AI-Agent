function normalizeComparable(value) {
  if (Array.isArray(value)) return value.map(normalizeComparable);
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function valuesMatch(actual, expected) {
  return JSON.stringify(normalizeComparable(actual)) === JSON.stringify(normalizeComparable(expected));
}

function createExecutionError(message, code, fieldKey, phase, cause) {
  const error = new Error(message);
  error.code = code;
  error.status = 502;
  error.fieldKey = fieldKey || "";
  error.phase = phase;
  if (cause) error.cause = cause;
  return error;
}

async function executeDetectionPrefillSafely(plan, controlAdapter) {
  if (!plan || !Array.isArray(plan.safeWrites) || plan.missingFields?.length) {
    throw createExecutionError(
      "检测预填计划不完整，已停止演练",
      "RECLOUD_DETECTION_PREFILL_PLAN_INVALID",
      "",
      "PLAN"
    );
  }
  if (!controlAdapter || typeof controlAdapter.read !== "function" || typeof controlAdapter.write !== "function") {
    throw createExecutionError(
      "检测预填控件适配器不可用",
      "RECLOUD_DETECTION_PREFILL_ADAPTER_INVALID",
      "",
      "PLAN"
    );
  }

  const snapshots = [];
  const writtenFields = [];
  const restoredFields = [];
  let primaryError = null;
  let restoreError = null;

  try {
    for (const write of plan.safeWrites) {
      const key = String(write.key || "").trim();
      if (!key) {
        throw createExecutionError(
          "检测预填字段缺少标识",
          "RECLOUD_DETECTION_PREFILL_PLAN_INVALID",
          key,
          "SNAPSHOT"
        );
      }
      snapshots.push({ key, value: await controlAdapter.read(key) });
    }

    for (const write of plan.safeWrites) {
      const key = String(write.key || "").trim();
      await controlAdapter.write(key, write.value);
      const actual = await controlAdapter.read(key);
      if (!valuesMatch(actual, write.value)) {
        throw createExecutionError(
          `检测字段 ${key} 写入校验失败`,
          "RECLOUD_DETECTION_PREFILL_VERIFY_FAILED",
          key,
          "VERIFY"
        );
      }
      writtenFields.push(key);
    }
  } catch (error) {
    primaryError = error;
  } finally {
    for (const snapshot of [...snapshots].reverse()) {
      try {
        await controlAdapter.write(snapshot.key, snapshot.value);
        const actual = await controlAdapter.read(snapshot.key);
        if (!valuesMatch(actual, snapshot.value)) {
          throw createExecutionError(
            `检测字段 ${snapshot.key} 恢复校验失败`,
            "RECLOUD_DETECTION_PREFILL_RESTORE_FAILED",
            snapshot.key,
            "RESTORE"
          );
        }
        restoredFields.push(snapshot.key);
      } catch (error) {
        restoreError ||= createExecutionError(
          `检测字段 ${snapshot.key} 恢复失败，已停止演练`,
          "RECLOUD_DETECTION_PREFILL_RESTORE_FAILED",
          snapshot.key,
          "RESTORE",
          error
        );
      }
    }
  }

  if (restoreError) throw restoreError;
  if (primaryError) throw primaryError;
  return {
    dryRun: true,
    fieldsPlanned: plan.safeWrites.map((write) => write.key),
    fieldsWritten: writtenFields,
    fieldsRestored: restoredFields.reverse(),
    valuesVerified: writtenFields.length === plan.safeWrites.length,
    valuesRestored: restoredFields.length === snapshots.length,
    confirmClicked: false,
    confirmed: false,
    recloudModified: false,
  };
}

module.exports = {
  normalizeComparable,
  valuesMatch,
  executeDetectionPrefillSafely,
};
