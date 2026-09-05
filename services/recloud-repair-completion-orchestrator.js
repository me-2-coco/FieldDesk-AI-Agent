const crypto = require("crypto");
const { buildRecloudRepairFormPlan } = require("../connectors/recloud-sync-mapping");
const { buildRecloudRepairPartsPlan } = require("./recloud-repair-parts-plan");
const { buildRecloudRepairAttachmentsPlan } = require("./recloud-repair-attachments-plan");
const {
  RECLOUD_WORK_ORDER_OPERATION_POLICY,
  buildRecloudAssignmentPlan,
  assertRecloudOperationAllowed,
} = require("./recloud-work-order-operation-policy");

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
    assignee: payload?.assignee || "",
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

async function readRemoteAttachments(adapter) {
  if (typeof adapter.readRemoteAttachments === "function") {
    return adapter.readRemoteAttachments();
  }
  const remote = await adapter.readRemoteState();
  return remote.attachments || [];
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
  const assignmentPlan = buildRecloudAssignmentPlan(payload.assignee);
  let assignmentRequired = String(remote.assignee || "").trim() !== assignmentPlan.servicePerson;
  const formPlan = buildRecloudRepairFormPlan(payload);
  let partsPlan = buildRecloudRepairPartsPlan(payload.usedParts, remote.parts);
  let attachmentsPlan = buildRecloudRepairAttachmentsPlan(payload.attachments, remote.attachments);
  const knownMissingParts = Array.isArray(options.missingParts) ? [...options.missingParts] : [];
  const authorizedSkippedPartCodes = new Set(
    [...(Array.isArray(options.authorizedSkippedPartCodes) ? options.authorizedSkippedPartCodes : []),
      ...knownMissingParts.map((part) => part?.partCode)]
      .map((value) => String(value || "").trim().toUpperCase())
      .filter(Boolean)
  );
  const unapprovedMissingParts = () => partsPlan.additions.filter(
    (part) => !authorizedSkippedPartCodes.has(String(part.partCode || "").trim().toUpperCase())
  );
  let skippedAuthorizedMissingParts = partsPlan.additions.length > 0
    && unapprovedMissingParts().length === 0;
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
        assignment: assignmentRequired,
        parts: partsPlan.additions.length,
        attachments: attachmentsPlan.additions.length,
      },
      skipped: {
        assignment: !assignmentRequired,
        parts: partsPlan.skipped.length,
        attachments: attachmentsPlan.skipped.length,
      },
      finalConfirmClicked: false,
      recloudModified: false,
    };
  }

  // 改派和配件只能在首次点击“维修”进入服务单时完成。若首次进入时
  // FieldDesk 在最后的页面等待环节超时，但瑞云实际已保存成功，则允许
  // 依据当前瑞云页面重新核对结果；这里只复核，绝不补改派或补加配件。
  let preparationVerifiedByRemote = !assignmentRequired
    && partsPlan.readyToAdd
    && (partsPlan.additions.length === 0 || skippedAuthorizedMissingParts);
  if (options.preparationCompleted !== true && !preparationVerifiedByRemote) {
    if (assignmentRequired) {
      throw orchestratorError(
        "维修启动记录未确认，且瑞云当前负责人与 FieldDesk 不一致",
        "RECLOUD_REPAIR_PREPARATION_ASSIGNEE_MISMATCH",
        "PREPARATION_VERIFY"
      );
    }
    if (!partsPlan.readyToAdd) {
      throw orchestratorError(
        "维修启动记录未确认，且瑞云当前配件明细与 FieldDesk 冲突",
        "RECLOUD_REPAIR_PREPARATION_PARTS_CONFLICT",
        "PREPARATION_VERIFY"
      );
    }
    const recoveryAdditions = unapprovedMissingParts();
    if (recoveryAdditions.length === 0) {
      preparationVerifiedByRemote = true;
    } else if (options.allowPreparationRecovery !== true) {
      throw orchestratorError(
        "维修启动记录未确认，且瑞云缺少 FieldDesk 已领用配件",
        "RECLOUD_REPAIR_PREPARATION_PARTS_MISSING",
        "PREPARATION_VERIFY"
      );
    }
    if (!preparationVerifiedByRemote && typeof adapter.addParts !== "function") {
      throw orchestratorError(
        "缺少维修准备配件恢复执行器",
        "RECLOUD_REPAIR_PREPARATION_PART_WRITE_ADAPTER_INVALID",
        "PREPARATION_RECOVERY"
      );
    }
    if (!preparationVerifiedByRemote) {
      assertRecloudOperationAllowed({ action: "直接输入编码", target: RECLOUD_WORK_ORDER_OPERATION_POLICY.partEntryTarget });
      const addResult = await adapter.addParts(recoveryAdditions, {
        entryMode: RECLOUD_WORK_ORDER_OPERATION_POLICY.partEntryMode,
        target: RECLOUD_WORK_ORDER_OPERATION_POLICY.partEntryTarget,
        forbiddenAction: RECLOUD_WORK_ORDER_OPERATION_POLICY.forbiddenPartLookup,
      });
      remote = await adapter.readRemoteState();
      for (const part of (Array.isArray(addResult?.missingParts) ? addResult.missingParts : [])) {
        const code = String(part?.partCode || "").trim().toUpperCase();
        if (code) authorizedSkippedPartCodes.add(code);
        if (code && !knownMissingParts.some((item) => String(item?.partCode || "").trim().toUpperCase() === code)) {
          knownMissingParts.push(part);
        }
      }
      partsPlan = buildRecloudRepairPartsPlan(payload.usedParts, remote.parts);
      skippedAuthorizedMissingParts = partsPlan.additions.length > 0
        && unapprovedMissingParts().length === 0;
      preparationVerifiedByRemote = partsPlan.readyToAdd
        && (partsPlan.additions.length === 0 || skippedAuthorizedMissingParts)
        && String(remote.assignee || "").trim() === assignmentPlan.servicePerson;
      if (!preparationVerifiedByRemote) {
        throw orchestratorError(
          "补录维修配件后瑞云远端复核失败",
          "RECLOUD_REPAIR_PREPARATION_PARTS_POSTVERIFY_FAILED",
          "PREPARATION_RECOVERY"
        );
      }
    }
  }
  if (assignmentRequired) {
    throw orchestratorError("维修启动阶段的负责人远端复核失败", "RECLOUD_REPAIR_PREPARATION_ASSIGNEE_MISMATCH", "PREPARATION_VERIFY");
  }
  completedSteps.push("ASSIGNEE_VERIFIED");
  await saveCheckpoint(options.checkpointStore, { orderKey, fingerprint, status: "RUNNING", completedSteps: [...completedSteps] });

  if (!partsPlan.readyToAdd || unapprovedMissingParts().length) {
    throw orchestratorError("维修启动阶段的配件远端复核失败", "RECLOUD_REPAIR_PREPARATION_PARTS_MISMATCH", "PREPARATION_VERIFY");
  }
  completedSteps.push(skippedAuthorizedMissingParts ? "PARTS_VERIFIED_WITH_AUTHORIZED_SKIP" : "PARTS_VERIFIED");
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

  // 字段保存可能更新附件区域，上传前只重读附件。负责人和配件已在
  // 上面完成远端复核，不再重复扫描整张服务单。
  let remoteAttachments = await readRemoteAttachments(adapter);
  attachmentsPlan = buildRecloudRepairAttachmentsPlan(payload.attachments, remoteAttachments);
  if (!attachmentsPlan.readyToUpload) {
    throw orchestratorError("附件上传前远端状态冲突", "RECLOUD_REPAIR_ATTACHMENT_PRECHECK_FAILED", "ATTACHMENTS");
  }
  if (attachmentsPlan.additions.length) {
    if (typeof adapter.uploadAttachments !== "function") {
      throw orchestratorError("缺少附件上传执行器", "RECLOUD_REPAIR_ATTACHMENT_WRITE_ADAPTER_INVALID", "ATTACHMENTS");
    }
    assertRecloudOperationAllowed({ action: "上传附件", target: RECLOUD_WORK_ORDER_OPERATION_POLICY.attachmentTarget });
    await adapter.uploadAttachments(attachmentsPlan, {
      target: RECLOUD_WORK_ORDER_OPERATION_POLICY.attachmentTarget,
      forbiddenTarget: RECLOUD_WORK_ORDER_OPERATION_POLICY.forbiddenAttachmentTarget,
    });
    remoteAttachments = await readRemoteAttachments(adapter);
    attachmentsPlan = buildRecloudRepairAttachmentsPlan(payload.attachments, remoteAttachments);
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
  if (knownMissingParts.length) {
    completedSteps.push("SUBMIT_SKIPPED_FOR_PARTS_SHORTAGE");
    await saveCheckpoint(options.checkpointStore, {
      orderKey, fingerprint, status: "AWAITING_PARTS", completedSteps: [...completedSteps], missingParts: knownMissingParts,
    });
    return {
      status: "AWAITING_PARTS",
      resumed,
      completedSteps,
      missingParts: knownMissingParts,
      completeClicked: true,
      finalConfirmClicked: false,
      stoppedBeforeSubmit: true,
    };
  }
  await saveCheckpoint(options.checkpointStore, {
    orderKey, fingerprint, status: "WAITING_SUBMIT_READY", completedSteps: [...completedSteps],
  });

  const submitReady = await waitForRemoteSubmitReady(adapter, options);
  if (!submitReady) {
    throw orchestratorError("瑞云点击完工后未进入可提交状态", "RECLOUD_REPAIR_SUBMIT_NOT_READY", "WAIT_SUBMIT_READY");
  }
  completedSteps.push("SUBMIT_READY");

  const hasOldPartLabels = (payload.usedParts || []).some((part) => part?.returnRequired === true);
  if (hasOldPartLabels) {
    if (typeof adapter.printOldPartLabels !== "function") {
      throw orchestratorError("缺少旧件标签打印执行器", "RECLOUD_OLD_PART_LABEL_ADAPTER_INVALID", "OLD_PART_LABELS");
    }
    await adapter.printOldPartLabels(payload.usedParts.filter((part) => part?.returnRequired === true));
    completedSteps.push("OLD_PART_LABELS_PRINTED");
  }

  if (typeof adapter.clickSubmit !== "function") {
    throw orchestratorError("缺少瑞云提交按钮执行器", "RECLOUD_REPAIR_SUBMIT_ADAPTER_INVALID", "SUBMIT");
  }
  await adapter.clickSubmit({
    approvalFlow: RECLOUD_WORK_ORDER_OPERATION_POLICY.approvalFlow,
    terminalAction: RECLOUD_WORK_ORDER_OPERATION_POLICY.terminalAction,
    stopImmediately: true,
  });
  // 点击签核流程中的“提交”即为本单终点。提交后禁止打开审批历史、
  // 打印预览或其它页面做额外核验，避免完成后继续误操作。
  completedSteps.push("SUBMIT_CLICKED_STOPPED");
  await saveCheckpoint(options.checkpointStore, {
    orderKey, fingerprint, status: "SUCCESS", completedSteps: [...completedSteps],
  });
  return {
    status: "SUCCESS",
    resumed,
    completedSteps,
    completeClicked: true,
    finalConfirmClicked: true,
    stoppedImmediatelyAfterSubmit: true,
    postSubmitActions: 0,
  };
}

module.exports = {
  repairCompletionFingerprint,
  validateRemotePlans,
  orchestrateRepairCompletion,
};
