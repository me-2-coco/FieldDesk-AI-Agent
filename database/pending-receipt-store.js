const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const DEFAULT_CAPACITY = 10000;

class PendingReceiptStore {
  constructor(filePath = path.join(__dirname, 'data', 'pending-receipts.json'), options = {}) {
    this.filePath = filePath;
    this.capacity = Number(options.capacity || process.env.PENDING_RECEIPT_CACHE_CAPACITY || DEFAULT_CAPACITY);
    this.mutationQueue = Promise.resolve();
  }

  enqueueMutation(operation) {
    const current = this.mutationQueue.catch(() => {}).then(operation);
    this.mutationQueue = current;
    return current;
  }

  async readAll() {
    return (await this.readSnapshot()).orders;
  }

  async readSnapshot() {
    try {
      const payload = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
      return {
        syncedAt: String(payload.syncedAt || ''),
        orders: Array.isArray(payload.orders) ? payload.orders : [],
      };
    } catch (error) {
      if (error.code === 'ENOENT') return { syncedAt: '', orders: [] };
      throw error;
    }
  }

  async writeSnapshot(orders, syncedAt = new Date().toISOString()) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify({
      syncedAt,
      orders,
    }), { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporary, this.filePath);
    await fs.chmod(this.filePath, 0o600);
  }

  async replaceAll(orders) {
    return this.enqueueMutation(async () => {
      const capped = orders.slice(-this.capacity);
      await this.writeSnapshot(capped);
      return capped.length;
    });
  }

  async mergeIncremental(incoming, options = {}) {
    return this.enqueueMutation(async () => {
      const snapshot = await this.readSnapshot();
      const active = options.activeRmaNos ? new Set(options.activeRmaNos) : null;
      const retained = active ? snapshot.orders.filter((order) => active.has(order.rmaNo)) : snapshot.orders.slice();
      const byRma = new Map(retained.map((order) => [order.rmaNo, order]));
      let added = 0;
      let updated = 0;
      for (const raw of incoming) {
        if (!raw?.rmaNo) continue;
        const previous = byRma.get(raw.rmaNo);
        const merged = {
          ...(previous || {}), ...raw,
          cachedAt: previous?.cachedAt || raw.cachedAt || options.syncedAt || new Date().toISOString(),
          updatedAt: options.syncedAt || new Date().toISOString(),
        };
        if (previous) {
          for (const key of [
            'logisticsNo', 'phone', 'customerName', 'regionAddress', 'reportedFault',
            'sn', 'productLine', 'productModel', 'pickupStatus', 'sourceCreatedAt',
            'phoneVerified',
          ]) {
            if (!String(raw[key] || '').trim() && String(previous[key] || '').trim()) {
              merged[key] = previous[key];
            }
          }
        }
        byRma.set(raw.rmaNo, merged);
        if (previous) updated += 1;
        else added += 1;
      }
      const orders = [...byRma.values()]
        .sort((a, b) => Date.parse(a.cachedAt || 0) - Date.parse(b.cachedAt || 0))
        .slice(-this.capacity);
      await this.writeSnapshot(orders, options.syncedAt);
      return { added, updated, removed: Math.max(0, snapshot.orders.length + added - orders.length), total: orders.length };
    });
  }

  async upsert(order) {
    return this.mergeIncremental([order]);
  }
}

module.exports = { DEFAULT_CAPACITY, PendingReceiptStore };
