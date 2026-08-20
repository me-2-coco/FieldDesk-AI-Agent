const { analyzeSupervisionOrder } = require("./supervision-order-policy");

const SYSTEM_OPERATOR = Object.freeze({
  userId: "system-supervision-monitor",
  displayName: "督办单监测服务",
  role: "SYSTEM",
});

function monitorEnabled(env = process.env) {
  return String(env.SUPERVISION_MONITOR_ENABLED ?? "true").toLowerCase() !== "false";
}

function monitorInterval(env = process.env) {
  const requested = Number(env.SUPERVISION_MONITOR_INTERVAL_MS || 30000);
  return Number.isFinite(requested) ? Math.max(10000, requested) : 30000;
}

class RecloudSupervisionMonitor {
  constructor({ receiptStore, readPendingOrders, logger = console, intervalMs = 30000, setTimer = setTimeout, clearTimer = clearTimeout }) {
    this.receiptStore = receiptStore;
    this.readPendingOrders = readPendingOrders;
    this.logger = logger;
    this.intervalMs = Math.max(10000, Number(intervalMs) || 30000);
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.timer = null;
    this.running = false;
    this.stopped = true;
  }

  async pollNow() {
    if (this.running) return { skipped: true, captured: 0 };
    this.running = true;
    try {
      const [localOrders, liveOrders] = await Promise.all([
        this.receiptStore.readAll(),
        this.readPendingOrders(),
      ]);
      const localByRma = new Map(localOrders.map((order) => [order.rmaNo, order]));
      let captured = 0;
      for (const liveOrder of liveOrders) {
        const localOrder = localByRma.get(liveOrder.rmaNo);
        if (!localOrder) continue;
        const alreadyCaptured = (localOrder.supervisionOrders || []).some((item) => (
          liveOrder.sourceId && item.sourceId === liveOrder.sourceId
        ));
        if (alreadyCaptured) continue;
        const content = liveOrder.content || liveOrder.processingRecord || `${liveOrder.type || ""} ${liveOrder.subtype || ""}`.trim() || "瑞云督办单待信息员确认";
        const analysis = analyzeSupervisionOrder(content, {
          type: liveOrder.type,
          subtype: liveOrder.subtype,
        });
        await this.receiptStore.saveSupervisionOrder(liveOrder.rmaNo, {
          sourceId: liveOrder.sourceId,
          originalContent: analysis.originalContent,
          analysis: { ...analysis, source: liveOrder },
        }, SYSTEM_OPERATOR);
        captured += 1;
      }
      if (captured) this.logger.info?.(`RECLOUD_SUPERVISION_MONITOR: captured ${captured}`);
      return { skipped: false, captured };
    } catch (error) {
      this.logger.error?.(`RECLOUD_SUPERVISION_MONITOR: failed ${error.code || "UNKNOWN"}`);
      return { skipped: false, captured: 0, errorCode: error.code || "UNKNOWN" };
    } finally {
      this.running = false;
    }
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    const tick = async () => {
      await this.pollNow();
      if (this.stopped) return;
      this.timer = this.setTimer(tick, this.intervalMs);
      this.timer?.unref?.();
    };
    tick();
  }

  stop() {
    this.stopped = true;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
  }
}

module.exports = {
  RecloudSupervisionMonitor,
  SYSTEM_OPERATOR,
  monitorEnabled,
  monitorInterval,
};
