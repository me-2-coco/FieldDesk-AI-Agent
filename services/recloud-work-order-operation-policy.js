const RECLOUD_WORK_ORDER_OPERATION_POLICY = Object.freeze({
  receiptAction: "签收",
  forbiddenReceiptAction: "代客户收件",
  assignmentAction: "负责人",
  forbiddenAssignmentAction: "协助",
  partEntryMode: "DIRECT_CODE_INPUT",
  partEntryTarget: "新件名称",
  forbiddenPartLookup: "放大镜",
  attachmentTarget: "附件",
  forbiddenAttachmentTarget: "附件（检测报告）",
  excludedTargets: Object.freeze(["责任判定", "品质描述"]),
  troubleshootingValue: "否",
  approvalFlow: "内部维修单自动审批（成都欣益）",
  terminalAction: "提交",
});

function policyError(message, code, target = "") {
  const error = new Error(message);
  error.code = code;
  error.status = 409;
  error.target = target;
  return error;
}

function buildRecloudAssignmentPlan(assignee) {
  const servicePerson = String(assignee || "").trim();
  if (!servicePerson) {
    throw policyError("改派缺少目标师傅", "RECLOUD_ASSIGNMENT_ASSIGNEE_REQUIRED");
  }
  return {
    servicePerson,
    action: RECLOUD_WORK_ORDER_OPERATION_POLICY.assignmentAction,
    forbiddenAction: RECLOUD_WORK_ORDER_OPERATION_POLICY.forbiddenAssignmentAction,
  };
}

function assertRecloudOperationAllowed(operation = {}) {
  const action = String(operation.action || "").trim();
  const target = String(operation.target || "").trim();
  if (action === RECLOUD_WORK_ORDER_OPERATION_POLICY.forbiddenReceiptAction) {
    throw policyError("禁止点击代客户收件，只能点击RMA明细行内签收", "RECLOUD_RECEIPT_ACTION_FORBIDDEN", action);
  }
  if (action === RECLOUD_WORK_ORDER_OPERATION_POLICY.forbiddenAssignmentAction) {
    throw policyError("改派禁止点击协助，只能点击目标师傅行的负责人", "RECLOUD_ASSIGNMENT_ACTION_FORBIDDEN", action);
  }
  if (action === RECLOUD_WORK_ORDER_OPERATION_POLICY.forbiddenPartLookup) {
    throw policyError("添加配件禁止点击放大镜，应在新件名称直接输入编码", "RECLOUD_PART_LOOKUP_FORBIDDEN", action);
  }
  if (target === RECLOUD_WORK_ORDER_OPERATION_POLICY.forbiddenAttachmentTarget) {
    throw policyError("维修照片视频只能上传到主附件", "RECLOUD_ATTACHMENT_TARGET_FORBIDDEN", target);
  }
  if (RECLOUD_WORK_ORDER_OPERATION_POLICY.excludedTargets.includes(target)) {
    throw policyError(`禁止修改${target}`, "RECLOUD_FIELD_TARGET_FORBIDDEN", target);
  }
  if (operation.afterSubmit === true) {
    throw policyError("最终提交后禁止继续操作工单", "RECLOUD_POST_SUBMIT_ACTION_FORBIDDEN", target || action);
  }
  return true;
}

module.exports = {
  RECLOUD_WORK_ORDER_OPERATION_POLICY,
  buildRecloudAssignmentPlan,
  assertRecloudOperationAllowed,
};
