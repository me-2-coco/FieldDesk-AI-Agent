const REQUIRED_SECTIONS = Object.freeze([
  "服务单更换件明细",
  "故障模式及责任判定",
  "附件",
]);

function assessRecloudRepairPageReadiness(inspection = {}, options = {}) {
  const readOnlyCompleted = options.mode === "completed-read-only";
  const missingFields = [];
  if (inspection.repairEntryCandidateCount !== 1 || inspection.repairEntryClicked !== true) {
    missingFields.push("repair.entry");
  }
  if (inspection.serviceReportOpened !== true) missingFields.push("repair.serviceReport");
  const sections = new Set(Array.isArray(inspection.sectionTitles) ? inspection.sectionTitles : []);
  for (const section of REQUIRED_SECTIONS) {
    if (!sections.has(section)) missingFields.push(`repair.section.${section}`);
  }
  for (const control of Array.isArray(inspection.directRepairControls) ? inspection.directRepairControls : []) {
    if (control.labelCount !== 1 || control.inputCount !== 1 || (!readOnlyCompleted && control.editable !== true)) {
      missingFields.push(`repair.control.${String(control.key || "unknown")}`);
    }
  }
  if (!Array.isArray(inspection.directRepairControls) || inspection.directRepairControls.length === 0) {
    missingFields.push("repair.directControls");
  }
  if (inspection.partsTableSchema?.errorCode) {
    missingFields.push(...(inspection.partsTableSchema.missingFields || ["repair.partsTable"]));
  }
  if (inspection.attachmentPanelSchema?.errorCode) {
    missingFields.push(...(inspection.attachmentPanelSchema.missingFields || ["repair.attachmentsSection"]));
  }
  if (inspection.partAddDialogInspection?.unavailable === true && readOnlyCompleted) {
    // Submitted repairs are locked by Recloud, so an add-parts action is not expected.
  } else if (inspection.partAddDialogInspection) {
    if (inspection.partAddDialogInspection.saveButtonCount !== 1) missingFields.push("repair.partsAddSave");
    if (inspection.partAddDialogInspection.dialogClosed !== true) missingFields.push("repair.partsAddDialogClose");
  } else {
    missingFields.push("repair.partsAddDialog");
  }
  const actions = new Set(Array.isArray(inspection.actionTexts) ? inspection.actionTexts : []);
  const completeVisible = actions.has("完工");
  const submitVisible = actions.has("提交");
  if (!readOnlyCompleted && !completeVisible && !submitVisible) missingFields.push("repair.completeOrSubmitAction");

  const uniqueMissing = [...new Set(missingFields)];
  return {
    status: uniqueMissing.length ? "NOT_READY" : "READY",
    ready: uniqueMissing.length === 0,
    missingFields: uniqueMissing,
    observedState: submitVisible
      ? "SUBMIT_READY"
      : completeVisible
        ? "COMPLETE_READY"
        : readOnlyCompleted
          ? "COMPLETED_LOCKED"
          : "UNKNOWN",
    recloudModified: false,
  };
}

module.exports = { REQUIRED_SECTIONS, assessRecloudRepairPageReadiness };
