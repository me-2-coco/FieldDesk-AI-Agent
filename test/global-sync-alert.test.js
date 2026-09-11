const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");

test("administrator receives safe global alerts for actionable sync states", async () => {
  const app = await fs.readFile(path.join(__dirname, "../frontend/src/App.jsx"), "utf8");
  assert.match(app, /getRecloudSyncTasks/);
  assert.match(app, /FAILED", "MANUAL_REVIEW", "READY_DRY_RUN", "AWAITING_FINAL_CONFIRM/);
  assert.match(app, /hasBusinessRole\(currentUser, USER_ROLES\.ADMIN\)/);
  assert.match(app, /window\.setTimeout\(refreshSyncAttention, 10000\)/);
  assert.match(app, /setPage\("syncTasks"\)/);
  assert.doesNotMatch(app, /syncAttentionTasks\[0\]\?\.(?:payload|lastError|sn|logisticsNo)/);
});

test("completed local orders still expose unresolved remote failures", async t => {
  const { createApp } = require("../server");
  const order = { rmaNo: "SYNTHETIC-ALERT", status: "REPAIR_COMPLETED_PENDING_SHIPMENT",
    recloudDetectionSyncStatus: "SYNCING", recloudDetectionSubmissionStartedAt: "2000-01-01" };
  const app = createApp({}, { readAll: async () => [order], listOrdersForUser: async () => [order] }, {
    env: { FIELDDESK_AUTH_MODE: "accounts", FIELDDESK_STORAGE_DRIVER: "memory", DRY_RUN: "true" },
    accountStore: { ensureBootstrap: async () => {}, findSession: async () => ({ userId: "test" }),
      findByUserId: async () => ({ userId: "test", role: "ADMIN" }) },
    coordinationStore: { assertAvailable: async () => {} },
    operationalLogger: { write: () => {} },
    syncService: { outbox: { readAll: async () => [{ id: "synthetic-task", rmaNo: order.rmaNo,
      nodeType: "REPAIR_COMPLETED", status: "MANUAL_REVIEW", reconciliationRequired: true,
      lastError: "RECLOUD_SYNC_RESULT_UNKNOWN" }] } },
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/repairs/my-sync-alerts`, {
    headers: { Authorization: "Bearer synthetic" },
  });
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.equal(data.find(item => item.stage === "DETECTION").status, "RESULT_UNKNOWN");
  assert.equal(data.find(item => item.stage === "REPAIR_COMPLETED").errorCode, "RECLOUD_SYNC_RESULT_UNKNOWN");
  assert.ok(data.every(item => !item.message.includes("正在自动重试")));
});
