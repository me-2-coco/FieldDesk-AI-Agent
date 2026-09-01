const test = require("node:test");
const assert = require("node:assert/strict");
const { buildInspectionFormDecision } = require("../services/inspection-form-rules");

test("inspection decision only fixes original consumables and leaves skipped fields absent", () => {
  const result = buildInspectionFormDecision({
    faultCategory: "产品质量 / 出水大/水渍大",
    technicianWarranty: "保内",
    snWarranty: "保内",
    detectionResult: "功能故障",
  });
  assert.equal(result.status, "READY");
  assert.equal(result.fields.customerReasonConsistent, "是");
  assert.equal(result.fields.originalConsumables, "是");
  assert.equal(result.fields.consumableName, "");
  assert.equal(result.fields.productFunctionDecision, "功能问题");
  assert.equal(result.fields.detectionResult, "维修");
  assert.equal(result.fields.inspectionAbnormal, "否");
  assert.equal(Object.hasOwn(result.fields, "responsibilityDecision"), false);
  assert.equal(Object.hasOwn(result.fields, "faultDescription"), false);
  assert.equal(Object.hasOwn(result.fields, "dismantled"), false);
  assert.equal(Object.hasOwn(result.fields, "openedRemark"), false);
});

test("inspection decision stops when technician and SN warranty disagree", () => {
  const result = buildInspectionFormDecision({
    faultCategory: "产品质量 / 出水大/水渍大",
    technicianWarranty: "保外",
    snWarranty: "保内",
    detectionResult: "功能故障",
  });
  assert.equal(result.status, "MANUAL_CONFIRMATION_REQUIRED");
  assert.equal(result.canAutoSubmit, false);
});

test("inspection decision never invents technician inputs", () => {
  const result = buildInspectionFormDecision({ snWarranty: "保内" });
  assert.equal(result.status, "INCOMPLETE");
  assert.deepEqual(result.missingFields, ["faultCategory", "technicianWarranty"]);
});
