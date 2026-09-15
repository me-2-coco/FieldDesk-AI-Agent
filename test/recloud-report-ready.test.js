const test = require('node:test');
const assert = require('node:assert/strict');
const { openServiceReport, dismissBlockingRepairMessageBoxes } = require('../connectors/recloud-repair-page-adapter');

test('explicit zero notice settle does not fall back to 250ms', async () => {
  const waits = [];
  const page = { locator: () => ({ count: async () => 0 }), waitForTimeout: async ms => waits.push(ms) };
  await dismissBlockingRepairMessageBoxes(page, { settleMs: 0 });
  assert.deepEqual(waits, []);
  await dismissBlockingRepairMessageBoxes(page);
  assert.deepEqual(waits, [250]);
});

test('report waits for real content and propagates readiness failure without a fixed sleep', async () => {
  const events = [];
  let failure;
  const heading = {
    filter() { return this; }, count: async () => 0,
    async waitFor(options) { events.push(options); if (failure) throw failure; },
  };
  const tab = {
    filter() { return this; }, count: async () => 1, first() { return this; },
    getAttribute: async () => 'false', click: async () => events.push('click'),
  };
  const page = {
    locator: () => ({ count: async () => 0 }),
    getByText: text => text === '服务报告' ? tab : heading,
    waitForTimeout: async () => { throw new Error('unexpected fixed wait'); },
  };
  await openServiceReport(page, 15000);
  assert.deepEqual(events, ['click', { state: 'visible', timeout: 15000 }]);
  failure = new Error('report unavailable');
  await assert.rejects(openServiceReport(page), error => error === failure);
});
