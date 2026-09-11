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
