const test = require("node:test");
const assert = require("node:assert/strict");
const { orchestrateRepairCompletion } = require("../services/recloud-repair-completion-orchestrator");

const PAYLOAD = {
  assignee: "唐张帅",
  faultLevel1: "产品质量",
  faultLevel2: "地刷不出水",
  faultLevel3: "水泵不良",
  detectionResult: "水泵不良",
  responsibilityType: "保内",
  repairMeasure: "更换水泵，测试正常寄回",
  usedParts: [{ partCode: "PART-1", partName: "水泵", quantity: 1, repairLevel: "中修" }],
  pricing: { warrantyStatus: "IN_WARRANTY", highestRepairLevel: "中修" },
  attachments: [{ fileName: "finish.jpg", path: "/safe/finish.jpg", size: 200000, mimeType: "image/jpeg" }],
};

function remoteAdapter(initial = {}) {
  let assignee = initial.assignee || "";
  let parts = initial.parts || [];
  let attachments = initial.attachments || [];
  const calls = [];
  return {
    calls,
    async readRemoteState() { calls.push("read"); return { assignee, parts: [...parts], attachments: [...attachments] }; },
    async assignResponsible(plan) {
      calls.push(`assign:${plan.servicePerson}:${plan.action}:${plan.forbiddenAction}`);
      assignee = plan.servicePerson;
    },
    async addParts(additions, policy) {
      calls.push(`parts:${policy.entryMode}:${policy.target}:${policy.forbiddenAction}`);
      parts = additions.map((item) => ({ ...item }));
    },
    async applyRepairFields() { calls.push("fields"); },
    async verifyRepairFields() { calls.push("verify-fields"); return true; },
    async uploadAttachments(plan, policy) {
      calls.push(`attachments:${policy.target}:${policy.forbiddenTarget}`);
      attachments = plan.additions.map((item) => ({ ...item }));
    },
    async clickComplete() { calls.push("complete"); },
    async waitForSubmitReady() { calls.push("wait-submit-ready"); return true; },
    async clickSubmit(policy) {
      calls.push(`submit:${policy.approvalFlow}:${policy.terminalAction}:${policy.stopImmediately}`);
    },
  };
}

test("repair orchestrator dry-run plans work without touching Recloud", async () => {
  const adapter = remoteAdapter();
  const result = await orchestrateRepairCompletion("ORDER-1", PAYLOAD, adapter, { writeEnabled: false });
  assert.equal(result.status, "READY_DRY_RUN");
  assert.deepEqual(result.additions, { assignment: true, parts: 1, attachments: 1 });
  assert.deepEqual(result.skipped, { assignment: false, parts: 0, attachments: 0 });
  assert.deepEqual(adapter.calls, ["read"]);
  assert.equal(result.finalConfirmClicked, false);
  assert.equal(result.recloudModified, false);
});

test("repair orchestrator clicks complete and stops immediately after final submit", async () => {
  const adapter = remoteAdapter();
  const checkpoints = [];
  const result = await orchestrateRepairCompletion("ORDER-1", PAYLOAD, adapter, {
    writeEnabled: true,
    checkpointStore: { async load() { return null; }, async save(value) { checkpoints.push(value); } },
  });
  assert.equal(result.status, "SUCCESS");
  assert.deepEqual(result.completedSteps, ["ASSIGNEE_VERIFIED", "PARTS_VERIFIED", "FIELDS_VERIFIED", "ATTACHMENTS_VERIFIED", "COMPLETE_CLICKED", "SUBMIT_READY", "SUBMIT_CLICKED_STOPPED"]);
  assert.equal(result.finalConfirmClicked, true);
  assert.equal(result.stoppedImmediatelyAfterSubmit, true);
  assert.equal(result.postSubmitActions, 0);
  assert.deepEqual(adapter.calls, [
    "read", "assign:唐张帅:负责人:协助", "read", "parts:DIRECT_CODE_INPUT:新件名称:放大镜", "read", "fields", "verify-fields", "read",
    "attachments:附件:附件（检测报告）", "read", "complete", "wait-submit-ready",
    "submit:内部维修单自动审批（成都欣益）:提交:true",
  ]);
  assert.equal(checkpoints.at(-1).status, "SUCCESS");
});

test("repair orchestrator skips reassignment only when the responsible technician already matches", async () => {
  const adapter = remoteAdapter({ assignee: "唐张帅" });
  const result = await orchestrateRepairCompletion("ORDER-1", PAYLOAD, adapter, { writeEnabled: false });
  assert.equal(result.additions.assignment, false);
  assert.equal(result.skipped.assignment, true);
  assert.deepEqual(adapter.calls, ["read"]);
});

test("repair orchestrator stops when responsible-person verification fails", async () => {
  const adapter = remoteAdapter();
  adapter.assignResponsible = async (plan) => {
    adapter.calls.push(`assign:${plan.servicePerson}:${plan.action}:${plan.forbiddenAction}`);
  };
  await assert.rejects(
    orchestrateRepairCompletion("ORDER-1", PAYLOAD, adapter, { writeEnabled: true }),
    { code: "RECLOUD_REPAIR_ASSIGNMENT_POSTVERIFY_FAILED", phase: "ASSIGNMENT" }
  );
  assert.equal(adapter.calls.some((call) => call.startsWith("parts:")), false);
});

test("repair orchestrator never submits when Recloud does not become submit-ready", async () => {
  const adapter = remoteAdapter();
  adapter.waitForSubmitReady = async () => { adapter.calls.push("wait-submit-ready"); return false; };
  await assert.rejects(
    orchestrateRepairCompletion("ORDER-1", PAYLOAD, adapter, { writeEnabled: true }),
    { code: "RECLOUD_REPAIR_SUBMIT_NOT_READY", phase: "WAIT_SUBMIT_READY" }
  );
  assert.equal(adapter.calls.includes("submit"), false);
});

test("repair orchestrator never trusts a checkpoint without rereading Recloud", async () => {
  const adapter = remoteAdapter();
  const first = await orchestrateRepairCompletion("ORDER-1", PAYLOAD, adapter, { writeEnabled: false });
  assert.equal(first.status, "READY_DRY_RUN");
  const checkpointStore = {
    async load() { return { fingerprint: "stale-or-matching-does-not-skip-read", completedSteps: ["PARTS_VERIFIED"] }; },
    async save() {},
  };
  await orchestrateRepairCompletion("ORDER-1", PAYLOAD, adapter, { writeEnabled: false, checkpointStore });
  assert.equal(adapter.calls.filter((call) => call === "read").length, 2);
});

test("repair orchestrator routes remote conflicts to manual review before writes", async () => {
  const adapter = remoteAdapter({ parts: [{ partCode: "PART-1", quantity: 2 }] });
  const result = await orchestrateRepairCompletion("ORDER-1", PAYLOAD, adapter, { writeEnabled: true });
  assert.equal(result.status, "MANUAL_REVIEW");
  assert.equal(result.reviewReasons[0].step, "PARTS");
  assert.deepEqual(adapter.calls, ["read"]);
  assert.equal(result.finalConfirmClicked, false);
});
