const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { resolveProjectModel } = require("../connectors/feishu-model-catalog");
const {
  RECLOUD_RECEIPT_FIELD_TARGETS,
  RECLOUD_REPAIR_FIELD_TARGETS,
  buildRecloudReceiptFormPlan,
} = require("../connectors/recloud-sync-mapping");
const { buildProjectCorrectionPlan } = require("../services/recloud-project-correction-rules");
const { buildPricingPreview } = require("../services/out-of-warranty-pricing");
const { orchestrateRepairCompletion } = require("../services/recloud-repair-completion-orchestrator");
const {
  buildRecloudAssignmentPlan,
  assertRecloudOperationAllowed,
} = require("../services/recloud-work-order-operation-policy");

const PARTS = [
  { partCode: "20020100013703", partName: "售后水泵ATK-21.6-A2.46P-FT", quantity: 1, retailPrice: 29, repairLevel: "中修" },
  { partCode: "20020100013687", partName: "售后硬滚轴承盖（嵌件）", quantity: 1, retailPrice: 5, repairLevel: "中修" },
  { partCode: "20020100007849", partName: "售后滚刷悬臂装饰片", quantity: 1, retailPrice: 1, repairLevel: "小修" },
];

function memoryRepairAdapter() {
  let assignee = "";
  let parts = [];
  let attachments = [];
  const calls = [];
  return {
    calls,
    async readRemoteState() { calls.push("read"); return { assignee, parts, attachments }; },
    async assignResponsible(plan) {
      calls.push(`负责人:${plan.servicePerson}`);
      assert.equal(plan.action, "负责人");
      assert.equal(plan.forbiddenAction, "协助");
      assignee = plan.servicePerson;
    },
    async addParts(additions, policy) {
      calls.push(`配件:${policy.entryMode}:${policy.target}`);
      assert.equal(policy.entryMode, "DIRECT_CODE_INPUT");
      assert.equal(policy.target, "新件名称");
      assert.equal(policy.forbiddenAction, "放大镜");
      parts = additions;
    },
    async applyRepairFields(plan) {
      calls.push("维修字段");
      assert.equal(plan.safeWrites.some((field) => field.target === "责任判定"), false);
      assert.equal(plan.safeWrites.find((field) => field.key === "troubleshooting")?.value, "否");
    },
    async verifyRepairFields() { calls.push("复核维修字段"); return true; },
    async uploadAttachments(plan, policy) {
      calls.push(`附件:${policy.target}`);
      assert.equal(policy.target, "附件");
      assert.equal(policy.forbiddenTarget, "附件（检测报告）");
      attachments = plan.additions;
    },
    async clickComplete() { calls.push("完工"); },
    async waitForSubmitReady() { calls.push("等待提交"); return true; },
    async clickSubmit(policy) {
      calls.push("提交");
      assert.equal(policy.stopImmediately, true);
    },
  };
}

test("一条完全本地的模拟整单覆盖项目号、费用、附件、负责人和提交终点", async () => {
  const correctProject = resolveProjectModel([
    { projectCode: "W2458S", model: "Mars 中版", modelCode: "011101AA000271", repairFees: { 大修: 60, 中修: 40, 小修: 20 } },
  ], { sn: "W2458S53NCN7170529", currentProjectCode: "W2458S" });
  assert.equal(correctProject.status, "MATCHED");
  assert.equal(correctProject.correctionLookupRequired, false);

  const receiptAttachments = Array.from({ length: 7 }, (_, index) => ({ id: `RECEIPT-${index + 1}` }));
  const receiptPlan = buildRecloudReceiptFormPlan({
    sn: "W2458S53NCN7170529",
    remark: "洗地机",
    attachments: receiptAttachments,
  });
  assert.equal(receiptPlan.projectCorrection.action, "KEEP");
  assert.deepEqual(receiptPlan.safeWrites, []);
  assert.equal(RECLOUD_RECEIPT_FIELD_TARGETS.attachments.target, "寄修单附件");

  const wrongProject = resolveProjectModel([
    { projectCode: "R2580X", model: "X50 Pro 履带上下水版", modelCode: "010201AA000656" },
    { projectCode: "R2580X", model: "组合编码", modelCode: "TM202609010001" },
  ], { sn: "R2580X5AMCN0146633", currentProjectCode: "R25808" });
  const correction = buildProjectCorrectionPlan(wrongProject, "R2580X5AMCN0146633");
  assert.equal(correction.action, "REPLACE");
  assert.equal(correction.productModelCode, "010201AA000656");
  assert.equal(correction.canAutoSave, false);

  const pricing = buildPricingPreview({
    modelRepairFees: { 大修: 60, 中修: 40, 小修: 20 },
    usedParts: PARTS,
    warrantyStatus: "保外",
  });
  assert.equal(pricing.partsFee, 35);
  assert.equal(pricing.repairFee, 40);
  assert.equal(pricing.knownTotal, 75);

  const { buildRepairMeasure } = await import(pathToFileURL(
    path.join(__dirname, "../frontend/src/shared/repairMeasure.js")
  ));
  const repairMeasure = buildRepairMeasure(
    "机器无法使用，客诉故障复现，检测不良，更换，清理，测试OK寄回",
    PARTS,
    "机器不出水，污水箱上不了污水#"
  );
  assert.match(repairMeasure, /售后水泵ATK-21\.6-A2\.46P-FT/);
  assert.match(repairMeasure, /测试ok寄回$/);

  assert.deepEqual(buildRecloudAssignmentPlan("唐张帅"), {
    servicePerson: "唐张帅", action: "负责人", forbiddenAction: "协助",
  });
  for (const operation of [
    { action: "代客户收件" },
    { action: "协助" },
    { action: "放大镜" },
    { target: "责任判定" },
    { target: "附件（检测报告）" },
  ]) assert.throws(() => assertRecloudOperationAllowed(operation));

  const serviceAttachments = Array.from({ length: 4 }, (_, index) => ({
    fileName: `SERVICE-${index + 1}.jpg`,
    path: `/local-simulation/SERVICE-${index + 1}.jpg`,
    size: 1000 + index,
    mimeType: "image/jpeg",
  }));
  assert.equal(RECLOUD_REPAIR_FIELD_TARGETS.attachments.target, "附件");
  assert.equal(RECLOUD_REPAIR_FIELD_TARGETS.detectionReportAttachments.target, "附件（检测报告）");

  const adapter = memoryRepairAdapter();
  const result = await orchestrateRepairCompletion("LOCAL-SIMULATION-001", {
    assignee: "唐张帅",
    faultLevel1: "产品质量",
    faultLevel2: "地刷不出水",
    faultLevel3: "水泵不良",
    detectionResult: "维修",
    responsibilityType: "保外",
    repairMeasure,
    usedParts: PARTS,
    pricing: {
      warrantyStatus: "OUT_OF_WARRANTY",
      highestRepairLevel: "中修",
      totalFee: 75,
      roundTripLogisticsFee: 0,
    },
    attachments: serviceAttachments,
  }, adapter, { writeEnabled: true });

  assert.equal(result.status, "SUCCESS");
  assert.equal(result.stoppedImmediatelyAfterSubmit, true);
  assert.equal(result.postSubmitActions, 0);
  assert.equal(receiptAttachments.length, 7);
  assert.equal(serviceAttachments.length, 4);
  assert.deepEqual(adapter.calls, [
    "read", "负责人:唐张帅", "read", "配件:DIRECT_CODE_INPUT:新件名称", "read",
    "维修字段", "复核维修字段", "read", "附件:附件", "read", "完工", "等待提交", "提交",
  ]);
});
