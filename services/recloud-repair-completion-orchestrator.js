const crypto = require("crypto");
const { buildRecloudRepairFormPlan } = require("../connectors/recloud-sync-mapping");
const { buildRecloudRepairPartsPlan } = require("./recloud-repair-parts-plan");
const { buildRecloudRepairAttachmentsPlan } = require("./recloud-repair-attachments-plan");

function orchestratorError(message, code, phase, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.status = code.endsWith("_DISABLED") ? 403 : 502;
  error.phase = phase;
  Object.assign(error, details);
  return error;
}

function repairCompletionFingerprint(orderKey, payload) {
  const stable = JSON.stringify({
    orderKey: String(orderKey || ""),
    faultLevel1: payload?.faultLevel1 || "",
    faultLevel2: payload?.faultLevel2 || "",
    faultLevel3: payload?.faultLevel3 || "",
    responsibilityType: payload?.responsibilityType || "",
    repairMeasure: payload?.repairMeasure || "",
    usedParts: payload?.usedParts || [],
    attachments: (payload?.attachments || []).map((item) => ({
      name: item.fileName || item.name || item.path || "",
      size: item.size || 0,
    })),
  });
  return crypto.createHash("sha256").update(stable).digest("hex");
}

async function saveCheckpoint(store, checkpoint) {
  if (store && typeof store.save === "function") await store.save(checkpoint);
}

async function waitForRemoteSubmitReady(adapter, options = {}) {
  if (typeof adapter.waitForSubmitReady === "function") {
    return adapter.waitForSubmitReady({
      timeoutMs: options.submitReadyTimeoutMs || 30_000,
      pollIntervalMs: options.submitReadyPollIntervalMs || 500,
    });
  }
  throw orchestratorError(
    "瑞云完工后状态等待执行器不可用",
    "RECLOUD_REPAIR_SUBMIT_READY_ADAPTER_INVALID",
    "WAIT_SUBMIT_READY"
  );
}

function validateRemotePlans(formPlan, partsPlan, attachmentsPlan) {
  const reasons = [];
  if (!formPlan.readyToPrefill) reasons.push({ step: "FORM", reason: "MISSING_FIELDS", fields: formPlan.missingFields });
  if (!partsPlan.readyToAdd) reasons.push({ step: "PARTS", reason: "REMOTE_CONFLICT", count: partsPlan.conflicts.length });
  if (!attachmentsPlan.readyToUpload) reasons.push({ step: "ATTACHMENTS", reason: "REMOTE_CONFLICT", count: attachmentsPlan.conflicts.length });
  return reasons;
}

