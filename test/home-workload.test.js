const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

test("technician workload totals every unfinished in-hand order and partitions hold reasons", async () => {
  const { categorizeTechnicianWorkflows, technicianWorkloadStatusLabel } = await import(
    pathToFileURL(path.join(__dirname, "../frontend/src/shared/homeWorkload.js"))
  );
  const received = { rmaNo: "ACTIVE", receiptCompletedAt: "2026-09-05", status: "INSPECTION_IN_PROGRESS" };
  const partsPage = { rmaNo: "PARTS", receiptCompletedAt: "2026-09-05", status: "PARTS_REQUESTED" };
  const branchShortage = { rmaNo: "BRANCH", receiptCompletedAt: "2026-09-05", status: "ON_HOLD", hold: { category: "保内", reason: "网点缺件" } };
  const headquartersShortage = { rmaNo: "HQ", receiptCompletedAt: "2026-09-05", status: "ON_HOLD", hold: { category: "保外", reason: "总部缺件" } };
  const outOfWarranty = { rmaNo: "OUT", receiptCompletedAt: "2026-09-05", status: "ON_HOLD", hold: { category: "保外", reason: "待用户付费" } };
  const otherHold = { rmaNo: "OTHER", receiptCompletedAt: "2026-09-05", status: "ON_HOLD", hold: { category: "保内", reason: "用户要求暂放" } };
  const completed = { rmaNo: "DONE", receiptCompletedAt: "2026-09-05", status: "REPAIR_COMPLETED_PENDING_SHIPMENT", repairCompletion: { submittedAt: "2026-09-05" } };
  const notReceived = { rmaNo: "UNSIGNED", status: "WAIT_RECEIPT" };

  const result = categorizeTechnicianWorkflows([
    received, partsPage, branchShortage, headquartersShortage, outOfWarranty, otherHold, completed, notReceived,
  ]);
  assert.deepEqual(result.unfinished.map((item) => item.rmaNo), ["ACTIVE", "PARTS", "BRANCH", "HQ", "OUT", "OTHER"]);
  assert.deepEqual(result.waitingMaterial.map((item) => item.rmaNo), ["BRANCH", "HQ"]);
  assert.deepEqual(result.outOfWarranty.map((item) => item.rmaNo), ["OUT"]);
  assert.deepEqual(result.otherHeld.map((item) => item.rmaNo), ["OTHER"]);
  assert.deepEqual(result.completed.map((item) => item.rmaNo), ["DONE"]);
  assert.equal(technicianWorkloadStatusLabel(headquartersShortage), "待料");
  assert.equal(technicianWorkloadStatusLabel(outOfWarranty), "保外暂存");
});
