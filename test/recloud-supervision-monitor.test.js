const test = require("node:test");
const assert = require("node:assert/strict");
const {
  RecloudSupervisionMonitor,
  monitorEnabled,
  monitorInterval,
} = require("../services/recloud-supervision-monitor");

test("监测器只把关联到本地寄修工单的新督办单通知一次", async () => {
  const saved = [];
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
  const monitor = new RecloudSupervisionMonitor({ receiptStore, readPendingOrders, logger: {}, intervalMs: 10000 });

  assert.deepEqual(await monitor.pollNow(), { skipped: false, captured: 1 });
  assert.deepEqual(await monitor.pollNow(), { skipped: false, captured: 0 });
  assert.equal(saved.length, 1);
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
