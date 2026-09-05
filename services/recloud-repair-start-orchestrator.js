const { buildRecloudRepairPartsPlan } = require("./recloud-repair-parts-plan");
const {
  RECLOUD_WORK_ORDER_OPERATION_POLICY,
  buildRecloudAssignmentPlan,
  assertRecloudOperationAllowed,
} = require("./recloud-work-order-operation-policy");

function startError(message, code, phase) {
  const error = new Error(message);
  error.code = code;
  error.status = 502;
  error.phase = phase;
  return error;
}

async function orchestrateRepairStart(payload, adapter, options = {}) {
  if (!adapter || typeof adapter.readAssignee !== "function" || typeof adapter.readRemoteState !== "function") {
    throw startError("瑞云维修准备执行器不可用", "RECLOUD_REPAIR_START_ADAPTER_INVALID", "PLAN");
  }
  // 改派只有首次从寄修单点击“维修”进入服务单时可用。这里在任何
  // 页签切换、配件读取或保外转保内动作之前先完成改派和复核。
  let assignee = await adapter.readAssignee();
  const assignmentPlan = buildRecloudAssignmentPlan(payload.assignee);
  let assignmentRequired = String(assignee || "").trim() !== assignmentPlan.servicePerson;
  if (options.writeEnabled !== true) {
    const remote = await adapter.readRemoteState();
    const partsPlan = buildRecloudRepairPartsPlan(payload.usedParts, remote.parts);
    return {
      status: "READY_DRY_RUN",
      assignee: assignmentPlan.servicePerson,
      assignmentRequired,
      warrantyConversionRequired: true,
      partsToAdd: partsPlan.additions.length,
      recloudModified: false,
    };
  }

  if (assignmentRequired) {
    if (typeof adapter.assignResponsible !== "function") {
      throw startError("缺少负责人改派执行器", "RECLOUD_REPAIR_ASSIGNMENT_ADAPTER_INVALID", "ASSIGNMENT");
    }
    assertRecloudOperationAllowed({ action: assignmentPlan.action, target: assignmentPlan.servicePerson });
    await adapter.assignResponsible(assignmentPlan);
    assignee = await adapter.readAssignee();
    assignmentRequired = String(assignee || "").trim() !== assignmentPlan.servicePerson;
    if (assignmentRequired) {
      throw startError("负责人改派后远端复核失败", "RECLOUD_REPAIR_ASSIGNMENT_POSTVERIFY_FAILED", "ASSIGNMENT");
    }
  }

  let remote = await adapter.readRemoteState();
  let partsPlan = buildRecloudRepairPartsPlan(payload.usedParts, remote.parts);
  if (!partsPlan.readyToAdd) {
    throw startError("配件新增前瑞云明细冲突", "RECLOUD_REPAIR_PART_PRECHECK_FAILED", "PARTS");
  }

  if (typeof adapter.confirmWarrantyConversion !== "function") {
    throw startError("缺少保外转保内执行器", "RECLOUD_WARRANTY_CONVERSION_ADAPTER_INVALID", "WARRANTY_CONVERSION");
  }
  await adapter.confirmWarrantyConversion({
    requested: payload.warrantyConversionRequested === true,
    requiredOnce: true,
    completedWhen: "HIDDEN",
  });

  remote = await adapter.readRemoteState();
  partsPlan = buildRecloudRepairPartsPlan(payload.usedParts, remote.parts);
  if (!partsPlan.readyToAdd) {
    throw startError("配件新增前瑞云明细冲突", "RECLOUD_REPAIR_PART_PRECHECK_FAILED", "PARTS");
  }
  if (partsPlan.additions.length) {
    if (typeof adapter.addParts !== "function") {
      throw startError("缺少配件新增执行器", "RECLOUD_REPAIR_PART_WRITE_ADAPTER_INVALID", "PARTS");
    }
    assertRecloudOperationAllowed({ action: "直接输入编码", target: RECLOUD_WORK_ORDER_OPERATION_POLICY.partEntryTarget });
    const addResult = await adapter.addParts(partsPlan.additions, {
      entryMode: RECLOUD_WORK_ORDER_OPERATION_POLICY.partEntryMode,
      target: RECLOUD_WORK_ORDER_OPERATION_POLICY.partEntryTarget,
      forbiddenAction: RECLOUD_WORK_ORDER_OPERATION_POLICY.forbiddenPartLookup,
    });
    remote = await adapter.readRemoteState();
    partsPlan = buildRecloudRepairPartsPlan(payload.usedParts, remote.parts);
    const reportedMissingParts = Array.isArray(addResult?.missingParts) ? addResult.missingParts : [];
    const missingCodes = new Set(reportedMissingParts.map((part) => String(part.partCode || "").trim().toUpperCase()));
    const onlyReportedShortagesRemain = partsPlan.additions.length > 0
      && partsPlan.additions.every((part) => missingCodes.has(String(part.partCode || "").trim().toUpperCase()));
    if (!partsPlan.readyToAdd || (partsPlan.additions.length && !onlyReportedShortagesRemain)) {
      throw startError("配件新增后远端复核失败", "RECLOUD_REPAIR_PART_POSTVERIFY_FAILED", "PARTS");
    }
    if (onlyReportedShortagesRemain) {
      return {
        status: "PARTS_SHORTAGE",
        assignee: assignmentPlan.servicePerson,
        assignmentSource: payload.assignmentSource || "",
        warrantyConversionRequested: payload.warrantyConversionRequested === true,
        partsVerified: false,
        missingParts: reportedMissingParts,
        completedSteps: ["ASSIGNEE_VERIFIED", "WARRANTY_CONVERSION_CONFIRMED", "PARTS_SHORTAGE_RECORDED"],
      };
    }
  }

  return {
    status: "SUCCESS",
    assignee: assignmentPlan.servicePerson,
    assignmentSource: payload.assignmentSource || "",
    warrantyConversionRequested: payload.warrantyConversionRequested === true,
    partsVerified: true,
    completedSteps: ["ASSIGNEE_VERIFIED", "WARRANTY_CONVERSION_CONFIRMED", "PARTS_VERIFIED"],
  };
}

module.exports = { orchestrateRepairStart };
