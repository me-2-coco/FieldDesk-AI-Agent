const test = require('node:test');
const assert = require('node:assert/strict');

test('receipt photos prepare early once and serially, preserving original on failure', async () => {
  const { createReceiptPhotoPreparation } = await import('../frontend/src/shared/receiptPhotoPreparation.js');
  let active = 0; let peak = 0; let calls = 0;
  const queue = createReceiptPhotoPreparation(async file => {
    calls++; active++; peak = Math.max(peak, active);
    await Promise.resolve();
    active--;
    if (file.fail) throw new Error('decode failed');
    return { optimized: file };
  });
  const first = {}; const second = { fail: true };
  const early = queue.prepare(first);
  assert.equal(queue.prepare(first), early);
  assert.equal(await queue.prepare(second), second);
  assert.deepEqual(await early, { optimized: first });
  assert.equal(calls, 2);
  assert.equal(peak, 1);
  assert.equal(await queue.prepare(first), await early);
});
