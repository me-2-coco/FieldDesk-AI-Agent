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

for (const failure of ['response-lost', 'readback-failed', 'local-save-failed']) {
  test(`attachment uncertainty survives restart without reupload: ${failure}`, async () => {
    const adapter = remoteAdapter({ assignee: PAYLOAD.assignee, parts: PAYLOAD.usedParts });
    let checkpoint = null; let uploads = 0;
    const upload = adapter.uploadAttachments.bind(adapter);
    adapter.uploadAttachments = async (...args) => {
      uploads++;
      await upload(...args);
      if (failure === 'response-lost') throw new Error('synthetic network failure');
    };
    const read = adapter.readRemoteAttachments.bind(adapter);
    adapter.readRemoteAttachments = async (...args) => {
      if (uploads && failure === 'readback-failed') throw new Error('synthetic read failure');
      return read(...args);
    };
    const checkpointStore = {
      async load() { return checkpoint; },
      async save(value) {
        if (uploads && value.completedSteps.includes('ATTACHMENTS_VERIFIED') && failure === 'local-save-failed') throw new Error('synthetic disk failure');
        checkpoint = structuredClone(value);
      },
    };
    const options = { writeEnabled: true, preparationCompleted: true, checkpointStore };
    await assert.rejects(orchestrateRepairCompletion('LAB-ATTACHMENTS', PAYLOAD, adapter, options), {
      code: 'RECLOUD_REPAIR_ATTACHMENT_UPLOAD_UNCERTAIN', resultUnknown: true, permanent: true,
    });
    assert.equal(checkpoint.status, 'ATTACHMENTS_UPLOADING');
    const priorCalls = adapter.calls.length;
    await assert.rejects(orchestrateRepairCompletion('LAB-ATTACHMENTS', { ...PAYLOAD, repairMeasure: 'changed' }, adapter, options), {
      code: 'RECLOUD_REPAIR_ATTACHMENT_UPLOAD_UNCERTAIN',
    });
    assert.equal(uploads, 1);
    assert.deepEqual(adapter.calls.slice(priorCalls), ['read']);
    assert.equal(adapter.calls.includes('fields'), false);
    assert.equal(adapter.calls.includes('complete'), false);
  });
}

test('failed pre-upload checkpoint prevents all attachment writes', async () => {
  const adapter = remoteAdapter({ assignee: PAYLOAD.assignee, parts: PAYLOAD.usedParts });
  await assert.rejects(orchestrateRepairCompletion('LAB-PREUPLOAD', PAYLOAD, adapter, {
    writeEnabled: true, preparationCompleted: true,
    checkpointStore: { async save(value) { if (value.status === 'ATTACHMENTS_UPLOADING') throw new Error('synthetic disk failure'); } },
  }));
  assert.equal(adapter.calls.some(call => call.startsWith('attachments:')), false);
});

