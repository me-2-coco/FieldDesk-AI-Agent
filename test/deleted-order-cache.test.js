const test = require('node:test');
const assert = require('node:assert/strict');

test('deletion clears legacy and current caches without removing unrelated orders', async () => {
  const memory = new Map();
  const events = [];
  global.localStorage = {
    getItem: key => memory.get(key) ?? null,
    setItem: (key, value) => memory.set(key, String(value)),
    removeItem: key => memory.delete(key),
  };
  global.window = { dispatchEvent: event => events.push(event) };
  global.CustomEvent = class { constructor(type, options) { this.type = type; this.detail = options.detail; } };
  try {
    const store = await import('../frontend/src/shared/repairOrderStore.js');
    const deleted = { id: 'deleted', crmOrderNo: 'TEST-DELETE', status: store.REPAIR_STATUS.REPAIRING };
    localStorage.setItem('repairOrders', JSON.stringify([deleted, { id: 'keep', crmOrderNo: 'TEST-KEEP' }]));
    localStorage.setItem('currentRepairOrderId', deleted.id);
    localStorage.setItem('currentRepairOrder', JSON.stringify(deleted));
    store.removeDeletedRepairOrder('TEST-DELETE');
    assert.equal(store.getRepairOrders().some(order => order.crmOrderNo === 'TEST-DELETE'), false);
    assert.equal(store.getCurrentRepairOrder().crmOrderNo, '');
    assert.equal(store.getRepairOrders().some(order => order.id === 'keep'), true);
    assert.equal(events[0].detail.removedCurrent, true);
    store.removeDeletedRepairOrder('TEST-KEEP');
    assert.equal(events[1].detail.removedCurrent, false);
  } finally {
    delete global.localStorage;
    delete global.window;
    delete global.CustomEvent;
  }
});
