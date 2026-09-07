const REALTIME_SYNC_INTERVAL = 30 * 1000;
const MINIMUM_SYNC_INTERVAL = 15 * 1000;
const DEFAULT_TIME_ZONE = 'Asia/Shanghai';

function pendingReceiptSyncEnabled(env = process.env) {
  return String(env.PENDING_RECEIPT_SYNC_ENABLED ?? 'true').toLowerCase() !== 'false';
}

function pendingReceiptSyncInterval(env = process.env) {
  const requested = Number(env.PENDING_RECEIPT_SYNC_INTERVAL_MS || REALTIME_SYNC_INTERVAL);
  return Number.isFinite(requested)
    ? Math.max(MINIMUM_SYNC_INTERVAL, requested)
    : REALTIME_SYNC_INTERVAL;
}

function shanghaiParts(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: DEFAULT_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  return Object.fromEntries(parts.map(({ type, value }) => [type, Number(value)]));
}

function isActiveSyncTime() {
  return true;
}

function shanghaiDateKey(date = new Date()) {
  const { year, month, day } = shanghaiParts(date);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function millisecondsUntilNextWindow(date = new Date(), intervalMs = REALTIME_SYNC_INTERVAL) {
  const elapsed = date.getTime() % intervalMs;
  return elapsed === 0 ? intervalMs : intervalMs - elapsed;
}

class PendingReceiptSync {
  constructor({ store, readOrders, intervalMs = REALTIME_SYNC_INTERVAL, logger = console,
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
    this.initialSync = true;
  }

  async syncNow({ force = false } = {}) {
    const current = this.now();
    if (this.running) return { skipped: true, reason: 'ALREADY_RUNNING' };
    this.running = true;
    try {
      const snapshot = await this.store.readSnapshot();
      const lastDate = snapshot.syncedAt ? shanghaiDateKey(new Date(snapshot.syncedAt)) : '';
      // Every backend start first refreshes the complete pending list. Later
      // runs only scan newly-created rows, keeping near-real-time polling cheap.
      const catchUp = force || this.initialSync || !lastDate || lastDate !== shanghaiDateKey(current);
      const result = await this.readOrders({
        existingRmaNos: snapshot.orders
          .filter((order) => /^1[3-9]\d{9}$/.test(String(order.phone || '').trim()))
          .map((order) => order.rmaNo).filter(Boolean),
        since: snapshot.syncedAt || '', catchUp,
      });
      if (result?.yielded) {
        return { skipped: true, reason: 'FOREGROUND_QUERY_PRIORITY', catchUp, yielded: true };
      }
      const orders = Array.isArray(result) ? result : result.orders || [];
      const activeRmaNos = Array.isArray(result?.activeRmaNos) ? result.activeRmaNos : null;
      const merged = await this.store.mergeIncremental(orders, {
        activeRmaNos: catchUp ? activeRmaNos : null,
        syncedAt: current.toISOString(),
      });
      this.logger.info?.(`PENDING_RECEIPT_SYNC: added ${merged.added}, updated ${merged.updated}, total ${merged.total}`);
      this.initialSync = false;
      return { skipped: false, catchUp, ...merged };
    } catch (error) {
      this.logger.error?.(`PENDING_RECEIPT_SYNC: failed ${error.code || 'UNKNOWN'}`);
      return { skipped: false, errorCode: error.code || 'UNKNOWN' };
    } finally {
      this.running = false;
    }
  }

  scheduleNext() {
    if (this.stopped) return;
    this.timer = this.setTimer(async () => {
      await this.syncNow();
      this.scheduleNext();
    }, millisecondsUntilNextWindow(this.now(), this.intervalMs));
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
  REALTIME_SYNC_INTERVAL, MINIMUM_SYNC_INTERVAL, PendingReceiptSync, isActiveSyncTime, millisecondsUntilNextWindow,
  pendingReceiptSyncEnabled, pendingReceiptSyncInterval, shanghaiDateKey,
};
