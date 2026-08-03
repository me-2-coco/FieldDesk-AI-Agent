const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { JsonRecloudSyncOutbox, TASK_STATUS } = require("../database/recloud-sync-outbox");
const {
  DryRunRecloudAdapter,
  RealRecloudAdapter,
  createRecloudAdapter,
} = require("../connectors/recloud-adapter");
const { RecloudSyncService } = require("../services/recloud-sync-service");

async function outboxFixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fielddesk-sync-outbox-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return new JsonRecloudSyncOutbox(path.join(directory, "outbox.json"));
}

const ORDER = {
  id: "LOCAL-WORK-1", rmaNo: "RMA-MOCK-1", logisticsNo: "LOGISTICS-MOCK-1", sn: "SN-MOCK-1",
};

test("outbox stores required safe fields and enforces idempotency", async (t) => {
  const outbox = await outboxFixture(t);
  const service = new RecloudSyncService(outbox, new DryRunRecloudAdapter(), { scheduler: () => {} });
  const first = await service.enqueueOrderNode(ORDER, "RECEIPT", "RECEIPT-RECORD-1");
  const second = await service.enqueueOrderNode(ORDER, "RECEIPT", "RECEIPT-RECORD-1");
  assert.equal(first.id, second.id);
  assert.equal((await outbox.readAll()).length, 1);
  assert.equal(first.status, TASK_STATUS.PENDING);
  assert.deepEqual(
    [first.workOrderNo, first.rmaNo, first.logisticsNo, first.sn, first.nodeType, first.localBusinessRecordId],
    ["LOCAL-WORK-1", "RMA-MOCK-1", "LOGISTICS-MOCK-1", "SN-MOCK-1", "RECEIPT", "RECEIPT-RECORD-1"]
  );
  assert.equal("customerName" in first, false);
  assert.equal("phone" in first, false);
});

test("dry-run adapter processes every business node without real Recloud", async (t) => {
  const outbox = await outboxFixture(t);
  const adapter = new DryRunRecloudAdapter();
  const service = new RecloudSyncService(outbox, adapter, { scheduler: () => {} });
  const nodes = ["RECEIPT", "INSPECTION_COMPLETED", "REPAIR_COMPLETED", "RETURN_SHIPPED", "ORDER_COMPLETED"];
  for (const node of nodes) {
    const task = await service.enqueueOrderNode(ORDER, node, `${node}-RECORD`);
    const completed = await service.processTask(task.id);
    assert.equal(completed.status, TASK_STATUS.SUCCESS);
  }
});

test("adapter factory never selects real adapter when either safety switch blocks writes", () => {
  assert.ok(createRecloudAdapter({ DRY_RUN: "true", RECLOUD_WRITE_ENABLED: "true" }) instanceof DryRunRecloudAdapter);
  assert.ok(createRecloudAdapter({ DRY_RUN: "false", RECLOUD_WRITE_ENABLED: "false" }) instanceof DryRunRecloudAdapter);
  assert.ok(createRecloudAdapter({ DRY_RUN: "false", RECLOUD_WRITE_ENABLED: "true" }) instanceof RealRecloudAdapter);
});

test("real adapter skeleton returns not enabled without opening Recloud", async () => {
  const adapter = new RealRecloudAdapter();
  await assert.rejects(adapter.syncReceipt({}), { code: "RECLOUD_SYNC_NOT_ENABLED" });
});

test("failed tasks can be retried and permanent failures require manual review", async (t) => {
  const outbox = await outboxFixture(t);
  const scheduled = [];
  const adapter = {
    async syncReceipt() { throw Object.assign(new Error("unsafe detail must not persist"), { code: "PRIVATE_REMOTE_ERROR" }); },
  };
  const service = new RecloudSyncService(outbox, adapter, { scheduler: (work) => scheduled.push(work), maxRetries: 3 });
  const task = await service.enqueueOrderNode(ORDER, "RECEIPT", "FAIL-1");
  const failed = await service.processTask(task.id);
  assert.equal(failed.status, TASK_STATUS.FAILED);
  assert.equal(failed.retryCount, 1);
  assert.equal(failed.lastError, "RECLOUD_SYNC_FAILED");
  const pending = await service.retry(task.id);
  assert.equal(pending.status, TASK_STATUS.PENDING);
  assert.ok(scheduled.length >= 2);

  const permanentService = new RecloudSyncService(outbox, new RealRecloudAdapter(), { scheduler: () => {} });
  const permanentTask = await permanentService.enqueueOrderNode(ORDER, "ORDER_COMPLETED", "PERMANENT-1");
  const manual = await permanentService.processTask(permanentTask.id);
  assert.equal(manual.status, TASK_STATUS.MANUAL_REVIEW);
  assert.equal(manual.lastError, "RECLOUD_SYNC_NOT_ENABLED");
});

test("admin page exposes task status and retry while server hooks all five nodes", async () => {
  const page = await fs.readFile(path.join(__dirname, "../frontend/src/pages/SyncTasks.jsx"), "utf8");
  assert.match(page, /FAILED/);
  assert.match(page, /MANUAL_REVIEW/);
  assert.match(page, /人工重试/);
  const server = await fs.readFile(path.join(__dirname, "../server.js"), "utf8");
  for (const node of ["RECEIPT", "INSPECTION_COMPLETED", "REPAIR_COMPLETED", "RETURN_SHIPPED", "ORDER_COMPLETED"]) {
    assert.match(server, new RegExp(`enqueueRecloudNode\\([\\s\\S]{0,180}\"${node}\"`));
  }
  assert.match(server, /user\.role !== USER_ROLES\.ADMIN/);
});
