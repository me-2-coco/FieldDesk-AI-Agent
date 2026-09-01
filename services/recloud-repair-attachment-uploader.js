const { buildRecloudRepairAttachmentsPlan } = require("./recloud-repair-attachments-plan");

function uploadError(message, code, phase, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.status = code === "RECLOUD_REPAIR_ATTACHMENT_UPLOAD_DISABLED" ? 403 : 502;
  error.phase = phase;
  Object.assign(error, details);
  return error;
}

function assertQueueMatches(expected, observed, phase) {
  const comparison = buildRecloudRepairAttachmentsPlan(expected, observed);
  if (
    !comparison.readyToUpload ||
    comparison.additions.length > 0 ||
    comparison.skipped.length !== expected.length
  ) {
    throw uploadError(
      phase === "STAGE" ? "完工附件没有完整进入待上传队列" : "上传后瑞云附件列表核验失败",
      phase === "STAGE" ? "RECLOUD_REPAIR_ATTACHMENT_STAGE_MISMATCH" : "RECLOUD_REPAIR_ATTACHMENT_POSTVERIFY_FAILED",
      phase,
      {
        missingCount: comparison.additions.length,
        conflictCount: comparison.conflicts.length,
      }
    );
  }
}

async function executeRecloudRepairAttachmentUpload(plan, adapter, options = {}) {
  if (options.writeEnabled !== true) {
    throw uploadError(
      "完工附件上传未开启，禁止执行真实上传",
      "RECLOUD_REPAIR_ATTACHMENT_UPLOAD_DISABLED",
      "PLAN"
    );
  }
  if (!plan || plan.readyToUpload !== true || !Array.isArray(plan.additions) || plan.conflicts?.length) {
    throw uploadError(
      "完工附件上传计划存在冲突",
      "RECLOUD_REPAIR_ATTACHMENT_UPLOAD_PLAN_INVALID",
      "PLAN"
    );
  }
  if (!adapter || ["stage", "readStaged", "upload", "readExisting"].some((method) => typeof adapter[method] !== "function")) {
    throw uploadError(
      "完工附件上传适配器不可用",
      "RECLOUD_REPAIR_ATTACHMENT_UPLOAD_ADAPTER_INVALID",
      "PLAN"
    );
  }
  const additions = plan.additions;
  if (!additions.length) {
    return {
      uploadedCount: 0,
      alreadyComplete: true,
      uploadClicked: false,
      finalConfirmClicked: false,
    };
  }
  if (additions.length > 1 && typeof adapter.supportsMultiple === "function" && !await adapter.supportsMultiple()) {
    throw uploadError(
      "瑞云附件窗口不支持多选，禁止只上传部分文件",
      "RECLOUD_REPAIR_ATTACHMENT_MULTISELECT_REQUIRED",
      "STAGE"
    );
  }

  await adapter.stage(additions);
  if (typeof adapter.assertSafeBeforeUpload === "function") await adapter.assertSafeBeforeUpload();
  assertQueueMatches(additions, await adapter.readStaged(), "STAGE");

  try {
    await adapter.upload();
  } catch (cause) {
    throw uploadError(
      "完工附件上传结果未知，禁止自动重试以免重复",
      "RECLOUD_REPAIR_ATTACHMENT_UPLOAD_UNCERTAIN",
      "UPLOAD",
      { cause }
    );
  }
  assertQueueMatches(additions, await adapter.readExisting(), "POSTVERIFY");
  return {
    uploadedCount: additions.length,
    alreadyComplete: false,
    uploadClicked: true,
    uploadVerified: true,
    autoRetryAttempted: false,
    finalConfirmClicked: false,
  };
}

module.exports = {
  assertQueueMatches,
  executeRecloudRepairAttachmentUpload,
};
