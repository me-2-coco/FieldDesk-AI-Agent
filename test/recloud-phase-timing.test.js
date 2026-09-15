const test = require('node:test');
const assert = require('node:assert/strict');
const { timeRecloudPhase, withRecloudTimingContext } = require('../services/recloud-phase-timing');

test('phase timing preserves values/errors, records timestamps and never logs payloads', async (t) => {
  const rows = [];
  t.mock.method(console, 'info', (tag, json) => rows.push(JSON.parse(json)));
  const value = { privateAttachment: 'do-not-log' };
  assert.equal(await timeRecloudPhase('LAB', 'read', async () => value), value);
  const failure = new Error('secret error body');
  await assert.rejects(timeRecloudPhase('LAB', 'write', async () => { throw failure; }), error => error === failure);
  assert.deepEqual(rows.map(row => row.success), [true, false]);
  for (const row of rows) {
    assert.ok(Number.isFinite(Date.parse(row.startedAt)));
    assert.ok(Number.isFinite(Date.parse(row.finishedAt)));
    assert.ok(row.ms >= 0);
  }
  assert.ok(!JSON.stringify(rows).includes('do-not-log'));
  assert.ok(!JSON.stringify(rows).includes('secret error body'));
});

test('parallel task timing keeps task identities isolated and restores outer context', async (t) => {
  const rows = [];
  t.mock.method(console, 'info', (tag, json) => rows.push(JSON.parse(json)));
  await Promise.all(['A', 'B'].map(id => withRecloudTimingContext({ id, nodeType: 'REPAIR_COMPLETED', retryCount: 2, payload: 'secret' },
    () => timeRecloudPhase(id, 'outer', async () => {
      await Promise.resolve();
      return timeRecloudPhase(id, 'inner', async () => id);
    }))));
  for (const row of rows) {
    assert.equal(row.taskId, row.orderKey);
    assert.equal(row.retryCount, 2);
    assert.equal(row.payload, undefined);
  }
  await timeRecloudPhase('C', 'outside', async () => {});
  assert.equal(rows.at(-1).taskId, undefined);
});
