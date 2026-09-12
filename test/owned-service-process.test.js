const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createOwnedProcess } = require('../services/owned-service-process');
test('owned child exits and can restart; duplicate start is rejected', async t => {
  const processOwner = createOwnedProcess({ script: path.join(__dirname, 'fixtures/owned-service.cjs'), cwd: __dirname, env: {}, output: 'ignore' });
  t.after(() => processOwner.stop(100));
  processOwner.start(); const first = processOwner.pid;
  assert.equal(processOwner.alive, true);
  assert.throws(() => processOwner.start(), /ALREADY_OWNED/);
  await processOwner.stop(100); assert.equal(processOwner.alive, false);
  assert.equal(processOwner.pid, first); // Needed to clean only this child's stale monitor lock.
  processOwner.start(); assert.notEqual(processOwner.pid, first);
  await processOwner.stop(100); assert.equal(processOwner.alive, false);
});