function remoteAdapter(initial = {}) {
  let assignee = initial.assignee || "";
  let parts = initial.parts || [];
  let attachments = initial.attachments || [];
  let detectionReportAttachments = initial.detectionReportAttachments || [];
  const calls = [];
  return {
    calls,
    async readRemoteState() {
      calls.push("read");
      return {
        assignee,
        parts: [...parts],
        attachments: [...attachments],
        detectionReportAttachments: [...detectionReportAttachments],
        completed: initial.completed === true,
      };
    },
    async readRemoteAttachments({ target = "附件" } = {}) {
      calls.push(`read-attachments:${target}`);
      return target === "附件（检测报告）" ? [...detectionReportAttachments] : [...attachments];
    },
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
      calls.push(`attachments:${policy.target}`);
      if (policy.target === "附件（检测报告）") {
        detectionReportAttachments = plan.additions.map((item) => ({ ...item }));
      } else {
        attachments = plan.additions.map((item) => ({ ...item }));
      }
    },
    async clickComplete() { calls.push("complete"); },
    async waitForSubmitReady() { calls.push("wait-submit-ready"); return true; },
    async clickSubmit(policy) {
      calls.push(`submit:${policy.approvalFlow}:${policy.terminalAction}:${policy.stopImmediately}`);
    },
  };
}
for (const changes of [false, true]) {
  test(`verified repair attachment checkpoint resumes without upload; readback changes=${changes}`, async () => {
    const { repairAttachmentIdentity } = require('../services/repair-attachment-identity');
    const { repairCompletionFingerprint } = require('../services/recloud-repair-completion-orchestrator');
    const file = repairAttachmentIdentity('LAB-RESUME', PAYLOAD.attachments[0], Buffer.alloc(13062644, 1));
    const remoteFile = { ...file, size: 13065257, sizeRoundingBytes: 5243 };
    const adapter = remoteAdapter({ assignee: PAYLOAD.assignee, parts: PAYLOAD.usedParts, attachments: [remoteFile] });
    adapter.prepareAttachmentIdentities = async () => [file];
    adapter.uploadAttachments = async () => assert.fail('must not reupload');
    if (changes) adapter.readRemoteAttachments = async () => [];
    let saved = { orderKey: 'LAB-RESUME', status: 'ATTACHMENTS_UPLOADING', fingerprint: repairCompletionFingerprint('LAB-RESUME', PAYLOAD), attachmentManifest: [file.fileName] };
    const run = () => orchestrateRepairCompletion('LAB-RESUME', PAYLOAD, adapter, {
      writeEnabled: true, preparationCompleted: true,
      checkpointStore: { load: async () => saved, save: async value => { saved = value; } },
    });
    if (changes) {
      await assert.rejects(run(), { code: 'RECLOUD_REPAIR_ATTACHMENT_UPLOAD_UNCERTAIN' });
      assert.equal(saved.status, 'ATTACHMENTS_UPLOADING');
      assert.deepEqual(saved.attachmentManifest, [file.fileName]);
      assert.equal(adapter.calls.includes('fields'), false);
    } else assert.equal((await run()).status, 'SUCCESS');
  });
}

for (const failure of ["response-lost", "checkpoint-failed"]) {
  test(`submission uncertainty is quarantined: ${failure}`, async () => {
    const adapter = remoteAdapter({ assignee: PAYLOAD.assignee, parts: PAYLOAD.usedParts });
    let submits = 0;
    const checkpoints = [];
    adapter.clickSubmit = async () => {
      submits++;
      if (failure === "response-lost") throw new Error("synthetic connection closed");
    };
    await assert.rejects(orchestrateRepairCompletion("SYNTHETIC", PAYLOAD, adapter, {
      writeEnabled: true, preparationCompleted: true,
      checkpointStore: { async save(value) {
        if (value.status === "SUCCESS") throw new Error("synthetic disk failure");
        checkpoints.push(value.status);
      } },
    }), { code: "RECLOUD_REPAIR_SUBMIT_RESULT_UNKNOWN", resultUnknown: true, permanent: true });
    assert.equal(submits, 1);
    assert.equal(checkpoints.at(-1), "SUBMITTING");
  });
}

test("interrupted submission only reads remote state when completion is not proven", async () => {
  const adapter = remoteAdapter();
  await assert.rejects(orchestrateRepairCompletion("SYNTHETIC", PAYLOAD, adapter, {
    writeEnabled: true,
    checkpointStore: { async load() { return { status: "SUBMITTING", fingerprint: "older-payload" }; } },
  }), { code: "RECLOUD_REPAIR_SUBMIT_RESULT_UNKNOWN" });
  assert.deepEqual(adapter.calls, ["read"]);
});

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

test("normal repair uploads attachments, completes and submits Recloud", async () => {
  const adapter = remoteAdapter({ assignee: "唐张帅", parts: PAYLOAD.usedParts });
  const checkpoints = [];
  const result = await orchestrateRepairCompletion("ORDER-1", PAYLOAD, adapter, {
    writeEnabled: true,
    preparationCompleted: true,
    checkpointStore: { async load() { return null; }, async save(value) { checkpoints.push(value); } },
  });
  assert.equal(result.status, "SUCCESS");
  assert.deepEqual(result.completedSteps, ["ASSIGNEE_VERIFIED", "PARTS_VERIFIED", "ATTACHMENTS_VERIFIED", "FIELDS_VERIFIED", "COMPLETE_CLICKED", "SUBMIT_READY", "SUBMIT_CLICKED_STOPPED"]);
  assert.equal(result.finalConfirmClicked, true);
  assert.equal(result.stoppedImmediatelyAfterSubmit, true);
  assert.deepEqual(adapter.calls, [
    "read", "read-attachments:附件", "attachments:附件", "read-attachments:附件",
    "fields", "verify-fields", "complete", "wait-submit-ready",
    "submit:内部维修单自动审批（成都欣益）:提交:true",
  ]);
  assert.equal(checkpoints.at(-1).status, "SUCCESS");
});

