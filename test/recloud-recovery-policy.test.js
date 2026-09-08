const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  recloudBusinessWriteConcurrency,
  shouldAutoResumeReceipt,
  shouldAutoResumeDetection,
  shouldAutoResumeServiceOrder,
  recloudRecoverySweepIntervalMs,
  recloudRecoverySweepBatchSize,
} = require("../server");

const NOW = Date.parse("2026-09-08T06:00:00.000Z");

test("瑞云业务写入默认五路并保持五路安全上限", () => {
  assert.equal(recloudBusinessWriteConcurrency({}), 5);
  assert.equal(recloudBusinessWriteConcurrency({ RECLOUD_BUSINESS_WRITE_CONCURRENCY: "1" }), 1);
  assert.equal(recloudBusinessWriteConcurrency({ RECLOUD_BUSINESS_WRITE_CONCURRENCY: "5" }), 5);
});

test("恢复巡检默认每分钟限量五单并限制配置边界", () => {
  assert.equal(recloudRecoverySweepIntervalMs({}), 60_000);
  assert.equal(recloudRecoverySweepIntervalMs({ RECLOUD_RECOVERY_SWEEP_INTERVAL_MS: "30000" }), 30_000);
  assert.equal(recloudRecoverySweepIntervalMs({ RECLOUD_RECOVERY_SWEEP_INTERVAL_MS: "1000" }), 60_000);
  assert.equal(recloudRecoverySweepBatchSize({}), 5);
  assert.equal(recloudRecoverySweepBatchSize({ RECLOUD_RECOVERY_SWEEP_BATCH_SIZE: "12" }), 12);
  assert.equal(recloudRecoverySweepBatchSize({ RECLOUD_RECOVERY_SWEEP_BATCH_SIZE: "100" }), 20);
});

test("恢复巡检在截断批次前应用瑞云写入白名单", () => {
  const source = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
  const block = source.slice(
    source.indexOf("const candidates = orders.map"),
    source.indexOf("let scheduled = 0", source.indexOf("const candidates = orders.map"))
  );
  assert.ok(block.indexOf("isRecloudRmaWriteAllowed") < block.indexOf(".slice(0, batchSize)"));
});

test("签收自动恢复只处理近期且仍处于维修前流程的工单", () => {
  const base = {
    status: "RECEIVED_PENDING_INSPECTION",
    receiptCompletedAt: "2026-09-08T05:00:00.000Z",
    receiptAttachments: [{ id: "A1" }],
    recloudReceiptConfirmedAt: "2026-09-08T05:01:00.000Z",
    recloudProjectVerificationConfirmedAt: "",
    recloudReceiptAttachmentConfirmedAt: "",
    recloudReceiptSyncStatus: "CONFIRMED",
  };
  assert.equal(shouldAutoResumeReceipt(base, NOW), true);
  assert.equal(shouldAutoResumeReceipt({ ...base, status: "REPAIR_COMPLETED_PENDING_SHIPMENT" }, NOW), false);
  assert.equal(shouldAutoResumeReceipt({ ...base, receiptCompletedAt: "2026-08-05T05:00:00.000Z" }, NOW), true);
  assert.equal(shouldAutoResumeReceipt({ ...base, recloudReceiptSyncStatus: "RESULT_UNKNOWN" }, NOW), false);
  assert.equal(shouldAutoResumeReceipt({
    ...base,
    recloudProjectVerificationLastError: { at: "2026-09-08T05:59:00.000Z" },
  }, NOW), false);
});

test("检测自动恢复避开终态旧单、永久数据错误和轮询重试风暴", () => {
  const failed = {
    status: "INSPECTION_COMPLETED_PENDING_REPAIR",
    inspectionUpdatedAt: "2026-09-08T05:00:00.000Z",
    recloudDetectionSyncStatus: "FAILED",
    recloudDetectionLastError: {
      code: "RECLOUD_NETWORK_ERROR",
      at: "2026-09-08T05:50:00.000Z",
    },
  };
  assert.equal(shouldAutoResumeDetection(failed, NOW), true);
  assert.equal(shouldAutoResumeDetection({
    ...failed,
    recloudDetectionLastError: { ...failed.recloudDetectionLastError, at: "2026-09-08T05:59:00.000Z" },
  }, NOW), false);
  assert.equal(shouldAutoResumeDetection({
    ...failed,
    recloudDetectionLastError: { code: "RECLOUD_DETECTION_PAYLOAD_INVALID", at: "2026-09-08T05:00:00.000Z" },
  }, NOW), false);
  assert.equal(shouldAutoResumeDetection({
    ...failed,
    recloudDetectionLastError: { code: "RECLOUD_ACTION_NOT_FOUND", at: "2026-09-08T05:00:00.000Z" },
  }, NOW), false);
  assert.equal(shouldAutoResumeDetection({ ...failed, status: "REPAIR_COMPLETED_PENDING_SHIPMENT" }, NOW), false);
  assert.equal(shouldAutoResumeDetection({
    ...failed,
    inspectionUpdatedAt: "2026-08-05T05:00:00.000Z",
  }, NOW), true);
});

test("维修建单与首次准备失败会被巡检恢复但未知结果不会重复写", () => {
  const base = {
    status: "INSPECTION_COMPLETED_PENDING_REPAIR",
    recloudDetectionConfirmedAt: "2026-09-08T05:00:00.000Z",
    recloudServiceOrderSyncStatus: "FAILED",
    recloudServiceOrderAttemptedAt: "2026-09-08T05:00:00.000Z",
    recloudServiceOrderLastError: { code: "RECLOUD_NETWORK_ERROR", at: "2026-09-08T05:00:00.000Z" },
    recloudRepairPreparation: { status: "PENDING" },
  };
  assert.equal(shouldAutoResumeServiceOrder(base, NOW), true);
  assert.equal(shouldAutoResumeServiceOrder({
    ...base,
    recloudServiceOrderLastError: { code: "RECLOUD_NETWORK_ERROR", at: "2026-09-08T05:59:00.000Z" },
  }, NOW), false);
  assert.equal(shouldAutoResumeServiceOrder({ ...base, recloudServiceOrderSyncStatus: "RESULT_UNKNOWN" }, NOW), false);
  assert.equal(shouldAutoResumeServiceOrder({
    ...base,
    recloudServiceOrderCreatedAt: "2026-09-08T05:10:00.000Z",
    recloudServiceOrderNo: "WX001",
    recloudRepairPreparation: {
      status: "FAILED",
      failedAt: "2026-09-08T05:00:00.000Z",
    },
  }, NOW), true);
});
