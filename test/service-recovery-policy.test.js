const test = require('node:test');
const assert = require('node:assert/strict');
const { advance } = require('../services/service-recovery-policy');
const opts = { graceMs: 10, stableMs: 1000 };
const alive = { alive: true, healthy: true };
test('startup grace, debounce, and consecutive recovery confirmation', () => {
  let { state, action } = advance(null, {}, 0, opts); assert.equal(action, 'START');
  let next = advance(state, { alive: true }, 5, opts); assert.equal(next.action, null);
  state = next.state;
  for (const time of [11, 12]) { next = advance(state, { alive: true }, time, opts); state = next.state; assert.equal(next.action, null); }
  next = advance(state, { alive: true }, 13, opts); assert.equal(next.action, 'STOP'); assert.equal(next.events[0].status, 'OPEN');
  const id = next.events[0].id;
  next = advance(next.state, {}, 2013, opts); assert.equal(next.action, 'START');
  for (const time of [2014, 2015]) { next = advance(next.state, alive, time, opts); assert.equal(next.events.length, 0); }
  next = advance(next.state, alive, 2016, opts); assert.deepEqual(next.events, [{ id, status: 'RECOVERED', kind: 'HEALTHY' }]);
});
test('repeated exits exhaust persisted budget; a new policy instance does not reset it', () => {
  let state; let time = 0;
  for (let i = 0; i < 4; i++) {
    let next = advance(state, {}, time, opts); assert.equal(next.action, 'START');
    next = advance(next.state, { alive: false }, time + 1, opts); assert.equal(next.action, 'STOP');
    state = JSON.parse(JSON.stringify(next.state)); time = state.due;
  }
  const next = advance(state, {}, time, opts); assert.equal(next.state.phase, 'HALTED');
  assert.equal(next.events.at(-1).kind, 'EXHAUSTED');
  assert.equal(advance(next.state, alive, time + 100000, opts).action, null);
});
test('fresh monitor delivery failure alerts but does not restart a healthy process', () => {
  let { state } = advance(null, {}, 0, opts);
  let next;
  for (const now of [11, 12, 13, 14]) { next = advance(state, { alive: true, healthy: false, restartable: false }, now, opts); state = next.state; assert.equal(next.action, null); }
  assert.ok(state.incident); assert.equal(state.starts.length, 1);
});
test('one component failure does not change the other component; stable operation renews budget', () => {
  const backend = advance(null, {}, 0, opts).state;
  const monitor = advance(null, {}, 0, opts).state;
  assert.equal(advance(backend, { alive: false }, 1, opts).action, 'STOP');
  assert.equal(advance(monitor, alive, 1, opts).action, null);
  const state = { ...monitor, starts: [0, 1, 2], healthySince: 1 };
  assert.equal(advance(state, alive, 1002, opts).state.starts.length, 1);
});
