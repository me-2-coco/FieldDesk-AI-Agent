const test = require('node:test');
const assert = require('node:assert/strict');
const { createRateLimiter, createBusinessRateLimiter } = require('../services/operational-security');

function send(limiter, userId, method = 'GET') {
  const result = { status: 200, headers: {} };
  limiter({ method, ip: '127.0.0.1', user: userId ? { userId } : null }, {
    setHeader: (key, value) => { result.headers[key] = value; },
    status(code) { result.status = code; return this; },
    json(body) { result.body = body; },
  }, () => { result.allowed = true; });
  return result;
}

test('same proxy IP does not merge users or reads with writes', () => {
  const limiter = createBusinessRateLimiter({ getUser: req => req.user, readLimit: 2, writeLimit: 2 });
  assert.equal(send(limiter, 'A').status, 200);
  assert.equal(send(limiter, 'A').status, 200);
  assert.equal(send(limiter, 'A').status, 429);
  assert.equal(send(limiter, 'B').status, 200);
  assert.equal(send(limiter, 'A', 'POST').status, 200);
  assert.equal(send(limiter, 'A', 'POST').status, 200);
  assert.equal(send(limiter, 'A', 'POST').status, 429);
  assert.equal(send(limiter, 'B', 'POST').status, 200);
});

test('exhausted window returns remaining delay and resets without extension', () => {
  let timestamp = 0;
  const limiter = createRateLimiter({ limit: 1, now: () => timestamp });
  assert.equal(send(limiter).status, 200);
  timestamp = 15000;
  const rejected = send(limiter);
  assert.equal(rejected.status, 429);
  assert.equal(rejected.headers['Retry-After'], '45');
  assert.equal(rejected.body.retryAfterSeconds, 45);
  timestamp = 60000;
  assert.equal(send(limiter).status, 200);
});

test('anonymous requests still share an IP limit', () => {
  const limiter = createBusinessRateLimiter({ getUser: () => null, readLimit: 1 });
  assert.equal(send(limiter).status, 200);
  assert.equal(send(limiter).status, 429);
});
