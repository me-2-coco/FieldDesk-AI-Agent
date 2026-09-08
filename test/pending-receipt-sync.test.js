const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const { PendingReceiptStore } = require('../database/pending-receipt-store');
const { shanghaiCalendarStart } = require('../scripts/backfill-pending-receipts');
const {
  PendingReceiptSync, isActiveSyncTime, millisecondsUntilNextWindow,
  pendingReceiptSyncInterval,
} = require('../services/pending-receipt-sync');

test('pending receipt schedule runs continuously every minute', () => {
  assert.equal(isActiveSyncTime(new Date('2026-08-30T22:59:59+08:00')), true);
  assert.equal(isActiveSyncTime(new Date('2026-08-30T23:00:00+08:00')), true);
  assert.equal(isActiveSyncTime(new Date('2026-08-31T06:59:59+08:00')), true);
  assert.equal(isActiveSyncTime(new Date('2026-08-31T07:00:00+08:00')), true);
  assert.equal(pendingReceiptSyncInterval({}), 60000);
  assert.equal(pendingReceiptSyncInterval({ PENDING_RECEIPT_SYNC_INTERVAL_MS: '1000' }), 30000);
  assert.equal(millisecondsUntilNextWindow(new Date('2026-08-30T23:00:00+08:00')), 60000);
});

test('three-month backfill starts at the first day of the oldest included Shanghai month', () => {
  assert.equal(shanghaiCalendarStart(3, new Date('2026-08-31T12:00:00+08:00')), '2026-06-01T00:00:00+08:00');
});

test('pending receipt store merges incrementally, removes completed and caps oldest', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pending-receipts-'));
  const store = new PendingReceiptStore(path.join(directory, 'cache.json'), { capacity: 2 });
  await store.mergeIncremental([
    { rmaNo: 'R1', cachedAt: '2026-08-30T00:00:00Z' },
    { rmaNo: 'R2', cachedAt: '2026-08-30T00:01:00Z' },
  ], { syncedAt: '2026-08-30T00:02:00Z' });
  await store.mergeIncremental([{ rmaNo: 'R3' }], { syncedAt: '2026-08-30T00:03:00Z' });
  assert.deepEqual((await store.readAll()).map((item) => item.rmaNo), ['R2', 'R3']);
  await store.mergeIncremental([], { activeRmaNos: ['R3'], syncedAt: '2026-08-31T00:00:00Z' });
  assert.deepEqual((await store.readAll()).map((item) => item.rmaNo), ['R3']);
});

test('pending receipt store serializes concurrent sync and query writes', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pending-receipts-race-'));
  const store = new PendingReceiptStore(path.join(directory, 'cache.json'));
  await Promise.all([
    store.upsert({ rmaNo: 'SYNC-RMA' }),
    store.upsert({ rmaNo: 'QUERY-RMA' }),
  ]);
  assert.deepEqual(
    (await store.readAll()).map((item) => item.rmaNo).sort(),
    ['QUERY-RMA', 'SYNC-RMA']
  );
});

test('first daytime sync performs catch-up and later sync is incremental', async () => {
  const snapshots = [
    { syncedAt: '2026-08-30T14:55:00.000Z', orders: [{ rmaNo: 'OLD', phone: '13812345678' }] },
  ];
  const store = {
    readSnapshot: async () => snapshots[0],
    mergeIncremental: async (orders, options) => ({ added: orders.length, updated: 0, removed: 0, total: 2, options }),
  };
  let context;
  const sync = new PendingReceiptSync({
    store,
    now: () => new Date('2026-08-31T07:00:00+08:00'),
    readOrders: async (value) => { context = value; return { orders: [{ rmaNo: 'NEW' }], activeRmaNos: ['OLD', 'NEW'] }; },
    logger: { info() {}, error() {} },
  });
  const result = await sync.syncNow();
  assert.equal(result.catchUp, true);
  assert.deepEqual(context.existingRmaNos, ['OLD']);
  assert.deepEqual(result.options.activeRmaNos, ['OLD', 'NEW']);
});

test('same-day backend startup continues incrementally from the persisted cursor', async () => {
  const contexts = [];
  const store = {
    readSnapshot: async () => ({
      syncedAt: '2026-08-31T01:00:00.000Z',
      orders: [{ rmaNo: 'OLD', phone: '13812345678' }],
    }),
    mergeIncremental: async () => ({ added: 0, updated: 1, removed: 0, total: 1 }),
  };
  const sync = new PendingReceiptSync({
    store,
    now: () => new Date('2026-08-31T12:00:00+08:00'),
    readOrders: async (context) => {
      contexts.push(context);
      return { orders: [], activeRmaNos: ['OLD'] };
    },
    logger: { info() {}, error() {} },
  });

  assert.equal((await sync.syncNow()).catchUp, false);
  assert.equal((await sync.syncNow()).catchUp, false);
  assert.equal(contexts.length, 2);
});

test('foreground work yields without advancing the cache timestamp', async () => {
  let merges = 0;
  const store = {
    readSnapshot: async () => ({ syncedAt: '2026-08-31T01:00:00.000Z', orders: [] }),
    mergeIncremental: async () => { merges += 1; return {}; },
  };
  let calls = 0;
  const sync = new PendingReceiptSync({
    store,
    now: () => new Date('2026-08-31T12:00:00+08:00'),
    readOrders: async () => (++calls === 1
      ? { orders: [], activeRmaNos: null, yielded: true }
      : { orders: [], activeRmaNos: [] }),
    logger: { info() {}, error() {} },
  });

  assert.equal((await sync.syncNow()).reason, 'FOREGROUND_QUERY_PRIORITY');
  assert.equal(merges, 0);
  assert.equal((await sync.syncNow()).catchUp, false);
  assert.equal(merges, 1);
});

test('sync continues outside the former daytime window', async () => {
  let called = false;
  const sync = new PendingReceiptSync({
    store: {
      readSnapshot: async () => ({ syncedAt: '', orders: [] }),
      mergeIncremental: async () => ({ added: 0, updated: 0, removed: 0, total: 0 }),
    },
    readOrders: async () => { called = true; return { orders: [], activeRmaNos: [] }; },
    now: () => new Date('2026-08-30T23:30:00+08:00'),
    logger: { info() {}, error() {} },
  });
  const result = await sync.syncNow();
  assert.equal(result.skipped, false);
  assert.equal(called, true);
});
