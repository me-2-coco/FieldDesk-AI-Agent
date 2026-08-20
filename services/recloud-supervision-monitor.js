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

function sanitizeSupervisionContent(value) {
  return String(value || "").replace(/(?<!\d)(1\d{2})\d{4}(\d{4})(?!\d)/g, "$1****$2");
}

class RecloudSupervisionMonitor {
  constructor({ receiptStore, supervisionInboxStore, readOrders, readPendingOrders, logger = console, intervalMs = 30000, setTimer = setTimeout, clearTimer = clearTimeout }) {
    this.receiptStore = receiptStore;
    this.supervisionInboxStore = supervisionInboxStore;
    this.readOrders = readOrders || readPendingOrders;
    this.logger = logger;
    this.intervalMs = Math.max(10000, Number(intervalMs) || 30000);
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.timer = null;
    this.running = false;
    this.stopped = true;
    this.startedAt = null;
    this.lastPollStartedAt = null;
    this.lastSuccessAt = null;
    this.lastErrorAt = null;
    this.lastErrorCode = null;
    this.lastCapturedCount = 0;
    this.totalCaptured = 0;
    this.pollCount = 0;
    this.lastLiveCount = 0;
    this.lastMatchedCount = 0;
    this.lastUnmatchedCount = 0;
    this.lastPendingCount = 0;
  }

  getStatus() {
    return {
      enabled: !this.stopped,
      running: this.running,
      intervalMs: this.intervalMs,
      startedAt: this.startedAt,
      lastPollStartedAt: this.lastPollStartedAt,
      lastSuccessAt: this.lastSuccessAt,
      lastErrorAt: this.lastErrorAt,
      lastErrorCode: this.lastErrorCode,
      lastCapturedCount: this.lastCapturedCount,
      totalCaptured: this.totalCaptured,
      pollCount: this.pollCount,
      lastLiveCount: this.lastLiveCount,
      lastMatchedCount: this.lastMatchedCount,
      lastUnmatchedCount: this.lastUnmatchedCount,
      lastPendingCount: this.lastPendingCount,
    };
  }

  async pollNow() {
    if (this.running) return { skipped: true, captured: 0 };
    this.running = true;
    this.lastPollStartedAt = new Date().toISOString();
    this.pollCount += 1;
    try {
      const [localOrders, liveOrders] = await Promise.all([
        this.receiptStore.readAll(),
        this.readOrders(),
      ]);
      const localByRma = new Map(localOrders.map((order) => [order.rmaNo, order]));
      let captured = 0;
      let matched = 0;
      let unmatched = 0;
      let pending = 0;
      for (const liveOrder of liveOrders) {
        const localOrder = localByRma.get(liveOrder.rmaNo);
        if (localOrder) matched += 1;
        else unmatched += 1;
        if (/已完成/.test(liveOrder.status || "")) {
          await this.supervisionInboxStore?.archive?.(liveOrder.sourceId);
          if (localOrder) await this.receiptStore.archiveSupervisionOrder?.(liveOrder.rmaNo, liveOrder.sourceId, SYSTEM_OPERATOR);
          continue;
        }
        const isPending = !liveOrder.status || /未处理|待处理/.test(liveOrder.status);
        if (isPending) pending += 1;
        const content = sanitizeSupervisionContent(liveOrder.content || liveOrder.processingRecord || `${liveOrder.type || ""} ${liveOrder.subtype || ""}`.trim() || "瑞云督办单待信息员确认");
        const analysis = analyzeSupervisionOrder(content, {
          type: liveOrder.type,
          subtype: liveOrder.subtype,
        });
        const globalRecords = await this.supervisionInboxStore?.readAll?.() || [];
        const globallyCaptured = globalRecords.some((item) => item.sourceId === liveOrder.sourceId);
        if (!isPending && !globallyCaptured) continue;
        await this.supervisionInboxStore?.save?.({
          sourceId: liveOrder.sourceId,
          rmaNo: liveOrder.rmaNo,
          type: liveOrder.type,
          subtype: liveOrder.subtype,
          originalContent: analysis.originalContent,
          analysis,
          recloudStatus: liveOrder.status || "未处理",
          matchedLocalOrder: Boolean(localOrder),
        });
        if (!globallyCaptured) captured += 1;
        if (!localOrder) continue;
        const alreadyCaptured = (localOrder.supervisionOrders || []).some((item) => (
          liveOrder.sourceId && item.sourceId === liveOrder.sourceId
        ));
        if (alreadyCaptured) {
          const current = (localOrder.supervisionOrders || []).find((item) => item.sourceId === liveOrder.sourceId);
          if (current?.recloudStatus !== liveOrder.status) {
            await this.receiptStore.saveSupervisionOrder(liveOrder.rmaNo, {
              sourceId: liveOrder.sourceId,
              originalContent: current.originalContent,
              analysis: current.analysis,
              recloudStatus: liveOrder.status,
            }, SYSTEM_OPERATOR);
          }
          continue;
        }
        await this.receiptStore.saveSupervisionOrder(liveOrder.rmaNo, {
          sourceId: liveOrder.sourceId,
          originalContent: analysis.originalContent,
          analysis: { ...analysis, source: liveOrder },
          recloudStatus: liveOrder.status || "未处理",
        }, SYSTEM_OPERATOR);
      }
      if (captured) this.logger.info?.(`RECLOUD_SUPERVISION_MONITOR: captured ${captured}`);
      this.lastSuccessAt = new Date().toISOString();
      this.lastErrorCode = null;
      this.lastCapturedCount = captured;
      this.totalCaptured += captured;
      this.lastLiveCount = liveOrders.length;
      this.lastMatchedCount = matched;
      this.lastUnmatchedCount = unmatched;
      this.lastPendingCount = pending;
      return { skipped: false, captured };
    } catch (error) {
      this.lastErrorAt = new Date().toISOString();
      this.lastErrorCode = error.code || "UNKNOWN";
      this.lastCapturedCount = 0;
      this.logger.error?.(`RECLOUD_SUPERVISION_MONITOR: failed ${error.code || "UNKNOWN"}`);
      return { skipped: false, captured: 0, errorCode: error.code || "UNKNOWN" };
    } finally {
      this.running = false;
    }
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.startedAt ||= new Date().toISOString();
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
  sanitizeSupervisionContent,
};
