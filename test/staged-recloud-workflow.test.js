const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { JsonReceiptPreparationStore } = require("../database/receipt-preparation-store");

const TECH = { userId: "STAGED-TECH", displayName: "分步测试师傅", role: "TECHNICIAN" };

test("FieldDesk persists the required warranty, decision, parts, detection and repair order", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fielddesk-staged-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new JsonReceiptPreparationStore(path.join(directory, "orders.json"));
  await store.prepare({ logisticsNo: "STAGED-L", rmaNo: "STAGED-R", sn: "W233603AMCN000001", productLine: "洗地机" });
  await store.markModelAuthorization("STAGED-R", { repairability: "SUPPORTED", status: "MATCHED" }, TECH);
  await store.addReceiptAttachment("STAGED-R", { id: "PHOTO", name: "receipt.jpg", mimeType: "image/jpeg" }, TECH);
  const received = await store.completeReceipt("STAGED-R", TECH);
  assert.equal(received.resumeStep, "repairWarranty");

  const warranted = await store.saveWarrantyDecision("STAGED-R", { technicianWarranty: "保内" }, TECH);
  assert.equal(warranted.resumeStep, "repairDecision");
  const decided = await store.saveTreatmentDecision("STAGED-R", { treatmentMode: "REPAIR" }, TECH);
  assert.equal(decided.resumeStep, "partsApplication");
  await store.applyPart("STAGED-R", { code: "P-1", name: "测试配件", stock: 2, retailPrice: 10 }, 1, TECH);
  const partsConfirmed = await store.confirmParts("STAGED-R", TECH);
  assert.equal(partsConfirmed.nextStep, "repairProcess");
  const inspected = await store.saveInspection("STAGED-R", { inspectionResult: "维修", faultCategory: "产品质量|功能异常|部件不良", technicianWarranty: "保内" }, TECH);
  assert.equal(inspected.resumeStep, "repairProcess");
  const started = await store.startRepair("STAGED-R", {
    recloudSynced: false,
    repairPreparation: {
      fieldDeskUserId: TECH.userId,
      assignee: "瑞云测试师傅",
      assignmentSource: "DIRECT",
      warrantyConversionRequested: false,
      usedParts: [{ partCode: "P-1", quantity: 1 }],
    },
  }, TECH);
  assert.equal(started.resumeStep, "repairCompletion");
  assert.equal(started.recloudRepairPreparation.assignee, "瑞云测试师傅");
  assert.equal(started.recloudRepairPreparation.status, "PENDING");

  const serviceOrderConfirmed = await store.markRecloudServiceOrderConfirmed(
    "STAGED-R",
    TECH,
    { serviceOrderNo: "FWD202609050001" }
  );
  assert.equal(serviceOrderConfirmed.recloudServiceOrderNo, "FWD202609050001");

  const reconciled = await store.markRecloudRepairPreparationConfirmed("STAGED-R", {
    assignee: "实际改派师傅",
    assignmentSource: "MANUAL_RECONCILIATION",
    completedSteps: ["ASSIGNEE_VERIFIED", "WARRANTY_CONVERSION_CONFIRMED", "PARTS_VERIFIED"],
  }, TECH);
  assert.equal(reconciled.recloudRepairPreparation.status, "CONFIRMED");
  assert.equal(reconciled.recloudRepairPreparation.assignee, "实际改派师傅");
  assert.equal(reconciled.recloudRepairPreparation.assignmentSource, "MANUAL_RECONCILIATION");
});

test("Recloud detection and repair creation are separate explicit actions", async () => {
  const connector = await fs.readFile(path.join(__dirname, "../connectors/recloud.js"), "utf8");
  const server = await fs.readFile(path.join(__dirname, "../server.js"), "utf8");
  const detectionBlock = connector.slice(connector.indexOf("async function confirmDetection"), connector.indexOf("async function startRepair"));
  assert.doesNotMatch(detectionBlock, /waitForUniqueAction\(page, "维修"/);
  assert.match(connector, /async function startRepair[\s\S]*waitForUniqueAction\(page, "维修"/);
  assert.match(connector, /async function startRepair[\s\S]*RECLOUD_REPAIR_SERVICE_ORDER_PAGE_NOT_READY/);
  assert.match(server, /function scheduleRecloudDetectionSync[\s\S]*connector\.confirmDetection/);
  assert.match(server, /function scheduleRecloudServiceOrderSync[\s\S]*connector\.startRepair/);
  assert.match(server, /recloudRepairAdapterProvider[\s\S]*openExistingRepairServiceOrder/);
  assert.match(server, /app\.post\("\/api\/repairs\/inspection"[\s\S]*scheduleRecloudDetectionSync/);
  assert.match(server, /\["FAILED", "SYNCING"\]\.includes\(order\.recloudDetectionSyncStatus\)[\s\S]*scheduleRecloudDetectionSync\(order/);
  assert.match(server, /RECLOUD_DETECTION_RETRY_QUEUED/);
  assert.match(server, /app\.post\("\/api\/repairs\/start-repair"[\s\S]*scheduleRecloudServiceOrderSync/);
  assert.doesNotMatch(server, /代客户收件/);
});
