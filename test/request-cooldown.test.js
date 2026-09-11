const test = require('node:test');
const assert = require('node:assert/strict');
const { businessRateScope, createBusinessRateLimiter } = require('../services/operational-security');

test('frontend cooldown respects server deadline and does not block other categories', async () => {
  const { createRequestCooldown, requestScope } = await import('../frontend/src/shared/requestCooldown.js');
  let now = 1000;
  const cooldown = createRequestCooldown(() => now);
  cooldown.record('poll', 45);
  assert.throws(() => cooldown.check('poll'), { status: 429, retryAfterSeconds: 45 });
  for (const scope of ['read', 'upload', 'write']) assert.doesNotThrow(() => cooldown.check(scope));
  now += 45000;
  assert.doesNotThrow(() => cooldown.check('poll'));
  cooldown.record('write', 60);
  cooldown.reset();
  assert.doesNotThrow(() => cooldown.check('write'));
  for (const method of ['GET', 'POST']) for (const path of [
    '/api/repairs/TEST/sync-status', '/api/repairs/TEST/local-state',
    '/api/repairs/completion/attachments', '/api/supervision/monitor/status',
    '/api/repairs/local-orders', '/api/repairs/completion/context',
  ]) assert.equal(requestScope(method, path + '?test=1'), businessRateScope({ method, path }));
});

test('approved default ceilings are independent and still enforced', () => {
  const limiter = createBusinessRateLimiter({ getUser: () => ({ userId: 'test' }) });
  for (const [method, path, limit] of [
    ['GET', '/api/repairs/TEST/sync-status', 300],
    ['GET', '/api/query', 600],
    ['POST', '/api/repairs/completion/attachments', 120],
    ['POST', '/api/submit', 180],
  ]) {
    for (let i = 0; i <= limit; i++) {
      let status = 200;
      limiter({ method, path }, { setHeader() {}, status(code) { status = code; return this; }, json() {} }, () => {});
      assert.equal(status, i === limit ? 429 : 200);
    }
  }
});
