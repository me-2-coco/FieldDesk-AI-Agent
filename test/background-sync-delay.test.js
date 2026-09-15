const test = require('node:test');
const assert = require('node:assert/strict');
const { backgroundSyncDelay } = require('../services/background-sync-delay');
const { chooseIdleRecloudWorker } = require('../services/recloud-idle-worker');
test('background scans back off, cap at 30 minutes, and add nonnegative jitter', () => {
  assert.equal(backgroundSyncDelay(300000, 0, () => 0), 300000);
  assert.equal(backgroundSyncDelay(300000, 1, () => 0), 600000);
  assert.equal(backgroundSyncDelay(300000, 2, () => 0), 1200000);
  assert.equal(backgroundSyncDelay(300000, 9, () => 1), 1800000);
  assert.equal(backgroundSyncDelay(300000, 0, () => 1), 330000);
});
test('affinity uses only idle workers without blocking for a matching busy worker', () => {
  const a = { affinityKey: 'A' }, b = { affinityKey: 'B' };
  assert.equal(chooseIdleRecloudWorker([a,b], 'B'), b);
  b.busy = true;
  assert.equal(chooseIdleRecloudWorker([a,b], 'B'), a);
  a.retired = true;
  assert.equal(chooseIdleRecloudWorker([a,b], 'B'), undefined);
});
