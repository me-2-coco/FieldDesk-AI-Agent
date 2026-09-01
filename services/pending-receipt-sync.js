const FIVE_MINUTES = 5 * 60 * 1000;
const DEFAULT_TIME_ZONE = 'Asia/Shanghai';

function pendingReceiptSyncEnabled(env = process.env) {
  return String(env.PENDING_RECEIPT_SYNC_ENABLED ?? 'true').toLowerCase() !== 'false';
}

function pendingReceiptSyncInterval(env = process.env) {
  const requested = Number(env.PENDING_RECEIPT_SYNC_INTERVAL_MS || FIVE_MINUTES);
  return Number.isFinite(requested) ? Math.max(FIVE_MINUTES, requested) : FIVE_MINUTES;
}

function shanghaiParts(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: DEFAULT_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  return Object.fromEntries(parts.map(({ type, value }) => [type, Number(value)]));
}

function isActiveSyncTime(date = new Date()) {
  const { hour } = shanghaiParts(date);
  return hour >= 7 && hour < 23;
}

function shanghaiDateKey(date = new Date()) {
  const { year, month, day } = shanghaiParts(date);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function millisecondsUntilNextWindow(date = new Date(), intervalMs = FIVE_MINUTES) {
  if (isActiveSyncTime(date)) {
    const elapsed = date.getTime() % intervalMs;
    return elapsed === 0 ? intervalMs : intervalMs - elapsed;
  }
  const parts = shanghaiParts(date);
  const todaySevenUtc = Date.UTC(parts.year, parts.month - 1, parts.day, 7) - 8 * 60 * 60 * 1000;
  const next = parts.hour >= 23 ? todaySevenUtc + 24 * 60 * 60 * 1000 : todaySevenUtc;
  return Math.max(1000, next - date.getTime());
}

class PendingReceiptSync {
  constructor({ store, readOrders, intervalMs = FIVE_MINUTES, logger = console,
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
  }

  async syncNow({ force = false } = {}) {
    const current = this.now();
    if (!force && !isActiveSyncTime(current)) return { skipped: true, reason: 'OUTSIDE_SYNC_WINDOW' };
    if (this.running) return { skipped: true, reason: 'ALREADY_RUNNING' };
    this.running = true;
    try {
      const snapshot = await this.store.readSnapshot();
      const lastDate = snapshot.syncedAt ? shanghaiDateKey(new Date(snapshot.syncedAt)) : '';
      const catchUp = !lastDate || lastDate !== shanghaiDateKey(current);
      const result = await this.readOrders({
        existingRmaNos: snapshot.orders
          .filter((order) => /^1[3-9]\d{9}$/.test(String(order.phone || '').trim()))
          .map((order) => order.rmaNo).filter(Boolean),
        since: snapshot.syncedAt || '', catchUp,
      });
      const orders = Array.isArray(result) ? result : result.orders || [];
      const activeRmaNos = Array.isArray(result?.activeRmaNos) ? result.activeRmaNos : null;
      const merged = await this.store.mergeIncremental(orders, {
        activeRmaNos: catchUp ? activeRmaNos : null,
        syncedAt: current.toISOString(),
      });
      this.logger.info?.(`PENDING_RECEIPT_SYNC: added ${merged.added}, updated ${merged.updated}, total ${merged.total}`);
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
    if (immediate && isActiveSyncTime(this.now())) this.syncNow().finally(() => this.scheduleNext());
    else this.scheduleNext();
  }

  stop() {
    this.stopped = true;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
  }
}

module.exports = {
  FIVE_MINUTES, PendingReceiptSync, isActiveSyncTime, millisecondsUntilNextWindow,
  pendingReceiptSyncEnabled, pendingReceiptSyncInterval, shanghaiDateKey,
};
