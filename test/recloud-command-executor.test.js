const test = require("node:test");
const assert = require("node:assert/strict");
const { createRecloudCommandExecutor } = require("../services/recloud-command-executor");
const { repairCompletionFingerprint } = require("../services/recloud-repair-completion-orchestrator");

const task = {
  rmaNo: "JXTH900001234",
  workOrderNo: "JXTH900001234",
  payload: {
    assignee: "唐张帅",
    faultLevel1: "产品质量",
    faultLevel2: "漏水",
    faultLevel3: "单向阀不良",
    responsibilityType: "保内质保",
    detectionResult: "维修",
    repairMeasure: "更换单向阀，测试正常寄回",
    repairPreparationCompletedAt: "2026-09-05T00:00:00.000Z",
    usedParts: [],
    attachments: [{ fileName: "finish.jpg", path: "/safe/finish.jpg", size: 200000, mimeType: "image/jpeg" }],
  },
};

function remoteAdapter(calls) {
  return {
    async readRemoteState() {
      calls.push("read");
      return { assignee: "唐张帅", parts: [], attachments: [{ fileName: "finish.jpg", size: 200000, mimeType: "image/jpeg" }] };
    },
    async applyRepairFields() { calls.push("fields"); },
    async verifyRepairFields() { calls.push("verify-fields"); return true; },
    async clickComplete() { calls.push("complete"); },
    async waitForSubmitReady() { calls.push("wait"); return true; },
    async clickSubmit(policy) { calls.push(`submit:${policy.stopImmediately}`); },
  };
}

for (const completed of [true, false]) {
  test(`reconciliation reads only and requires fully submitted=${completed}`, async () => {
    const received = { ...task, nodeType: "REPAIR_COMPLETED" };
    const calls = [];
    const executor = createRecloudCommandExecutor({
      checkpointStore: { load: async () => ({ status: "SUBMITTING",
        fingerprint: repairCompletionFingerprint(task.rmaNo, task.payload) }) },
      repairAdapterProvider: { run: async (_, inspect) => inspect({
        readRemoteState: async () => { calls.push("read"); return { completed }; },
        clickSubmit: () => assert.fail("reconciliation must not write"),
      }) },
    });
    const result = await executor.reconcileTask(received);
    assert.equal(result?.status || null, completed ? "SUCCESS" : null);
    assert.deepEqual(calls, ["read"]);
  });
}

test("changed payload cannot be reconciled using an older submit checkpoint", async () => {
  const executor = createRecloudCommandExecutor({
    checkpointStore: { load: async () => ({ status: "SUBMITTING", fingerprint: "old" }) },
    repairAdapterProvider: { run: () => assert.fail("mismatched checkpoint must not open browser") },
  });
  assert.equal(await executor.reconcileTask({ ...task, nodeType: "REPAIR_COMPLETED" }), null);
});

test("command executor delegates repair completion to the guarded two-step orchestrator", async () => {
  const calls = [];
  const adapter = remoteAdapter(calls);
  const executor = createRecloudCommandExecutor({
    writeEnabled: true,
    repairAdapterProvider: {
      async open(received) { calls.push(`open:${received.rmaNo}`); return adapter; },
      async release() { calls.push("release"); },
    },
  });
  const result = await executor.syncRepairCompleted(task);
  assert.equal(result.status, "SUCCESS");
  assert.deepEqual(calls, [
    "open:JXTH900001234", "read", "read", "fields", "verify-fields",
    "complete", "wait", "submit:true", "release",
  ]);
});

test("command executor remains read-only unless real writes are explicitly enabled", async () => {
  const calls = [];
  const executor = createRecloudCommandExecutor({
    writeEnabled: false,
    repairAdapterProvider: { async open() { return remoteAdapter(calls); } },
  });
  const result = await executor.syncRepairCompleted(task);
  assert.equal(result.status, "READY_DRY_RUN");
  assert.deepEqual(calls, ["read"]);
});

test("command executor can keep the Recloud page lock for the full completion run", async () => {
  const calls = [];
  const adapter = remoteAdapter(calls);
  const executor = createRecloudCommandExecutor({
    writeEnabled: true,
    repairAdapterProvider: {
      async run(received, work) {
        calls.push(`run:${received.rmaNo}`);
        return work(adapter);
      },
    },
  });
  assert.equal(executor.isReady("repair"), true);
  const result = await executor.syncRepairCompleted(task);
  assert.equal(result.status, "SUCCESS");
  assert.deepEqual(calls, [
    "run:JXTH900001234", "read", "read", "fields", "verify-fields",
    "complete", "wait", "submit:true",
  ]);
});

test("command executor fails closed when the page adapter is not configured", async () => {
  const executor = createRecloudCommandExecutor({ writeEnabled: true });
  await assert.rejects(executor.syncRepairCompleted(task), {
    code: "RECLOUD_REPAIR_PAGE_ADAPTER_NOT_CONFIGURED",
    permanent: true,
  });
});

test("command executor always releases the page adapter after a write failure", async () => {
  const calls = [];
  const adapter = remoteAdapter(calls);
  adapter.verifyRepairFields = async () => false;
  const executor = createRecloudCommandExecutor({
    writeEnabled: true,
    repairAdapterProvider: {
      async open() { return adapter; },
      async release() { calls.push("release"); },
    },
  });
  await assert.rejects(executor.syncRepairCompleted(task), {
    code: "RECLOUD_REPAIR_FIELD_POSTVERIFY_FAILED",
  });
  assert.equal(calls.at(-1), "release");
  assert.equal(calls.includes("complete"), false);
});
