const DEFAULT_INTERVAL_MS = 60 * 1000;
const MINIMUM_INTERVAL_MS = 30 * 1000;

function rmaQueryIndexSyncEnabled(env = process.env) {
  return String(env.RMA_QUERY_INDEX_SYNC_ENABLED ?? "true").toLowerCase() !== "false";
}

function rmaQueryIndexSyncInterval(env = process.env) {
  const requested = Number(env.RMA_QUERY_INDEX_SYNC_INTERVAL_MS || DEFAULT_INTERVAL_MS);
  return Number.isFinite(requested)
    ? Math.max(MINIMUM_INTERVAL_MS, requested)
    : DEFAULT_INTERVAL_MS;
}

class RmaQueryIndexSync {
  constructor({ store, readOrders, intervalMs = DEFAULT_INTERVAL_MS, logger = console,
    setTimer = setTimeout, clearTimer = clearTimeout, now = () => new Date() }) {
    this.store = store;
    this.readOrders = readOrders;
    this.intervalMs = intervalMs;
    this.logger = logger;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.now = now;
    this.timer = null;
    this.stopped = true;
    this.running = false;
    this.primed = false;
  }

  async syncNow({ force = false } = {}) {
    if (this.running) return { skipped: true, reason: "ALREADY_RUNNING" };
    this.running = true;
    try {
      const snapshot = await this.store.readSnapshot();
      const catchUp = force || !this.primed;
      const result = await this.readOrders({
        catchUp,
        since: catchUp ? "" : snapshot.syncedAt || "",
      });
      if (result?.yielded) {
        return { skipped: true, reason: "FOREGROUND_QUERY_PRIORITY", catchUp, yielded: true };
      }
      const current = this.now();
      const orders = Array.isArray(result) ? result : result?.orders || [];
      const merged = await this.store.mergeIncremental(orders, {
        activeRmaNos: null,
        syncedAt: current.toISOString(),
      });
      this.primed = true;
      this.logger.info?.(
        `RMA_QUERY_INDEX_SYNC: catchUp=${catchUp} discovered=${result?.discovered ?? orders.length} added=${merged.added} updated=${merged.updated} total=${merged.total}`
      );
      return { skipped: false, catchUp, ...merged };
    } catch (error) {
      this.logger.error?.(`RMA_QUERY_INDEX_SYNC: failed ${error.code || "UNKNOWN"}`);
      return { skipped: false, errorCode: error.code || "UNKNOWN" };
    } finally {
      this.running = false;
    }
  }

  scheduleNext() {
    if (this.stopped) return;
    this.timer = this.setTimer(async () => {
      await this.syncNow();
      this.scheduleNext();
    }, this.intervalMs);
    this.timer?.unref?.();
  }

  start(immediate = true) {
    if (!this.stopped) return;
    this.stopped = false;
    if (immediate) this.syncNow().finally(() => this.scheduleNext());
    else this.scheduleNext();
  }

  stop() {
    this.stopped = true;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
  }
}

module.exports = {
  DEFAULT_INTERVAL_MS,
  MINIMUM_INTERVAL_MS,
  RmaQueryIndexSync,
  rmaQueryIndexSyncEnabled,
  rmaQueryIndexSyncInterval,
};
