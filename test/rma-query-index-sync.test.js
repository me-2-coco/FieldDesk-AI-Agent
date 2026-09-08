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

test('RMA query index performs one catch-up then follows the local cursor', async () => {
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
  assert.deepEqual(contexts[0], { catchUp: true, since: '' });
  assert.equal((await sync.syncNow()).catchUp, false);
  assert.deepEqual(contexts[1], {
    catchUp: false,
    since: '2026-09-08T10:00:00.000Z',
  });
  assert.equal(merges.length, 2);
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
