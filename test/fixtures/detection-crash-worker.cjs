const { JsonReceiptPreparationStore } = require("../../database/receipt-preparation-store");
(async () => {
  const store = new JsonReceiptPreparationStore(process.argv[2]);
  await store.writeAll([{ rmaNo: "SYNTHETIC-CRASH", recloudDetectionSyncStatus: "SYNCING" }]);
  await store.markRecloudDetectionSubmissionStarted("SYNTHETIC-CRASH");
  process.send("intent-saved");
  setInterval(() => {}, 1000);
})().catch(() => process.exit(1));
