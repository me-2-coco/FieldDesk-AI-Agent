const REQUIRED_EXECUTION_CONTROLS = Object.freeze([
  "currentAssignee",
  "reassignButton",
  "targetTechnicianRow",
  "responsibleAction",
  "partAddButton",
  "directPartCodeInput",
  "mainAttachmentUpload",
]);

function assessRecloudRepairExecutionReadiness(inspection = {}) {
  const missingFields = [];
  const requireUnique = (key, count) => {
    if (Number(count) !== 1) missingFields.push(`repair.execution.${key}`);
  };

  requireUnique("currentAssignee", inspection.currentAssigneeCount);
  if (!String(inspection.currentAssignee || "").trim()) {
    missingFields.push("repair.execution.currentAssigneeValue");
  }
  requireUnique("reassignButton", inspection.reassignButtonCount);
  requireUnique("servicePersonInput", inspection.servicePersonInputCount);
  requireUnique("targetTechnicianRow", inspection.targetTechnicianRowCount);
  requireUnique("responsibleAction", inspection.responsibleActionCount);
  requireUnique("assistAction", inspection.assistActionCount);
  requireUnique("partAddButton", inspection.partAddButtonCount);
  requireUnique("partHeading", inspection.partHeadingCount);
  requireUnique("directPartCodeInput", inspection.directPartCodeInputCount);
  requireUnique("mainAttachmentHeading", inspection.mainAttachmentHeadingCount);
  requireUnique("mainAttachmentUpload", inspection.mainAttachmentUploadCount);

  if (inspection.dialogClosed !== true) missingFields.push("repair.execution.assignmentDialogClose");
  if (inspection.partDialogClosed !== true) missingFields.push("repair.execution.partDialogClose");

  if (inspection.responsibleActionText !== "负责人") {
    missingFields.push("repair.execution.responsibleActionText");
  }
  if (inspection.assistActionText !== "协助") {
    missingFields.push("repair.execution.assistActionText");
  }
  if (inspection.partEntryMode !== "DIRECT_CODE_INPUT") {
    missingFields.push("repair.execution.partEntryMode");
  }
  if (inspection.partEntryTarget !== "新件名称") {
    missingFields.push("repair.execution.partEntryTarget");
  }
  if (inspection.attachmentTarget !== "附件") {
    missingFields.push("repair.execution.attachmentTarget");
  }
  if (inspection.forbiddenAttachmentTarget !== "附件（检测报告）") {
    missingFields.push("repair.execution.forbiddenAttachmentTarget");
  }
  if (inspection.completeButtonCount !== 1 && inspection.submitButtonCount !== 1) {
    missingFields.push("repair.execution.completeOrSubmit");
  }
  if (inspection.mutationRequestDetected === true || Number(inspection.blockedRequestCount || 0) > 0) {
    missingFields.push("repair.execution.unexpectedMutation");
  }

  const uniqueMissing = [...new Set(missingFields)];
  return {
    status: uniqueMissing.length ? "NOT_READY" : "READY",
    ready: uniqueMissing.length === 0,
    missingFields: uniqueMissing,
    observedState: inspection.submitButtonCount === 1 ? "SUBMIT_READY" : "COMPLETE_READY",
    writeEnabled: false,
    recloudModified: false,
  };
}

module.exports = {
  REQUIRED_EXECUTION_CONTROLS,
  assessRecloudRepairExecutionReadiness,
};
