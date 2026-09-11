const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { JsonRecloudSyncOutbox, TASK_STATUS } = require("../database/recloud-sync-outbox");
const { RecloudSyncService, NODE_METHODS } = require("../services/recloud-sync-service");

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fielddesk-recovery-injection-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return new JsonRecloudSyncOutbox(path.join(dir, "outbox.json"));
}
function enqueue(outbox, nodeType, key) {
  return outbox.enqueue({ rmaNo: `SYNTHETIC-${key}`, nodeType, idempotencyKey: key, payload: {} });
}

for (const outcome of ["SUCCESS", "NOT_CONFIRMED", "THROW"]) {
  test(`uncertain result reconciliation ${outcome} never repeats remote write`, async t => {
    const outbox = await fixture(t);
    const task = await enqueue(outbox, "REPAIR_COMPLETED", `reconcile-${outcome}`);
    await outbox.transition(task.id, TASK_STATUS.PROCESSING);
    await outbox.transition(task.id, TASK_STATUS.MANUAL_REVIEW, { reconciliationRequired: true });
    const service = new RecloudSyncService(outbox, {
      syncRepairCompleted: () => assert.fail("must not repeat remote write"),
      reconcileTask: async () => {
        if (outcome === "THROW") throw new Error("synthetic offline");
        return { status: outcome };
      },
    }, { scheduler: () => {} });
    await service.reconcileTask(task.id);
    await service.processTask(task.id);
    const saved = await outbox.get(task.id);
    assert.equal(saved.status, outcome === "SUCCESS" ? TASK_STATUS.SUCCESS : TASK_STATUS.MANUAL_REVIEW);
    assert.equal(saved.reconciliationRequired, outcome !== "SUCCESS");
  });
}

test("slow reconciliation does not block normal scheduling and has a cooldown", async t => {
  const outbox = await fixture(t);
  const uncertain = await enqueue(outbox, "REPAIR_COMPLETED", "slow-check");
  await outbox.transition(uncertain.id, TASK_STATUS.PROCESSING);
  await outbox.transition(uncertain.id, TASK_STATUS.MANUAL_REVIEW, { reconciliationRequired: true });
  const normal = await enqueue(outbox, "RECEIPT", "normal-during-check");
  const jobs = [];
  let finish;
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  const pendingRead = new Promise(resolve => { finish = resolve; });
  const service = new RecloudSyncService(outbox, {
    reconcileTask: async () => { started(); return pendingRead; },
    syncReceipt: async () => ({ status: "SUCCESS" }),
  }, { scheduler: job => jobs.push(job) });
  assert.equal(await service.resumePendingTasks(), 1);
  const normalWork = jobs.shift()();
  const checkWork = jobs.shift()();
  await entered;
  await normalWork;
  assert.equal((await outbox.get(normal.id)).status, TASK_STATUS.SUCCESS);
  await service.resumePendingTasks();
  assert.equal(jobs.length, 0);
  finish(null);
  await checkWork;
  await service.resumePendingTasks();
  assert.equal(jobs.length, 0);
});

for (const [node, method] of Object.entries(NODE_METHODS)) {
  test(`${node}: known pre-submit failure can retry without losing its task`, async t => {
    const outbox = await fixture(t);
    let calls = 0;
    const service = new RecloudSyncService(outbox, { [method]: async () => {
      if (++calls === 1) throw Object.assign(new Error("synthetic offline before submit"), { code: "RECLOUD_NETWORK_ERROR" });
      return { status: "SUCCESS" };
    } }, { scheduler: () => {}, retryScheduler: () => {} });
    const task = await enqueue(outbox, node, "network");
    await service.processTask(task.id);
    assert.equal((await outbox.get(task.id)).status, TASK_STATUS.FAILED);
    await service.processTask(task.id);
    assert.equal((await outbox.get(task.id)).status, TASK_STATUS.SUCCESS);
    assert.equal((await outbox.readAll()).length, 1);
  });

  test(`${node}: response lost after submit must not replay, even on manual retry`, async t => {
    const outbox = await fixture(t);
    let submissions = 0;
    const service = new RecloudSyncService(outbox, { [method]: async () => {
      submissions++;
      throw Object.assign(new Error("synthetic response lost"), { code: "RECLOUD_NETWORK_ERROR", resultUnknown: true });
    } }, { scheduler: () => {}, retryScheduler: () => { assert.fail("unknown outcome retried"); } });
    const task = await enqueue(outbox, node, "unknown");
    await service.processTask(task.id);
    assert.equal((await outbox.get(task.id)).status, TASK_STATUS.MANUAL_REVIEW);
    await assert.rejects(service.retry(task.id), { code: "SYNC_TASK_RECONCILIATION_REQUIRED" });
    await service.processTask(task.id);
    assert.equal(submissions, 1);
  });

  test(`${node}: restart preserves interrupted intent without another remote submission`, async t => {
    const outbox = await fixture(t);
    const interrupted = await enqueue(outbox, node, "interrupted");
    await outbox.transition(interrupted.id, TASK_STATUS.PROCESSING);
    const records = await outbox.readAll();
    records[0].updatedAt = "2000-01-01T00:00:00.000Z";
    await outbox.writeAll(records);
    const reopened = new JsonRecloudSyncOutbox(outbox.filePath);
    const service = new RecloudSyncService(reopened, { [method]: async () => assert.fail("interrupted task replayed") });
    assert.equal(await service.resumePendingTasks(), 0);
    assert.equal((await reopened.get(interrupted.id)).reconciliationRequired, true);
  });
}

