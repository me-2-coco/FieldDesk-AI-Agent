#!/usr/bin/env node
const recloud = require("../connectors/recloud");

async function main() {
  const logisticsNo = String(process.argv[2] || "").trim();
  const sn = String(process.argv[3] || "").trim();
  if (!logisticsNo || !sn) {
    throw Object.assign(new Error("missing logistics number or SN"), {
      code: "ORDER_INPUT_REQUIRED",
    });
  }

  try {
    process.stderr.write("DIAGNOSTIC_STAGE: opening_session\n");
    const opened = await recloud.openRecloud({ headless: true });
    if (opened.loginRequired) {
      throw Object.assign(new Error("login required"), {
        code: "RECLOUD_LOGIN_REQUIRED",
      });
    }
    process.stderr.write("DIAGNOSTIC_STAGE: locating_order\n");
    const detail = await recloud.queryRmaByLogisticsNo(opened.page, logisticsNo);
    process.stderr.write("DIAGNOSTIC_STAGE: inspecting_receipt_form\n");
    const inspection = await recloud.inspectReceiptForm(opened.page, {
      dryRun: true,
      writeEnabled: false,
      rmaNo: detail.rmaNo,
      mappedRowOnly: true,
      logger: { info() {} },
    });
    process.stderr.write("DIAGNOSTIC_STAGE: simulating_receipt_fields\n");
    await recloud.queryRmaByLogisticsNo(opened.page, logisticsNo);
    const simulation = await recloud.simulateReceiptForm(
      opened.page,
      sn,
      detail.productType || "寄修机器签收",
      {
        dryRun: true,
        writeEnabled: false,
        rmaNo: detail.rmaNo,
        mappedRowOnly: true,
        logger: { info() {} },
      }
    );
    process.stdout.write(`${JSON.stringify({
      rmaLocated: Boolean(detail.rmaNo),
      productType: detail.productType || "",
      receiptEntryVisible: inspection.receiptEntryVisible,
      receiptEntryEnabled: inspection.receiptEntryEnabled,
      finalActionVisible: inspection.confirmButtonVisible,
      finalActionEnabled: inspection.confirmButtonEnabled,
      simulationVerified: simulation.valuesVerified === true,
      simulationCleaned: simulation.snCleared === true && simulation.remarkRestored === true,
      dialogClosed: simulation.dialogClosed === true,
      recloudModified: false,
    })}\n`);
  } finally {
    await recloud.closeRecloud().catch(() => {});
  }
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({
    errorCode: error.code || "RECLOUD_NEW_ORDER_INSPECTION_FAILED",
    missingFields: error.missingFields || [],
    recloudModified: false,
  })}\n`);
  process.exitCode = 1;
});