test("inspection-only ignores old generated reports and stops before submit for the information clerk", async () => {
  const payload = {
    ...PAYLOAD,
    treatmentMode: "INSPECTION_ONLY",
    usedParts: [],
    attachments: [
      PAYLOAD.attachments[0],
      {
        fileName: "检测报告-JXTH-1.pdf",
        path: "/safe/检测报告-JXTH-1.pdf",
        size: 32000,
        mimeType: "application/pdf",
        source: "INSPECTION_REPORT",
        attachmentTarget: "DETECTION_REPORT_ATTACHMENT",
      },
    ],
  };
  const adapter = remoteAdapter({ assignee: "唐张帅", parts: [] });
  const result = await orchestrateRepairCompletion("ORDER-INSPECTION-ONLY", payload, adapter, {
    writeEnabled: true,
    preparationCompleted: true,
  });

  assert.equal(result.status, "AWAITING_INFORMATION_CLERK");
  assert.equal(result.completeClicked, true);
  assert.equal(result.stoppedBeforeSubmit, true);
  assert.equal(result.informationClerkAction, "开检测报告、上传检测报告、修改地址并提交");
  assert.equal(adapter.calls.includes("attachments:附件"), true);
  assert.equal(adapter.calls.includes("attachments:附件（检测报告）"), false);
  assert.equal(adapter.calls.includes("complete"), true);
  assert.equal(adapter.calls.includes("wait-submit-ready"), false);
  assert.equal(adapter.calls.some((call) => call.startsWith("submit:")), false);
});

test("repair orchestrator tolerates delayed Recloud field visibility", async () => {
  const adapter = remoteAdapter({ assignee: "唐张帅", parts: PAYLOAD.usedParts });
  let verificationCount = 0;
  adapter.verifyRepairFields = async () => {
    adapter.calls.push("verify-fields");
    verificationCount += 1;
    return verificationCount === 3;
  };
  adapter.waitForTimeout = async () => adapter.calls.push("wait-fields");
  const result = await orchestrateRepairCompletion("ORDER-DELAYED-FIELDS", PAYLOAD, adapter, {
    writeEnabled: true,
    preparationCompleted: true,
    fieldVerificationIntervalMs: 1,
  });
  assert.equal(result.status, "SUCCESS");
  assert.equal(verificationCount, 3);
  assert.equal(adapter.calls.filter((call) => call === "wait-fields").length, 2);
});

test("repair orchestrator updates fields but does not resubmit an already completed Recloud order", async () => {
  const adapter = remoteAdapter({
    assignee: "唐张帅",
    parts: PAYLOAD.usedParts,
    attachments: PAYLOAD.attachments,
    completed: true,
  });
  const result = await orchestrateRepairCompletion("ORDER-CORRECTION", PAYLOAD, adapter, {
    writeEnabled: true,
    preparationCompleted: true,
  });
  assert.equal(result.status, "SUCCESS");
  assert.equal(result.remoteAlreadyCompleted, true);
  assert.equal(adapter.calls.includes("fields"), true);
  assert.equal(adapter.calls.includes("complete"), false);
  assert.equal(adapter.calls.some((call) => call.startsWith("submit:")), false);
});