test("one uncertain order does not block 59 other orders", async t => {
  const outbox = await fixture(t);
  const tasks = await Promise.all(Array.from({ length: 60 }, (_, i) => enqueue(outbox, "RECEIPT", `worker-${i}`)));
  const service = new RecloudSyncService(outbox, { syncReceipt: async task => {
    if (task.id === tasks[0].id) throw Object.assign(new Error("synthetic uncertain result"), { resultUnknown: true });
    return { status: "SUCCESS" };
  } }, { scheduler: () => {} });
  await Promise.all(tasks.map(task => service.processTask(task.id)));
  const records = await outbox.readAll();
  assert.equal(records.filter(task => task.status === TASK_STATUS.SUCCESS).length, 59);
  assert.equal(records.filter(task => task.status === TASK_STATUS.MANUAL_REVIEW).length, 1);
  assert.equal(service.activeTaskIds.size, 0);
});

test("scheduler failure releases the reservation so a later sweep can recover", async t => {
  const service = new RecloudSyncService(await fixture(t), {}, { scheduler: () => {} });
  assert.throws(() => service.scheduleTask("synthetic", () => { throw new Error("scheduler unavailable"); }));
  assert.equal(service.scheduledTaskIds.size, 0);
  assert.equal(service.scheduleTask("synthetic"), true);
});

for (const status of ["AWAITING_PARTS", "AWAITING_INFORMATION_CLERK"]) {
  test(`${status}: local callback failure recovers without another remote call`, async t => {
    const outbox = await fixture(t);
    let remoteCalls = 0;
    let localCalls = 0;
    const callback = async () => {
      if (++localCalls === 1) throw new Error("synthetic local store unavailable");
    };
    const service = new RecloudSyncService(outbox, { syncRepairCompleted: async () => {
      remoteCalls++;
      return { status, missingParts: [], informationClerkAction: "核对", completedSteps: [] };
    } }, { scheduler: () => {}, retryScheduler: () => {},
      onRepairPartsShortage: callback, onInspectionOnlyAwaitingInformation: callback,
      refreshTaskPayload: () => assert.fail("local recovery must preserve original payload"),
    });
    const task = await enqueue(outbox, "REPAIR_COMPLETED", status);
    await service.processTask(task.id);
    assert.equal((await outbox.get(task.id)).status, TASK_STATUS.FAILED);
    await service.processTask(task.id);
    assert.equal((await outbox.get(task.id)).status, TASK_STATUS.SUCCESS);
    assert.equal(remoteCalls, 1);
    assert.equal(localCalls, 2);
  });
}

test("persisted remote result survives restart and completes locally", async t => {
  const outbox = await fixture(t);
  const task = await enqueue(outbox, "RECEIPT", "local-restart");
  await outbox.transition(task.id, TASK_STATUS.PROCESSING, { localRecoveryResult: { status: "SUCCESS" } });
  const records = await outbox.readAll();
  records[0].updatedAt = "2000-01-01T00:00:00.000Z";
  await outbox.writeAll(records);
  const reopened = new JsonRecloudSyncOutbox(outbox.filePath);
  const service = new RecloudSyncService(reopened, {}, { scheduler: () => {},
    canProcessTask: () => assert.fail("local recovery should not wait for remote dependencies"),
  });
  assert.equal(await service.resumePendingTasks(), 1);
  await service.processTask(task.id);
  assert.equal((await reopened.get(task.id)).status, TASK_STATUS.SUCCESS);
});

test("failed persistence of remote result requires reconciliation", async t => {
  const outbox = await fixture(t);
  const originalUpdate = outbox.update.bind(outbox);
  outbox.update = async (id, fields) => {
    if (fields.localRecoveryResult) throw new Error("synthetic disk failure");
    return originalUpdate(id, fields);
  };
  const service = new RecloudSyncService(outbox, { syncReceipt: async () => ({ status: "SUCCESS" }) });
  const task = await enqueue(outbox, "RECEIPT", "result-disk-failure");
  await service.processTask(task.id);
  assert.equal((await outbox.get(task.id)).reconciliationRequired, true);
  await assert.rejects(service.retry(task.id), { code: "SYNC_TASK_RECONCILIATION_REQUIRED" });
});

test("final status write failure retries only local finalization", async t => {
  const outbox = await fixture(t);
  const transition = outbox.transition.bind(outbox);
  let failOnce = true;
  let calls = 0;
  outbox.transition = async (id, status, fields) => {
    if (status === TASK_STATUS.SUCCESS && failOnce) {
      failOnce = false;
      throw new Error("synthetic final status write failed");
    }
    return transition(id, status, fields);
  };
  const service = new RecloudSyncService(outbox, { syncReceipt: async () => {
    calls++;
    return { status: "SUCCESS" };
  } }, { scheduler: () => {}, retryScheduler: () => {} });
  const task = await enqueue(outbox, "RECEIPT", "final-write");
  await service.processTask(task.id);
  assert.equal((await outbox.get(task.id)).status, TASK_STATUS.FAILED);
  await service.retry(task.id);
  await service.processTask(task.id);
  assert.equal((await outbox.get(task.id)).status, TASK_STATUS.SUCCESS);
  assert.equal(calls, 1);
});
