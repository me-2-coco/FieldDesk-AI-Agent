const test = require("node:test");
const assert = require("node:assert/strict");
const { buildInspectionFormDecision, resolveFaultContent } = require("../services/inspection-form-rules");

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
  assert.equal(result.fields.faultContent, "故障复现");
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

test("maps the three detection outcomes and maps tuning to no abnormality", () => {
  const base = { faultCategory: "产品质量 / 清洁异常", technicianWarranty: "保外", snWarranty: "保外" };
  assert.equal(buildInspectionFormDecision({ ...base, detectionResult: "弃修" }).fields.detectionResult, "弃修");
  assert.equal(buildInspectionFormDecision({ ...base, detectionResult: "只检测不维修" }).fields.detectionResult, "检测不维修");
  const tuning = buildInspectionFormDecision({ ...base, detectionResult: "调试" }).fields;
  assert.equal(tuning.detectionResult, "维修");
  assert.equal(tuning.productFunctionDecision, "无异常");
  assert.equal(tuning.faultContent, "未复现");
});

test("fault content follows treatment mode and inspection-only fault outcome", () => {
  assert.equal(resolveFaultContent({ treatmentMode: "REPAIR", faultCategory: "产品质量 / 不出水" }), "故障复现");
  assert.equal(resolveFaultContent({ treatmentMode: "ABANDONED", faultCategory: "产品质量 / 不出水" }), "故障复现");
  assert.equal(resolveFaultContent({ treatmentMode: "DEBUGGING", faultCategory: "产品质量 / 清洁不干净" }), "未复现");
  assert.equal(resolveFaultContent({ treatmentMode: "INSPECTION_ONLY", faultCategory: "产品质量 / 不出水" }), "故障复现");
  assert.equal(resolveFaultContent({ treatmentMode: "INSPECTION_ONLY", faultCategory: "产品质量 / 无不良&未复现" }), "未复现");
  assert.equal(resolveFaultContent({ treatmentMode: "INSPECTION_ONLY", inspectionFaultOutcome: "FAULT_REPRODUCED", faultCategory: "无不良" }), "故障复现");
  assert.equal(resolveFaultContent({ treatmentMode: "INSPECTION_ONLY", inspectionFaultOutcome: "NO_FAULT", faultCategory: "不出水" }), "未复现");
});

test("inspection-only explicit result takes priority in the submitted inspection form", () => {
  const base = {
    treatmentMode: "INSPECTION_ONLY",
    faultCategory: "产品质量 / 不出水",
    technicianWarranty: "保内",
    snWarranty: "保内",
    detectionResult: "只检测不维修",
  };
  assert.equal(buildInspectionFormDecision({ ...base, inspectionFaultOutcome: "FAULT_REPRODUCED" }).fields.faultContent, "故障复现");
  assert.equal(buildInspectionFormDecision({ ...base, inspectionFaultOutcome: "NO_FAULT" }).fields.faultContent, "未复现");
});
