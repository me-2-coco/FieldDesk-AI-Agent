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
const { RecloudSyncService, classifyError } = require("../services/recloud-sync-service");
const {
  RECLOUD_REPAIR_FIELD_TARGETS,
  RECLOUD_RECEIPT_FIELD_TARGETS,
  buildRecloudRepairFormPlan,
  buildNodePayload,
  validateNodePayload,
} = require("../connectors/recloud-sync-mapping");

async function outboxFixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fielddesk-sync-outbox-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return new JsonRecloudSyncOutbox(path.join(directory, "outbox.json"));
}

const ORDER = {
  id: "LOCAL-WORK-1", rmaNo: "RMA-MOCK-1", logisticsNo: "LOGISTICS-MOCK-1", sn: "SN-MOCK-1",
  remark: "洗地机", specialty: "洗地机", productLine: "洗地机",
  receiptCompletedAt: "2026-08-03T01:00:00.000Z",
  receiptAttachments: [{ id: "MOCK-RECEIPT-PHOTO", name: "receipt.jpg", mimeType: "image/jpeg" }],
  inspectionResult: "模拟检测完成", inspectionRemark: "模拟备注",
  inspectionUpdatedAt: "2026-08-03T02:00:00.000Z",
  repairCompletion: {
    faultLevel1: "功能故障", faultLevel2: "清洁功能", faultLevel3: "不出水",
    responsibilityType: "保内质保", detectionResult: "维修后整机功能正常", repairMeasure: "模拟维修措施",
    usedParts: [{ partCode: "MOCK-PART", partName: "模拟配件", quantity: 1, repairLevel: "中修", retailPrice: 29, returnRequired: true }],
    pricing: { status: "IN_WARRANTY", partsFee: 0, fee: 0, oneWayLogisticsFee: 0, logisticsFee: 0, totalFee: 0 },
    attachments: [{ id: "MOCK-ATTACHMENT" }], submittedAt: "2026-08-03T03:00:00.000Z",
  },
  returnShipment: {
    logisticsCompany: "模拟物流", trackingNo: "MOCK-TRACKING",
    shippedAt: "2026-08-03T04:00:00.000Z", attachments: [{ id: "MOCK-PROOF" }],
  },
  completedAt: "2026-08-03T05:00:00.000Z",
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
  assert.equal(first.mappingVersion, "v6");
  assert.deepEqual(first.payload, buildNodePayload(ORDER, "RECEIPT"));
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

test("real adapter blocks writes until the matching diagnostic node is ready", async () => {
  let executions = 0;
  const adapter = new RealRecloudAdapter({
    readinessProvider: {
      async inspect(nodeKey) {
        assert.equal(nodeKey, "receipt");
        return { status: "CAPTURED", missingFields: ["successCriteriaFieldNames"] };
      },
    },
    commandExecutor: {
      async syncReceipt() { executions += 1; },
    },
  });
  await assert.rejects(adapter.syncReceipt({ id: "TASK-1" }), (error) => {
    assert.equal(error.code, "RECLOUD_SYNC_DIAGNOSTICS_NOT_READY");
    assert.equal(error.nodeKey, "receipt");
    assert.deepEqual(error.missingFields, ["successCriteriaFieldNames"]);
    return true;
  });
  assert.equal(executions, 0);
});

test("real adapter calls the matching command only after diagnostics are ready", async () => {
  const calls = [];
  const adapter = new RealRecloudAdapter({
    readinessProvider: {
      async inspect(nodeKey) { return { nodeKey, status: "READY", missingFields: [] }; },
    },
    commandExecutor: {
      async syncRepairCompleted(task) {
        calls.push(task);
        return { ok: true, remoteReference: "MOCK-REMOTE-1" };
      },
    },
  });
  const task = { id: "TASK-READY-1" };
  assert.deepEqual(await adapter.syncRepairCompleted(task), {
    ok: true,
    remoteReference: "MOCK-REMOTE-1",
  });
  assert.deepEqual(calls, [task]);
});

test("real adapter still blocks a ready node when its command executor is absent", async () => {
  const adapter = new RealRecloudAdapter({
    readinessProvider: {
      async inspect(nodeKey) { return { nodeKey, status: "READY", missingFields: [] }; },
    },
  });
  await assert.rejects(adapter.syncOrderCompleted({}), {
    code: "RECLOUD_SYNC_COMMAND_NOT_IMPLEMENTED",
    nodeKey: "completion",
  });
  assert.deepEqual(classifyError({ code: "RECLOUD_SYNC_DIAGNOSTICS_NOT_READY" }), {
    category: "DIAGNOSTICS",
    retryable: false,
    safeCode: "RECLOUD_SYNC_DIAGNOSTICS_NOT_READY",
  });
  assert.deepEqual(classifyError({ code: "RECLOUD_SYNC_COMMAND_NOT_IMPLEMENTED" }), {
    category: "DISABLED",
    retryable: false,
    safeCode: "RECLOUD_SYNC_COMMAND_NOT_IMPLEMENTED",
  });
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
  assert.equal(failed.errorCategory, "UNKNOWN");
  const pending = await service.retry(task.id);
  assert.equal(pending.status, TASK_STATUS.PENDING);
  assert.ok(scheduled.length >= 2);

  const permanentService = new RecloudSyncService(outbox, new RealRecloudAdapter(), { scheduler: () => {} });
  const permanentTask = await permanentService.enqueueOrderNode(ORDER, "ORDER_COMPLETED", "PERMANENT-1");
  const manual = await permanentService.processTask(permanentTask.id);
  assert.equal(manual.status, TASK_STATUS.MANUAL_REVIEW);
  assert.equal(manual.lastError, "RECLOUD_SYNC_DIAGNOSTICS_NOT_READY");
  assert.equal(manual.errorCategory, "DIAGNOSTICS");
});

test("field mapping validates each node and state machine rejects invalid transitions", async (t) => {
  for (const node of ["RECEIPT", "INSPECTION_COMPLETED", "REPAIR_COMPLETED", "RETURN_SHIPPED", "ORDER_COMPLETED"]) {
    assert.doesNotThrow(() => validateNodePayload(node, buildNodePayload(ORDER, node)));
  }
  assert.throws(() => validateNodePayload("RETURN_SHIPPED", { logisticsCompany: "模拟物流" }), {
    code: "RECLOUD_SYNC_VALIDATION_FAILED",
  });
  const outbox = await outboxFixture(t);
  const service = new RecloudSyncService(outbox, new DryRunRecloudAdapter(), { scheduler: () => {} });
  const task = await service.enqueueOrderNode(ORDER, "RECEIPT", "STATE-1");
  await assert.rejects(outbox.transition(task.id, TASK_STATUS.SUCCESS), {
    code: "SYNC_TASK_TRANSITION_INVALID",
  });
});

test("repair mapping confirms observed Recloud columns and blocks ambiguous fee writes", () => {
  assert.equal(RECLOUD_RECEIPT_FIELD_TARGETS.attachments.target, "寄修单附件");
  assert.equal(RECLOUD_REPAIR_FIELD_TARGETS.usedParts.target, "服务单更换件明细");
  assert.equal(RECLOUD_REPAIR_FIELD_TARGETS.responsibilityType.target, "保内保外");
  assert.equal(RECLOUD_REPAIR_FIELD_TARGETS.highestRepairLevel.target, "维修等级");
  assert.equal(RECLOUD_REPAIR_FIELD_TARGETS.partsRetailAmount.status, "SYSTEM_CALCULATED");
  assert.equal(RECLOUD_REPAIR_FIELD_TARGETS.repairFeeReceivable.status, "SYSTEM_CALCULATED");
  assert.equal(RECLOUD_REPAIR_FIELD_TARGETS.customerPaidAmount.status, "CONFIRMED");
  assert.deepEqual(RECLOUD_REPAIR_FIELD_TARGETS.attachments, { target: "附件", status: "CONFIRMED" });
  assert.deepEqual(RECLOUD_REPAIR_FIELD_TARGETS.detectionReportAttachments, { target: "附件（检测报告）", status: "EXCLUDED" });
  assert.deepEqual(RECLOUD_REPAIR_FIELD_TARGETS.warrantyConversion, { target: "保外转保内", status: "CONFIRMED" });
  assert.equal(RECLOUD_REPAIR_FIELD_TARGETS.logisticsAmount.target, "快递金额");
  assert.equal(RECLOUD_REPAIR_FIELD_TARGETS.logisticsAmount.status, "CONFIRMED");
  assert.equal(RECLOUD_REPAIR_FIELD_TARGETS.personalizedLogisticsAmount.status, "EXCLUDED");
});

test("repair form plan only pre-fills confirmed customer-facing fields", () => {
  const payload = buildNodePayload({
    ...ORDER,
    repairCompletion: {
      ...ORDER.repairCompletion,
      responsibilityType: "保外维修",
      pricing: {
        status: "OUT_OF_WARRANTY",
        highestLevel: "小修",
        partsFee: 255,
        fee: 70,
        oneWayLogisticsFee: 61,
        logisticsFee: 122,
        totalFee: 447,
      },
    },
  }, "REPAIR_COMPLETED");
  const plan = buildRecloudRepairFormPlan(payload);
  const writes = Object.fromEntries(plan.safeWrites.map((item) => [item.key, item.value]));

  assert.equal(writes.responsibilityType, "保外");
  assert.equal(writes.highestRepairLevel, "小修");
  assert.equal("repairFeeReceivable" in writes, false);
  assert.equal("partsRetailAmount" in writes, false);
  assert.equal(writes.customerPaidAmount, 447);
  assert.equal(writes.logisticsAmount, 122);
  assert.equal(writes.attachments.length, 1);
  assert.equal(writes.warrantyConversion, "否");
  assert.equal("laborAmount" in writes, false);
  assert.equal(plan.canAutoConfirm, false);
  assert.deepEqual(plan.manualReviewFields, []);
});

test("in-warranty repair does not write customer or logistics charges", () => {
  const payload = buildNodePayload(ORDER, "REPAIR_COMPLETED");
  const writes = Object.fromEntries(buildRecloudRepairFormPlan(payload).safeWrites.map((item) => [item.key, item.value]));
  assert.equal("customerPaidAmount" in writes, false);
  assert.equal("logisticsAmount" in writes, false);
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
