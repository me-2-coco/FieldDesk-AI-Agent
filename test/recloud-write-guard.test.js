const test = require("node:test");
const assert = require("node:assert/strict");
const { createRecloudRmaWriteGuard } = require("../server");

test("confirmed-code recovery requires explicit mode and still refuses unknown outcomes", () => {
  const { shouldAutoResumeDetection } = require("../server");
  const order = { status: "REPAIR_COMPLETED_PENDING_SHIPMENT", inspectionUpdatedAt: "2020-01-01", faultCategoryCode: "TEST-CODE", recloudDetectionSyncStatus: "FAILED", recloudDetectionLastError: { code: "RECLOUD_DETECTION_OPTION_AMBIGUOUS", at: "2020-01-01" } };
  assert.equal(shouldAutoResumeDetection(order, Date.now()), false);
  assert.equal(shouldAutoResumeDetection(order, Date.now(), true), true);
  assert.equal(shouldAutoResumeDetection({ ...order, recloudDetectionSyncStatus: "RESULT_UNKNOWN" }, Date.now(), true), false);
});

test("strict recovery permits only the explicitly authorized order, including live traffic", () => {
  const allowed = createRecloudRmaWriteGuard(["RMA-RECOVERY"], 0, true);
  assert.equal(allowed("RMA-RECOVERY"), true);
  assert.equal(allowed("RMA-OTHER", { updatedAt: new Date().toISOString() }), false);
  assert.equal(createRecloudRmaWriteGuard([], 0, true)("RMA-OTHER"), false);
});

test("temporary RMA allowlist blocks historical backlog but permits new live work", () => {
  const startedAt = Date.parse("2026-09-06T11:30:00.000Z");
  const allowed = createRecloudRmaWriteGuard(["RMA-RECOVERY"], startedAt);

  assert.equal(allowed("RMA-RECOVERY", { createdAt: "2026-09-01T00:00:00.000Z" }), true);
  assert.equal(allowed("RMA-OLD", { updatedAt: "2026-09-06T11:29:59.999Z" }), false);
  assert.equal(allowed("RMA-NEW", { createdAt: "2026-09-06T11:30:00.000Z" }), true);
  assert.equal(allowed("RMA-EDITED", { inspectionUpdatedAt: "2026-09-06T11:30:01.000Z" }), true);
  assert.equal(allowed("RMA-BACKGROUND-UPDATED", { updatedAt: "2026-09-06T11:30:01.000Z" }), false);
});

test("empty allowlist permits normal operation", () => {
  const allowed = createRecloudRmaWriteGuard([], Date.now());
  assert.equal(allowed("ANY-RMA", {}), true);
});
