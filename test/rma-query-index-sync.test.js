const test = require('node:test');
const assert = require('node:assert/strict');
const {
  RmaQueryIndexSync,
  rmaQueryIndexSyncEnabled,
  rmaQueryIndexSyncInterval,
} = require('../services/rma-query-index-sync');

test('RMA query index synchronization is enabled by default and bounded', () => {
  assert.equal(rmaQueryIndexSyncEnabled({}), true);
  assert.equal(rmaQueryIndexSyncEnabled({ RMA_QUERY_INDEX_SYNC_ENABLED: 'false' }), false);
  assert.equal(rmaQueryIndexSyncInterval({}), 60000);
  assert.equal(rmaQueryIndexSyncInterval({ RMA_QUERY_INDEX_SYNC_INTERVAL_MS: '1000' }), 30000);
});

test('RMA query index reconciles existing orders instead of filtering by creation time', async () => {
  const contexts = [];
  const merges = [];
  const store = {
    async readSnapshot() {
      return { syncedAt: '2026-09-08T10:00:00.000Z', orders: [{ rmaNo: 'OLD' }] };
    },
    async mergeIncremental(orders, options) {
      merges.push({ orders, options });
      return { added: orders.length, updated: 0, removed: 0, total: orders.length + 1 };
    },
  };
  const sync = new RmaQueryIndexSync({
    store,
    now: () => new Date('2026-09-08T10:01:00.000Z'),
    readOrders: async (context) => {
      contexts.push(context);
      return { orders: [{ rmaNo: `NEW-${contexts.length}` }], discovered: 1 };
    },
    logger: { info() {}, error() {} },
  });

  assert.equal((await sync.syncNow()).catchUp, true);
  assert.equal(contexts[0].since, '');
  assert.equal(typeof contexts[0].onBatch, 'function');
  assert.equal((await sync.syncNow()).catchUp, false);
  assert.equal(contexts[1].catchUp, false);
  assert.equal(contexts[1].since, '');
  assert.equal(merges.length, 2);
});

test('completed batches survive a later timeout without advancing completion time', async t => {
  const fs = require('node:fs/promises');
  const os = require('node:os');
  const path = require('node:path');
  const { RmaQueryCacheStore } = require('../database/rma-query-cache-store');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'index-batch-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new RmaQueryCacheStore(path.join(dir, 'cache.json'));
  await store.mergeIncremental([{ rmaNo: 'TEST1', logisticsNo: 'OLD' }], { syncedAt: '2026-09-01T00:00:00Z' });
  const sync = new RmaQueryIndexSync({ store, logger: { info() {}, error() {} },
    readOrders: async ({ onBatch }) => {
      await onBatch([{ rmaNo: 'TEST1', logisticsNo: 'NEW' }, { rmaNo: 'TEST2' }], { nextPage: 1 });
      throw Object.assign(new Error('timeout'), { code: 'TEST_TIMEOUT' });
    },
  });
  await sync.syncNow();
  const saved = await store.readSnapshot();
  assert.equal(saved.orders.length, 2);
  assert.equal(saved.orders.find(x => x.rmaNo === 'TEST1').logisticsNo, 'NEW');
  assert.equal(saved.syncedAt, '2026-09-01T00:00:00Z');
  assert.equal(saved.syncState.status, 'FAILED');
  assert.equal(saved.syncState.nextPage, 1);
});

test('RMA query index yield leaves the local cursor unchanged', async () => {
  let merges = 0;
  const sync = new RmaQueryIndexSync({
    store: {
      async readSnapshot() { return { syncedAt: '', orders: [] }; },
      async mergeIncremental() { merges += 1; return {}; },
    },
    readOrders: async () => ({ orders: [], yielded: true }),
    logger: { info() {}, error() {} },
  });

  const result = await sync.syncNow();
  assert.equal(result.reason, 'FOREGROUND_QUERY_PRIORITY');
  assert.equal(merges, 0);
});
