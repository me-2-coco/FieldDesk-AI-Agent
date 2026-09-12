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
    // Reconciliation must also reject changes in pricing, treatment mode,
    // attachment identity and any newly added command field.
    commandPayload: payload || {},
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

async function readRemoteAttachments(adapter, target = "附件") {
  if (typeof adapter.readRemoteAttachments === "function") {
    return adapter.readRemoteAttachments({ target });
  }
  const remote = await adapter.readRemoteState();
  return target === "附件（检测报告）" ? remote.detectionReportAttachments || [] : remote.attachments || [];
}

function informationClerkActionFor(payload = {}) {
  return String(payload.treatmentMode || "").trim() === "INSPECTION_ONLY"
    ? "开检测报告、上传检测报告、修改地址并提交"
    : "核对维修资料并提交";
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
  // A checkpoint survives process loss. Legacy name/size matches are not
  // sufficient proof that this particular upload was durably accepted.
  if (prior?.status === 'ATTACHMENTS_UPLOADING') {
    throw orchestratorError('上次维修附件上传结果未确认，需核对后恢复；未重复上传',
      'RECLOUD_REPAIR_ATTACHMENT_UPLOAD_UNCERTAIN', 'RECONCILE', { resultUnknown: true, permanent: true });
  }
  if (prior?.status === "SUBMITTING" && remote.completed !== true) {
    throw orchestratorError("上次瑞云提交尚未确认，需核对后恢复", "RECLOUD_REPAIR_SUBMIT_RESULT_UNKNOWN", "RECONCILE", {
      resultUnknown: true, permanent: true,
    });
  }
  const assignmentPlan = buildRecloudAssignmentPlan(payload.assignee);
  let assignmentRequired = String(remote.assignee || "").replace(/\s/g, "") !== assignmentPlan.servicePerson.replace(/\s/g, "");
  const formPlan = buildRecloudRepairFormPlan(payload);
  const authorizedExistingPartCodes = Array.isArray(options.authorizedExistingPartCodes)
    ? options.authorizedExistingPartCodes
    : [];
  let partsPlan = buildRecloudRepairPartsPlan(payload.usedParts, remote.parts, {
    authorizedExistingPartCodes,
  });
  // 检测报告由信息员人工制作并上传；即使历史草稿仍带有系统报告附件，
  // FieldDesk 完工编排也不得把它写入瑞云。
  const desiredMainAttachments = (payload.attachments || []).filter((item) => item?.source !== "INSPECTION_REPORT");
  let attachmentsPlan = buildRecloudRepairAttachmentsPlan(desiredMainAttachments, remote.attachments);
  const knownMissingParts = Array.isArray(options.missingParts) ? [...options.missingParts] : [];
  // Every unavailable part follows the same terminal rule: omit that part,
  // finish the service report, click Complete, never click Submit, and hand
  // the order to the information clerk.
  const blockingMissingParts = () => knownMissingParts;
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
      partsPlan = buildRecloudRepairPartsPlan(payload.usedParts, remote.parts, {
        authorizedExistingPartCodes,
      });
      skippedAuthorizedMissingParts = partsPlan.additions.length > 0
        && unapprovedMissingParts().length === 0;
      preparationVerifiedByRemote = partsPlan.readyToAdd
        && (partsPlan.additions.length === 0 || skippedAuthorizedMissingParts)
        && String(remote.assignee || "").replace(/\s/g, "") === assignmentPlan.servicePerson.replace(/\s/g, "");
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

  // 瑞云会在没有维修附件时拒绝保存整张服务报告。必须先上传附件，
  // 再写费用与维修字段，否则字段保存失败、附件步骤又永远无法执行。
  let remoteAttachments = await readRemoteAttachments(adapter, RECLOUD_WORK_ORDER_OPERATION_POLICY.attachmentTarget);
  attachmentsPlan = buildRecloudRepairAttachmentsPlan(desiredMainAttachments, remoteAttachments);
  if (!attachmentsPlan.readyToUpload) {
    throw orchestratorError("附件上传前远端状态冲突", "RECLOUD_REPAIR_ATTACHMENT_PRECHECK_FAILED", "ATTACHMENTS");
  }
  if (attachmentsPlan.additions.length) {
    if (typeof adapter.uploadAttachments !== "function") {
      throw orchestratorError("缺少附件上传执行器", "RECLOUD_REPAIR_ATTACHMENT_WRITE_ADAPTER_INVALID", "ATTACHMENTS");
    }
    assertRecloudOperationAllowed({ action: "上传附件", target: RECLOUD_WORK_ORDER_OPERATION_POLICY.attachmentTarget });
    await saveCheckpoint(options.checkpointStore, {
      orderKey, fingerprint, status: 'ATTACHMENTS_UPLOADING', completedSteps: [...completedSteps],
    });
    try {
      await adapter.uploadAttachments(attachmentsPlan, {
        target: RECLOUD_WORK_ORDER_OPERATION_POLICY.attachmentTarget,
      });
      remoteAttachments = await readRemoteAttachments(adapter, RECLOUD_WORK_ORDER_OPERATION_POLICY.attachmentTarget);
      attachmentsPlan = buildRecloudRepairAttachmentsPlan(desiredMainAttachments, remoteAttachments);
      if (!attachmentsPlan.readyToUpload || attachmentsPlan.additions.length) {
        throw orchestratorError("附件上传后远端复核失败", "RECLOUD_REPAIR_ATTACHMENT_POSTVERIFY_FAILED", "ATTACHMENTS");
      }
      // Do not clear the in-flight marker until remote verification AND local
      // checkpoint persistence have succeeded.
      await saveCheckpoint(options.checkpointStore, {
        orderKey, fingerprint, status: 'RUNNING', completedSteps: [...completedSteps, 'ATTACHMENTS_VERIFIED'],
      });
    } catch (cause) {
      throw orchestratorError('维修附件上传或保存后的结果未核实，禁止重复上传',
        'RECLOUD_REPAIR_ATTACHMENT_UPLOAD_UNCERTAIN', 'ATTACHMENTS', { cause, resultUnknown: true, permanent: true });
    }
  }
  completedSteps.push("ATTACHMENTS_VERIFIED");
  await saveCheckpoint(options.checkpointStore, {
    orderKey, fingerprint, status: "RUNNING", completedSteps: [...completedSteps],
  });

  if (typeof adapter.applyRepairFields !== "function") {
    throw orchestratorError("缺少维修字段执行器", "RECLOUD_REPAIR_FIELD_WRITE_ADAPTER_INVALID", "FIELDS");
  }
  await adapter.applyRepairFields(formPlan);
  let repairFieldsVerified = false;
  if (typeof adapter.verifyRepairFields === "function") {
    const verificationAttempts = Math.max(1, Number(options.fieldVerificationAttempts || 5));
    const verificationIntervalMs = Math.max(0, Number(options.fieldVerificationIntervalMs || 500));
    for (let attempt = 0; attempt < verificationAttempts; attempt += 1) {
      repairFieldsVerified = await adapter.verifyRepairFields(formPlan);
      if (repairFieldsVerified) break;
      if (attempt + 1 < verificationAttempts && verificationIntervalMs > 0) {
        if (typeof adapter.waitForTimeout === "function") {
          await adapter.waitForTimeout(verificationIntervalMs);
        } else {
          await new Promise((resolve) => setTimeout(resolve, verificationIntervalMs));
        }
      }
    }
  }
  if (!repairFieldsVerified) {
    throw orchestratorError("维修字段远端复核失败", "RECLOUD_REPAIR_FIELD_POSTVERIFY_FAILED", "FIELDS");
  }
  completedSteps.push("FIELDS_VERIFIED");
  await saveCheckpoint(options.checkpointStore, { orderKey, fingerprint, status: "RUNNING", completedSteps: [...completedSteps] });
  await saveCheckpoint(options.checkpointStore, {
    orderKey, fingerprint, status: "READY_TO_COMPLETE", completedSteps: [...completedSteps],
  });

  if (remote.completed === true) {
    completedSteps.push("REMOTE_ALREADY_COMPLETED");
    if (blockingMissingParts().length) {
      completedSteps.push("SUBMIT_SKIPPED_FOR_PARTS_SHORTAGE");
      await saveCheckpoint(options.checkpointStore, {
        orderKey, fingerprint, status: "AWAITING_PARTS", completedSteps: [...completedSteps], missingParts: blockingMissingParts(),
      });
      return {
        status: "AWAITING_PARTS",
        resumed,
        completedSteps,
        missingParts: blockingMissingParts(),
        completeClicked: false,
        remoteAlreadyCompleted: true,
        finalConfirmClicked: false,
        stoppedBeforeSubmit: true,
      };
    }
    if (payload.treatmentMode === "INSPECTION_ONLY") {
      completedSteps.push("SUBMIT_RESERVED_FOR_INFORMATION_CLERK");
      await saveCheckpoint(options.checkpointStore, {
        orderKey, fingerprint, status: "AWAITING_INFORMATION_CLERK", completedSteps: [...completedSteps],
      });
      return {
        status: "AWAITING_INFORMATION_CLERK",
        resumed,
        completedSteps,
        completeClicked: false,
        finalConfirmClicked: false,
        remoteAlreadyCompleted: true,
        stoppedBeforeSubmit: true,
        informationClerkAction: informationClerkActionFor(payload),
      };
    }
    await saveCheckpoint(options.checkpointStore, {
      orderKey, fingerprint, status: "SUCCESS", completedSteps: [...completedSteps],
    });
    return {
      status: "SUCCESS",
      resumed,
      completedSteps,
      finalConfirmClicked: false,
      remoteAlreadyCompleted: true,
      recloudModified: true,
    };
  }

  if (typeof adapter.clickComplete !== "function") {
    throw orchestratorError("缺少瑞云完工按钮执行器", "RECLOUD_REPAIR_COMPLETE_ADAPTER_INVALID", "COMPLETE");
  }
  await adapter.clickComplete();
  completedSteps.push("COMPLETE_CLICKED");
  if (blockingMissingParts().length) {
    completedSteps.push("SUBMIT_SKIPPED_FOR_PARTS_SHORTAGE");
    await saveCheckpoint(options.checkpointStore, {
      orderKey, fingerprint, status: "AWAITING_PARTS", completedSteps: [...completedSteps], missingParts: blockingMissingParts(),
    });
    return {
      status: "AWAITING_PARTS",
      resumed,
      completedSteps,
      missingParts: blockingMissingParts(),
      completeClicked: true,
      finalConfirmClicked: false,
      stoppedBeforeSubmit: true,
    };
  }
  if (payload.treatmentMode === "INSPECTION_ONLY") {
    completedSteps.push("SUBMIT_RESERVED_FOR_INFORMATION_CLERK");
    await saveCheckpoint(options.checkpointStore, {
      orderKey, fingerprint, status: "AWAITING_INFORMATION_CLERK", completedSteps: [...completedSteps],
    });
    return {
      status: "AWAITING_INFORMATION_CLERK",
      resumed,
      completedSteps,
      completeClicked: true,
      finalConfirmClicked: false,
      stoppedBeforeSubmit: true,
      informationClerkAction: informationClerkActionFor(payload),
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

  const isOutOfWarranty = String(payload.pricing?.warrantyStatus || "").trim() === "OUT_OF_WARRANTY"
    || String(payload.responsibilityType || "").includes("保外");
  const oldPartLabelParts = (payload.usedParts || []).filter((part) => part?.returnRequired === true);
  if (!isOutOfWarranty && oldPartLabelParts.length > 0) {
    if (typeof adapter.printOldPartLabels !== "function") {
      throw orchestratorError("缺少旧件标签打印执行器", "RECLOUD_OLD_PART_LABEL_ADAPTER_INVALID", "OLD_PART_LABELS");
    }
    await adapter.printOldPartLabels(oldPartLabelParts);
    completedSteps.push("OLD_PART_LABELS_QUEUED");
  }

  if (typeof adapter.clickSubmit !== "function") {
    throw orchestratorError("缺少瑞云提交按钮执行器", "RECLOUD_REPAIR_SUBMIT_ADAPTER_INVALID", "SUBMIT");
  }
  // Persist intent before the irreversible action. A failure after entering
  // clickSubmit is not evidence that Recloud rejected the submission.
  await saveCheckpoint(options.checkpointStore, {
    orderKey, fingerprint, status: "SUBMITTING", completedSteps: [...completedSteps],
  });
  try {
    await adapter.clickSubmit({
      approvalFlow: RECLOUD_WORK_ORDER_OPERATION_POLICY.approvalFlow,
      terminalAction: RECLOUD_WORK_ORDER_OPERATION_POLICY.terminalAction,
      stopImmediately: true,
    });
    completedSteps.push("SUBMIT_CLICKED_STOPPED");
    await saveCheckpoint(options.checkpointStore, {
      orderKey, fingerprint, status: "SUCCESS", completedSteps: [...completedSteps],
    });
  } catch (cause) {
    throw orchestratorError("瑞云提交结果需要核对，禁止直接重复提交", "RECLOUD_REPAIR_SUBMIT_RESULT_UNKNOWN", "SUBMIT", {
      resultUnknown: true, permanent: true, cause,
    });
  }
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
