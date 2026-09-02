const test = require("node:test");
const assert = require("node:assert/strict");

test("saved resume step overrides status inference for unfinished orders", async () => {
  const { resumePageForLocalWorkflow } = await import("../frontend/src/shared/repairNavigation.js");
  assert.equal(resumePageForLocalWorkflow({ status: "REPAIR_COMPLETION_DRAFT", resumeStep: "partsApplication" }), "partsApplication");
  assert.equal(resumePageForLocalWorkflow({ status: "RECEIVED_PENDING_INSPECTION", resumeStep: "repairCompletion" }), "repairCompletion");
});

test("legacy unfinished orders infer their furthest valid workflow page", async () => {
  const { resumePageForLocalWorkflow } = await import("../frontend/src/shared/repairNavigation.js");
  assert.equal(resumePageForLocalWorkflow({ receiptCompletedAt: "saved" }), "repairDecision");
  assert.equal(resumePageForLocalWorkflow({ receiptCompletedAt: "saved", treatmentMode: "REPAIR" }), "partsApplication");
  assert.equal(resumePageForLocalWorkflow({
    receiptCompletedAt: "saved",
    treatmentMode: "REPAIR",
    inspectionUpdatedAt: "saved",
    faultCategory: "产品质量|无法启动|主板不良",
    technicianWarranty: "保外",
    timeline: [{ type: "PARTS_CONFIRMED" }],
  }), "repairCompletion");
});

test("submitted orders always reopen as completion details", async () => {
  const { resumePageForLocalWorkflow } = await import("../frontend/src/shared/repairNavigation.js");
  assert.equal(resumePageForLocalWorkflow({ status: "REPAIR_COMPLETED_PENDING_SHIPMENT", resumeStep: "partsApplication" }), "repairCompletion");
  assert.equal(resumePageForLocalWorkflow({ status: "COMPLETED", resumeStep: "repairProcess" }), "repairCompletion");
});
