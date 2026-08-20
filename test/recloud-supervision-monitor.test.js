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
