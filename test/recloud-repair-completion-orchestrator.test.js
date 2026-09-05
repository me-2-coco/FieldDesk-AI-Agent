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
    async readRemoteAttachments() { calls.push("read-attachments"); return [...attachments]; },
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
  const adapter = remoteAdapter({ assignee: "唐张帅", parts: PAYLOAD.usedParts });
  const checkpoints = [];
  const result = await orchestrateRepairCompletion("ORDER-1", PAYLOAD, adapter, {
    writeEnabled: true,
    preparationCompleted: true,
    checkpointStore: { async load() { return null; }, async save(value) { checkpoints.push(value); } },
  });
  assert.equal(result.status, "SUCCESS");
  assert.deepEqual(result.completedSteps, ["ASSIGNEE_VERIFIED", "PARTS_VERIFIED", "FIELDS_VERIFIED", "ATTACHMENTS_VERIFIED", "COMPLETE_CLICKED", "SUBMIT_READY", "SUBMIT_CLICKED_STOPPED"]);
  assert.equal(result.finalConfirmClicked, true);
  assert.equal(result.stoppedImmediatelyAfterSubmit, true);
  assert.equal(result.postSubmitActions, 0);
  assert.deepEqual(adapter.calls, [
    "read", "fields", "verify-fields", "read-attachments",
    "attachments:附件:附件（检测报告）", "read-attachments", "complete", "wait-submit-ready",
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

test("repair orchestrator never retries assignment from the completion stage", async () => {
  const adapter = remoteAdapter();
  await assert.rejects(
    orchestrateRepairCompletion("ORDER-1", PAYLOAD, adapter, { writeEnabled: true, preparationCompleted: true }),
    { code: "RECLOUD_REPAIR_PREPARATION_ASSIGNEE_MISMATCH", phase: "PREPARATION_VERIFY" }
  );
  assert.deepEqual(adapter.calls, ["read"]);
  assert.equal(adapter.calls.some((call) => call.startsWith("assign:")), false);
  assert.equal(adapter.calls.some((call) => call.startsWith("parts:")), false);
});

test("repair orchestrator reconciles an unconfirmed first-entry record from matching remote state", async () => {
  const adapter = remoteAdapter({ assignee: "唐张帅", parts: PAYLOAD.usedParts });
  const result = await orchestrateRepairCompletion("ORDER-1", PAYLOAD, adapter, { writeEnabled: true });
  assert.equal(result.status, "SUCCESS");
  assert.ok(adapter.calls.some((call) => call.startsWith("submit:")));
});

test("repair orchestrator still blocks when an unconfirmed first-entry record differs remotely", async () => {
  const adapter = remoteAdapter({ assignee: "其他师傅", parts: PAYLOAD.usedParts });
  await assert.rejects(
    orchestrateRepairCompletion("ORDER-1", PAYLOAD, adapter, { writeEnabled: true }),
    { code: "RECLOUD_REPAIR_PREPARATION_ASSIGNEE_MISMATCH", phase: "PREPARATION_VERIFY" }
  );
  assert.deepEqual(adapter.calls, ["read"]);
});

test("repair orchestrator reports missing preparation parts distinctly", async () => {
  const missingAdapter = remoteAdapter({ assignee: "唐张帅", parts: [] });
  await assert.rejects(
    orchestrateRepairCompletion("ORDER-MISSING", PAYLOAD, missingAdapter, { writeEnabled: true }),
    { code: "RECLOUD_REPAIR_PREPARATION_PARTS_MISSING", phase: "PREPARATION_VERIFY" }
  );
});

test("repair orchestrator recovers only missing parts for an explicitly failed preparation", async () => {
  const adapter = remoteAdapter({ assignee: "唐张帅", parts: [] });
  const result = await orchestrateRepairCompletion("ORDER-RECOVERY", PAYLOAD, adapter, {
    writeEnabled: true,
    allowPreparationRecovery: true,
  });
  assert.equal(result.status, "SUCCESS");
  assert.equal(adapter.calls.some((call) => call.startsWith("assign:")), false);
  assert.equal(adapter.calls.some((call) => call.startsWith("parts:")), true);
  assert.equal(adapter.calls.some((call) => call.startsWith("submit:")), true);
});

test("repair orchestrator skips only an explicitly authorized missing part code", async () => {
  const adapter = remoteAdapter({ assignee: "唐张帅", parts: [] });
  const result = await orchestrateRepairCompletion("ORDER-AUTHORIZED-SKIP", PAYLOAD, adapter, {
    writeEnabled: true,
    authorizedSkippedPartCodes: ["PART-1"],
  });
  assert.equal(result.status, "SUCCESS");
  assert.equal(result.completedSteps.includes("PARTS_VERIFIED_WITH_AUTHORIZED_SKIP"), true);
  assert.equal(adapter.calls.some((call) => call.startsWith("parts:")), false);
  assert.equal(adapter.calls.some((call) => call.startsWith("submit:")), true);
});

test("parts shortage confirms completion but never touches submit", async () => {
  const adapter = remoteAdapter({ assignee: "唐张帅", parts: [] });
  const missingParts = [{ ...PAYLOAD.usedParts[0], reason: "瑞云库存不足" }];
  const result = await orchestrateRepairCompletion("ORDER-SHORTAGE", PAYLOAD, adapter, {
    writeEnabled: true,
    preparationCompleted: true,
    missingParts,
  });
  assert.equal(result.status, "AWAITING_PARTS");
  assert.equal(result.completeClicked, true);
  assert.equal(result.finalConfirmClicked, false);
  assert.equal(result.stoppedBeforeSubmit, true);
  assert.deepEqual(result.missingParts, missingParts);
  assert.equal(adapter.calls.includes("complete"), true);
  assert.equal(adapter.calls.includes("wait-submit-ready"), false);
  assert.equal(adapter.calls.some((call) => call.startsWith("submit:")), false);
});

test("repair orchestrator never submits when Recloud does not become submit-ready", async () => {
  const adapter = remoteAdapter({ assignee: "唐张帅", parts: PAYLOAD.usedParts });
  adapter.waitForSubmitReady = async () => { adapter.calls.push("wait-submit-ready"); return false; };
  await assert.rejects(
    orchestrateRepairCompletion("ORDER-1", PAYLOAD, adapter, { writeEnabled: true, preparationCompleted: true }),
    { code: "RECLOUD_REPAIR_SUBMIT_NOT_READY", phase: "WAIT_SUBMIT_READY" }
  );
  assert.equal(adapter.calls.includes("submit"), false);
});

test("repair orchestrator prints required old-part labels before final submit", async () => {
  const labelParts = PAYLOAD.usedParts.map((part) => ({ ...part, returnRequired: true }));
  const adapter = remoteAdapter({ assignee: "唐张帅", parts: labelParts });
  adapter.printOldPartLabels = async (parts) => adapter.calls.push(`labels:${parts.length}`);
  const result = await orchestrateRepairCompletion("ORDER-LABEL", {
    ...PAYLOAD,
    usedParts: labelParts,
  }, adapter, { writeEnabled: true, preparationCompleted: true });
  assert.equal(result.status, "SUCCESS");
  assert.ok(result.completedSteps.includes("OLD_PART_LABELS_PRINTED"));
  assert.ok(adapter.calls.indexOf("labels:1") < adapter.calls.findIndex((item) => item.startsWith("submit:")));
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
