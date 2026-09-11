const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const load = () => import(pathToFileURL(path.join(__dirname, '../frontend/src/shared/uploadRetry.js')).href);
const busy = () => Object.assign(new Error('busy'), { status: 503, code: 'UPLOAD_BUSY', retryAfterSeconds: '3' });
test('explicit not-accepted busy response retries with delay and succeeds', async () => {
  const { retryBusyUpload } = await load();
  let calls = 0; const delays = [];
  const result = await retryBusyUpload(async () => { if (++calls < 3) throw busy(); return 'ok'; }, {
    sleep: async ms => delays.push(ms), random: () => 0.5,
  });
  assert.equal(result, 'ok'); assert.equal(calls, 3); assert.deepEqual(delays, [3500, 3500]);
});
test('continuous busy stops at four attempts', async () => {
  const { retryBusyUpload } = await load(); let calls = 0;
  await assert.rejects(retryBusyUpload(async () => { calls++; throw busy(); }, { sleep: async () => {} }), /自动重试已停止/);
  assert.equal(calls, 4);
});
test('transport failure, unknown result and authentication errors never retry', async () => {
  const { retryBusyUpload } = await load();
  for (const error of [new Error('network lost'), { status: 503, code: 'RESULT_UNKNOWN' }, { status: 401, code: 'AUTH_REQUIRED' }]) {
    let calls = 0;
    await assert.rejects(retryBusyUpload(async () => { calls++; throw error; }), value => value === error);
    assert.equal(calls, 1);
  }
});
test('session change during delay prevents sending file under another account', async () => {
  const { retryBusyUpload } = await load(); let current = true; let calls = 0;
  await assert.rejects(retryBusyUpload(async () => { calls++; throw busy(); }, {
    isCurrent: () => current, sleep: async () => { current = false; },
  }), /登录状态已变化/);
  assert.equal(calls, 1);
});
