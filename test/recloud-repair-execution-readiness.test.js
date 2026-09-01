const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { assessRecloudRepairExecutionReadiness } = require("../services/recloud-repair-execution-readiness");

function readyInspection(overrides = {}) {
  return {
    currentAssigneeCount: 1,
    currentAssignee: "梁思佳",
    reassignButtonCount: 1,
    servicePersonInputCount: 1,
    targetTechnicianRowCount: 1,
    responsibleActionCount: 1,
    assistActionCount: 1,
    responsibleActionText: "负责人",
    assistActionText: "协助",
    partAddButtonCount: 1,
    partHeadingCount: 1,
    directPartCodeInputCount: 1,
    partEntryMode: "DIRECT_CODE_INPUT",
    partEntryTarget: "新件名称",
    mainAttachmentHeadingCount: 1,
    mainAttachmentUploadCount: 1,
    attachmentTarget: "附件",
    forbiddenAttachmentTarget: "附件（检测报告）",
    completeButtonCount: 1,
    submitButtonCount: 0,
    mutationRequestDetected: false,
    blockedRequestCount: 0,
    dialogClosed: true,
    partDialogClosed: true,
    ...overrides,
  };
}

test("execution readiness accepts only unique safe controls", () => {
  const result = assessRecloudRepairExecutionReadiness(readyInspection());
  assert.equal(result.ready, true);
  assert.equal(result.status, "READY");
  assert.equal(result.observedState, "COMPLETE_READY");
  assert.equal(result.writeEnabled, false);
  assert.equal(result.recloudModified, false);
});

test("execution readiness fails closed when technician or responsible action is ambiguous", () => {
  const result = assessRecloudRepairExecutionReadiness(readyInspection({
    targetTechnicianRowCount: 2,
    responsibleActionCount: 2,
  }));
  assert.equal(result.ready, false);
  assert.match(result.missingFields.join("|"), /targetTechnicianRow/);
  assert.match(result.missingFields.join("|"), /responsibleAction/);
});

test("execution readiness rejects wrong part and attachment targets", () => {
  const result = assessRecloudRepairExecutionReadiness(readyInspection({
    partEntryMode: "LOOKUP",
    partEntryTarget: "放大镜",
    attachmentTarget: "附件（检测报告）",
  }));
  assert.equal(result.ready, false);
  assert.match(result.missingFields.join("|"), /partEntryMode/);
  assert.match(result.missingFields.join("|"), /partEntryTarget/);
  assert.match(result.missingFields.join("|"), /attachmentTarget/);
});

test("execution readiness stops if read-only diagnostics observes a mutation", () => {
  const result = assessRecloudRepairExecutionReadiness(readyInspection({
    mutationRequestDetected: true,
    blockedRequestCount: 1,
  }));
  assert.equal(result.ready, false);
  assert.match(result.missingFields.join("|"), /unexpectedMutation/);
});

test("execution inspector source never clicks assist or part lookup and stays read-only", async () => {
  const source = await fs.readFile(path.join(__dirname, "../connectors/recloud-repair-execution-inspector.js"), "utf8");
  assert.doesNotMatch(source, /assist\.click|协助.*\.click/);
  assert.doesNotMatch(source, /放大镜.*\.click/);
  assert.match(source, /options\.dryRun !== true \|\| options\.writeEnabled !== false/);
  assert.match(source, /recloudModified: false/);
});
