const test = require('node:test');
const assert = require('node:assert/strict');
const {detectOrderExceptions, exceptionRevision} = require('../services/information-exception-center');
const {buildHomeTodos} = require('../services/home-todos');

test('dismissed reminder revisions disappear without removing orders or future anomalies', () => {
  const order = {rmaNo:'SYNTHETIC-REMINDER',technicianId:'SYNTHETIC-TECH',status:'COMPLETED',updatedAt:'2026-01-01T00:00:00Z'};
  const original = JSON.stringify(order);
  const reminders = detectOrderExceptions(order);
  assert.equal(reminders.length, 2);
  const cleaned = {...order,dismissedExceptionReminders:reminders.map(item=>({revision:exceptionRevision(item),dismissedAt:'2026-01-02T00:00:00Z'}))};
  assert.deepEqual(detectOrderExceptions(cleaned), []);
  assert.equal(buildHomeTodos([cleaned],[],{role:'ADMIN'}).items.length,0);
  assert.equal(JSON.stringify(order), original);
  assert.equal(detectOrderExceptions({...cleaned,updatedAt:'2026-01-03T00:00:00Z'}).length,2);
  const extra=detectOrderExceptions({...cleaned,partsShortage:{status:'PENDING_INFORMATION'}});
  assert.deepEqual(extra.map(item=>item.type),['PARTS_SHORTAGE_PENDING']);
  assert.equal(detectOrderExceptions({...order,rmaNo:'OTHER'}).length,2);
});