async function orchestrateRepairCompletion(orderKey, payload, adapter, options = {}) {
  if (!adapter || typeof adapter.readRemoteState !== "function") {
    throw orchestratorError("维修完工编排适配器不可用", "RECLOUD_REPAIR_ORCHESTRATOR_ADAPTER_INVALID", "PLAN");
  }
  const fingerprint = repairCompletionFingerprint(orderKey, payload);
  const prior = options.checkpointStore?.load
    ? await options.checkpointStore.load(String(orderKey || ""))
    : null;
  const resumed = Boolean(prior && prior.fingerprint === fingerprint);
  const completedSteps = [];

  // 无论是否存在断点，都重新读取瑞云；断点不能替代远端核验。
  let remote = await adapter.readRemoteState();
  const formPlan = buildRecloudRepairFormPlan(payload);
  let partsPlan = buildRecloudRepairPartsPlan(payload.usedParts, remote.parts);
  let attachmentsPlan = buildRecloudRepairAttachmentsPlan(payload.attachments, remote.attachments);
  const reviewReasons = validateRemotePlans(formPlan, partsPlan, attachmentsPlan);
  if (reviewReasons.length) {
    await saveCheckpoint(options.checkpointStore, {
      orderKey, fingerprint, status: "MANUAL_REVIEW", completedSteps, reviewReasons,
    });
    return {
      status: "MANUAL_REVIEW",
      resumed,
      reviewReasons,
      finalConfirmClicked: false,
    };
  }

  if (options.writeEnabled !== true) {
    return {
      status: "READY_DRY_RUN",
      resumed,
      additions: {
        parts: partsPlan.additions.length,
        attachments: attachmentsPlan.additions.length,
      },
      skipped: {
        parts: partsPlan.skipped.length,
        attachments: attachmentsPlan.skipped.length,
      },
      finalConfirmClicked: false,
      recloudModified: false,
    };
  }

  if (partsPlan.additions.length) {
    if (typeof adapter.addParts !== "function") {
      throw orchestratorError("缺少配件新增执行器", "RECLOUD_REPAIR_PART_WRITE_ADAPTER_INVALID", "PARTS");
    }
    await adapter.addParts(partsPlan.additions);
    remote = await adapter.readRemoteState();
    partsPlan = buildRecloudRepairPartsPlan(payload.usedParts, remote.parts);
    if (!partsPlan.readyToAdd || partsPlan.additions.length) {
      throw orchestratorError("配件新增后远端复核失败", "RECLOUD_REPAIR_PART_POSTVERIFY_FAILED", "PARTS");
    }
  }
  completedSteps.push("PARTS_VERIFIED");
  await saveCheckpoint(options.checkpointStore, { orderKey, fingerprint, status: "RUNNING", completedSteps: [...completedSteps] });

  if (typeof adapter.applyRepairFields !== "function") {
    throw orchestratorError("缺少维修字段执行器", "RECLOUD_REPAIR_FIELD_WRITE_ADAPTER_INVALID", "FIELDS");
  }
  await adapter.applyRepairFields(formPlan);
  if (typeof adapter.verifyRepairFields !== "function" || !await adapter.verifyRepairFields(formPlan)) {
    throw orchestratorError("维修字段远端复核失败", "RECLOUD_REPAIR_FIELD_POSTVERIFY_FAILED", "FIELDS");
  }
  completedSteps.push("FIELDS_VERIFIED");
  await saveCheckpoint(options.checkpointStore, { orderKey, fingerprint, status: "RUNNING", completedSteps: [...completedSteps] });

  // 字段保存可能更新附件区域，上传前再次读取并重新规划。
  remote = await adapter.readRemoteState();
  attachmentsPlan = buildRecloudRepairAttachmentsPlan(payload.attachments, remote.attachments);
  if (!attachmentsPlan.readyToUpload) {
    throw orchestratorError("附件上传前远端状态冲突", "RECLOUD_REPAIR_ATTACHMENT_PRECHECK_FAILED", "ATTACHMENTS");
  }
  if (attachmentsPlan.additions.length) {
    if (typeof adapter.uploadAttachments !== "function") {
      throw orchestratorError("缺少附件上传执行器", "RECLOUD_REPAIR_ATTACHMENT_WRITE_ADAPTER_INVALID", "ATTACHMENTS");
    }
    await adapter.uploadAttachments(attachmentsPlan);
    remote = await adapter.readRemoteState();
    attachmentsPlan = buildRecloudRepairAttachmentsPlan(payload.attachments, remote.attachments);
    if (!attachmentsPlan.readyToUpload || attachmentsPlan.additions.length) {
      throw orchestratorError("附件上传后远端复核失败", "RECLOUD_REPAIR_ATTACHMENT_POSTVERIFY_FAILED", "ATTACHMENTS");
    }
  }
  completedSteps.push("ATTACHMENTS_VERIFIED");
  await saveCheckpoint(options.checkpointStore, {
    orderKey, fingerprint, status: "READY_TO_COMPLETE", completedSteps: [...completedSteps],
  });

  if (typeof adapter.clickComplete !== "function") {
    throw orchestratorError("缺少瑞云完工按钮执行器", "RECLOUD_REPAIR_COMPLETE_ADAPTER_INVALID", "COMPLETE");
  }
  await adapter.clickComplete();
  completedSteps.push("COMPLETE_CLICKED");
  await saveCheckpoint(options.checkpointStore, {
    orderKey, fingerprint, status: "WAITING_SUBMIT_READY", completedSteps: [...completedSteps],
  });

  const submitReady = await waitForRemoteSubmitReady(adapter, options);
  if (!submitReady) {
    throw orchestratorError("瑞云点击完工后未进入可提交状态", "RECLOUD_REPAIR_SUBMIT_NOT_READY", "WAIT_SUBMIT_READY");
  }
  completedSteps.push("SUBMIT_READY");

  if (typeof adapter.clickSubmit !== "function") {
    throw orchestratorError("缺少瑞云提交按钮执行器", "RECLOUD_REPAIR_SUBMIT_ADAPTER_INVALID", "SUBMIT");
  }
  await adapter.clickSubmit();
  if (typeof adapter.verifySubmitted !== "function" || !await adapter.verifySubmitted()) {
    throw orchestratorError("瑞云提交后未确认工单已锁定", "RECLOUD_REPAIR_SUBMIT_POSTVERIFY_FAILED", "SUBMIT_VERIFY");
  }
  completedSteps.push("SUBMIT_VERIFIED");
  await saveCheckpoint(options.checkpointStore, {
    orderKey, fingerprint, status: "SUCCESS", completedSteps: [...completedSteps],
  });
  return {
    status: "SUCCESS",
    resumed,
    completedSteps,
    completeClicked: true,
    finalConfirmClicked: true,
    remoteLocked: true,
  };
}

module.exports = {
  repairCompletionFingerprint,
  validateRemotePlans,
  orchestrateRepairCompletion,
};
