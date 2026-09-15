const test = require('node:test');
const assert = require('node:assert/strict');
const { waitForExpectedPartCode } = require('../services/recloud-part-selection-wait');
test('selected part continues immediately only when the exact code is ready', async () => {
  const delays = [];
  const wait = async ms => delays.push(ms);
  assert.equal(await waitForExpectedPartCode({ inputValue: async () => ' abc ' }, 'ABC', wait), 'ABC');
  assert.deepEqual(delays, []);
  let count = 0;
  assert.equal(await waitForExpectedPartCode({ inputValue: async () => ++count === 3 ? 'ABC' : 'WRONG' }, 'ABC', wait), 'ABC');
  assert.deepEqual(delays, [100,100]);
  delays.length = 0;
  assert.equal(await waitForExpectedPartCode({ inputValue: async () => 'WRONG' }, 'ABC', wait), 'WRONG');
  assert.equal(delays.reduce((a,b) => a+b, 0), 400);
});
