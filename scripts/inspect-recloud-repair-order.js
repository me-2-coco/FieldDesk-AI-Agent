#!/usr/bin/env node
const recloud = require("../connectors/recloud");
const { assessRecloudRepairPageReadiness } = require("../services/recloud-repair-page-readiness");

async function main() {
  const logisticsNo = String(process.argv[2] || "").trim();
  if (!logisticsNo) throw Object.assign(new Error("missing logistics number"), { code: "LOGISTICS_NO_REQUIRED" });
  let opened;
  try {
    process.stderr.write("DIAGNOSTIC_STAGE: opening_session\n");
    opened = await recloud.openRecloud({ headless: true });
    if (opened.loginRequired) throw Object.assign(new Error("login required"), { code: "RECLOUD_LOGIN_REQUIRED" });
    process.stderr.write("DIAGNOSTIC_STAGE: locating_rma\n");
    const detail = await recloud.queryRmaByLogisticsNo(opened.page, logisticsNo);
    process.stderr.write("DIAGNOSTIC_STAGE: inspecting_repair_page\n");
    const inspection = await recloud.inspectRepairForm(opened.page, {
      dryRun: true,
      writeEnabled: false,
      searchTerm: detail.rmaNo,
      inspectPartAddDialog: true,
      allowUnavailablePartAdd: true,
      logger: { info() {} },
    });
    const readiness = assessRecloudRepairPageReadiness(inspection, {
      mode: "completed-read-only",
    });
    process.stdout.write(`${JSON.stringify({
      rmaLocated: Boolean(detail.rmaNo),
      status: readiness.status,
      observedState: readiness.observedState,
      missingFields: readiness.missingFields,
      sections: inspection.sectionTitles,
      directControls: (inspection.directRepairControls || []).map((item) => ({
        key: item.key,
        labelCount: item.labelCount,
        inputCount: item.inputCount,
        editable: item.editable,
      })),
      partsSchemaError: inspection.partsTableSchema?.errorCode || "",
      attachmentSchemaError: inspection.attachmentPanelSchema?.errorCode || "",
      partDialogObserved: Boolean(inspection.partAddDialogInspection && !inspection.partAddDialogInspection.unavailable),
      partAddUnavailableBecauseLocked: inspection.partAddDialogInspection?.unavailable === true,
      recloudModified: false,
    })}\n`);
  } finally {
    await recloud.closeRecloud().catch(() => {});
  }
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({
    errorCode: error.code || "RECLOUD_DIAGNOSTIC_FAILED",
    missingFields: error.missingFields || [],
    recloudModified: false,
  })}\n`);
  process.exitCode = 1;
});
