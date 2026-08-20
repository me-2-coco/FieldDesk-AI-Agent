const test = require("node:test");
const assert = require("node:assert/strict");
const {
  RecloudSupervisionMonitor,
  monitorEnabled,
  monitorInterval,
  sanitizeSupervisionContent,
} = require("../services/recloud-supervision-monitor");

test("监测器保存瑞云全部寄修督办并标记未匹配本地工单", async () => {
  const saved = [];
  const global = [];
  const localOrder = { rmaNo: "JXTH-SYNTHETIC-001", supervisionOrders: [] };
  const receiptStore = {
    readAll: async () => [localOrder],
    saveSupervisionOrder: async (rmaNo, input) => {
      saved.push({ rmaNo, input });
      localOrder.supervisionOrders.push({ sourceId: input.sourceId });
    },
  };
  const readPendingOrders = async () => [
    { sourceId: "DB-SYNTHETIC-001", rmaNo: "JXTH-SYNTHETIC-001", subtype: "政策问题", content: "核对整机保修范围" },
    { sourceId: "DB-SYNTHETIC-002", rmaNo: "JXTH-NOT-LOCAL", content: "不应同步" },
  ];
  const supervisionInboxStore = {
    readAll: async () => global,
    save: async (input) => { if (!global.some((item) => item.sourceId === input.sourceId)) global.push(input); },
  };
  const monitor = new RecloudSupervisionMonitor({ receiptStore, supervisionInboxStore, readPendingOrders, logger: {}, intervalMs: 10000 });

  assert.deepEqual(await monitor.pollNow(), { skipped: false, captured: 2 });
  assert.deepEqual(await monitor.pollNow(), { skipped: false, captured: 0 });
  assert.equal(saved.length, 1);
  assert.equal(global.length, 2);
  assert.equal(global.find((item) => item.rmaNo === "JXTH-NOT-LOCAL").matchedLocalOrder, false);
  assert.equal(monitor.getStatus().lastLiveCount, 2);
  assert.equal(monitor.getStatus().lastUnmatchedCount, 1);
  assert.equal(saved[0].rmaNo, "JXTH-SYNTHETIC-001");
  assert.equal(saved[0].input.analysis.replyOwner, "INFORMATION_CLERK");
  assert.equal(saved[0].input.analysis.systemCanReply, false);
});

test("监测间隔默认30秒且最低10秒，可显式关闭", () => {
  assert.equal(monitorInterval({}), 30000);
  assert.equal(monitorInterval({ SUPERVISION_MONITOR_INTERVAL_MS: "1000" }), 10000);
  assert.equal(monitorEnabled({}), true);
  assert.equal(monitorEnabled({ SUPERVISION_MONITOR_ENABLED: "false" }), false);
});

test("督办通知中的手机号在进入本地收件箱前脱敏", () => {
  assert.equal(sanitizeSupervisionContent("联系15185897646杨女士"), "联系151****7646杨女士");
});

test("瑞云明确完成的督办单只归档且不再通知师傅", async () => {
  const archived = [];
  const receiptStore = {
    readAll: async () => [{
      rmaNo: "JXTH-SYNTHETIC-DONE",
      supervisionOrders: [{ sourceId: "DB-SYNTHETIC-DONE", recloudStatus: "处理中" }],
    }],
    archiveSupervisionOrder: async (rmaNo, sourceId) => archived.push({ rmaNo, sourceId }),
    saveSupervisionOrder: async () => assert.fail("已完成督办单不应再次保存为通知"),
  };
  const monitor = new RecloudSupervisionMonitor({
    receiptStore,
    readOrders: async () => [{
      sourceId: "DB-SYNTHETIC-DONE",
      rmaNo: "JXTH-SYNTHETIC-DONE",
      status: "已完成",
    }],
    logger: {},
  });

  assert.deepEqual(await monitor.pollNow(), { skipped: false, captured: 0 });
  assert.deepEqual(archived, [{ rmaNo: "JXTH-SYNTHETIC-DONE", sourceId: "DB-SYNTHETIC-DONE" }]);
});

test("监测器公开安全运行状态并记录成功与失败", async () => {
  let shouldFail = false;
  const monitor = new RecloudSupervisionMonitor({
    receiptStore: { readAll: async () => [] },
    readOrders: async () => {
      if (shouldFail) throw Object.assign(new Error("synthetic"), { code: "RECLOUD_LOGIN_REQUIRED" });
      return [];
    },
    logger: {},
    intervalMs: 10000,
  });
  monitor.start();
  await new Promise((resolve) => setImmediate(resolve));
  let status = monitor.getStatus();
  assert.equal(status.enabled, true);
  assert.equal(status.intervalMs, 10000);
  assert.ok(status.lastSuccessAt);
  assert.equal(status.lastErrorCode, null);

  shouldFail = true;
  await monitor.pollNow();
  status = monitor.getStatus();
  assert.equal(status.lastErrorCode, "RECLOUD_LOGIN_REQUIRED");
  assert.ok(status.lastErrorAt);
  assert.equal(status.pollCount, 2);
  monitor.stop();
});