test("already completed inspection-only order still creates the information-clerk handoff", async () => {
  const payload = { ...PAYLOAD, treatmentMode: "INSPECTION_ONLY", usedParts: [] };
  const adapter = remoteAdapter({
    assignee: "唐张帅",
    parts: [],
    attachments: PAYLOAD.attachments,
    completed: true,
  });
  const result = await orchestrateRepairCompletion("ORDER-INSPECTION-RETRY", payload, adapter, {
    writeEnabled: true,
    preparationCompleted: true,
  });
  assert.equal(result.status, "AWAITING_INFORMATION_CLERK");
  assert.equal(result.remoteAlreadyCompleted, true);
  assert.equal(result.stoppedBeforeSubmit, true);
  assert.equal(adapter.calls.includes("complete"), false);
  assert.equal(adapter.calls.some((call) => call.startsWith("submit:")), false);
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
  assert.equal(adapter.calls.some((call) => call.startsWith("submit:")), true);
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

test("repair orchestrator preserves an explicitly authorized existing Recloud part", async () => {
  const adapter = remoteAdapter({
    assignee: "唐张帅",
    parts: [
      { partCode: "PART-1", quantity: 1 },
      { partCode: "KEEP-REMOTE", quantity: 1 },
    ],
  });
  const result = await orchestrateRepairCompletion("ORDER-AUTHORIZED-EXISTING", PAYLOAD, adapter, {
    writeEnabled: true,
    preparationCompleted: true,
    authorizedExistingPartCodes: ["KEEP-REMOTE"],
  });
  assert.equal(result.status, "SUCCESS");
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

test("an out-of-stock logistics box also completes without submitting and notifies information", async () => {
  const optionalBox = {
    partCode: "20020100011511",
    partName: "售后通用主机物流箱",
    quantity: 1,
    reason: "瑞云库存不足",
  };
  const payload = { ...PAYLOAD, usedParts: [optionalBox] };
  const adapter = remoteAdapter({ assignee: "唐张帅", parts: [] });
  const result = await orchestrateRepairCompletion("ORDER-OPTIONAL-BOX", payload, adapter, {
    writeEnabled: true,
    preparationCompleted: true,
    missingParts: [optionalBox],
  });
  assert.equal(result.status, "AWAITING_PARTS");
  assert.equal(result.completedSteps.includes("SUBMIT_SKIPPED_FOR_PARTS_SHORTAGE"), true);
  assert.equal(adapter.calls.includes("complete"), true);
  assert.equal(adapter.calls.includes("wait-submit-ready"), false);
  assert.equal(adapter.calls.some((call) => call.startsWith("submit:")), false);
});

test("normal repair stops safely when Recloud never becomes submit-ready", async () => {
  const adapter = remoteAdapter({ assignee: "唐张帅", parts: PAYLOAD.usedParts });
  adapter.waitForSubmitReady = async () => { adapter.calls.push("wait-submit-ready"); return false; };
  await assert.rejects(
    orchestrateRepairCompletion("ORDER-1", PAYLOAD, adapter, { writeEnabled: true, preparationCompleted: true }),
    { code: "RECLOUD_REPAIR_SUBMIT_NOT_READY", phase: "WAIT_SUBMIT_READY" }
  );
  assert.equal(adapter.calls.includes("wait-submit-ready"), true);
  assert.equal(adapter.calls.some((call) => call.startsWith("submit:")), false);
});

test("normal in-warranty repair prints old-part labels before submit", async () => {
  const labelParts = PAYLOAD.usedParts.map((part) => ({ ...part, returnRequired: true }));
  const adapter = remoteAdapter({ assignee: "唐张帅", parts: labelParts });
  adapter.printOldPartLabels = async (parts) => adapter.calls.push(`labels:${parts.length}`);
  const result = await orchestrateRepairCompletion("ORDER-LABEL", {
    ...PAYLOAD,
    usedParts: labelParts,
  }, adapter, { writeEnabled: true, preparationCompleted: true });
  assert.equal(result.status, "SUCCESS");
  assert.equal(result.completedSteps.includes("OLD_PART_LABELS_QUEUED"), true);
  assert.equal(adapter.calls.some((call) => call.startsWith("labels:")), true);
  assert.equal(adapter.calls.some((call) => call.startsWith("submit:")), true);
});

test("out-of-warranty repair skips old-part labels even when parts require return", async () => {
  const labelParts = PAYLOAD.usedParts.map((part) => ({ ...part, returnRequired: true }));
  const adapter = remoteAdapter({ assignee: "唐张帅", parts: labelParts });
  adapter.printOldPartLabels = async (parts) => adapter.calls.push(`labels:${parts.length}`);
  const result = await orchestrateRepairCompletion("ORDER-OUT-OF-WARRANTY-LABEL", {
    ...PAYLOAD,
    responsibilityType: "保外维修",
    pricing: { ...PAYLOAD.pricing, warrantyStatus: "OUT_OF_WARRANTY" },
    usedParts: labelParts,
  }, adapter, { writeEnabled: true, preparationCompleted: true });
  assert.equal(result.status, "SUCCESS");
  assert.equal(result.completedSteps.includes("OLD_PART_LABELS_QUEUED"), false);
  assert.equal(adapter.calls.some((call) => call.startsWith("labels:")), false);
  assert.equal(adapter.calls.some((call) => call.startsWith("submit:")), true);
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
