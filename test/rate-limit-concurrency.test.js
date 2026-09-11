const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server');

async function start(t, extraEnv = {}) {
  const logs = [];
  const app = createApp({}, { readAll: async () => [] }, {
    env: { FIELDDESK_AUTH_MODE: 'accounts', DRY_RUN: 'true', ...extraEnv },
    accountStore: {
      ensureBootstrap: async () => {},
      findSession: async token => /^test-\d+$/.test(token) ? { userId: token } : null,
      findByUserId: async userId => ({ userId, role: 'TECHNICIAN' }),
      findByToken: async () => null,
      findByCredentials: async userId => /^test-\d+$/.test(userId) ? { userId, role: 'TECHNICIAN' } : null,
      createSession: async () => {},
    },
    coordinationStore: { assertAvailable: async () => {} },
    operationalLogger: { write: (stream, row) => logs.push(row) },
    syncService: {},
  });
  // Synthetic handlers deliberately do not touch disk or contact Recloud.
  app.get('/api/loadtest/query', (req, res) => res.json({ success: true }));
  app.post('/api/loadtest/attachments', (req, res) => res.json({ success: true }));
  app.post('/api/loadtest/submit', (req, res) => res.json({ success: true }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const send = (id, path, method = 'GET', extraHeaders = {}, body = {}) => fetch(url + path, {
    method, headers: { Authorization: `Bearer test-${id}`, 'Content-Type': 'application/json', ...extraHeaders },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  });
  return { send, logs };
}

test('60 accounts on one IP: 2400 mixed HTTP requests remain isolated', async t => {
  const { send } = await start(t);
  const times = [];
  const begin = performance.now();
  await Promise.all(Array.from({ length: 60 }, async (_, id) => {
    for (let round = 0; round < 10; round++) {
      for (const [path, method] of [
        ['/api/repairs/TEST-MISSING/local-state', 'GET'],
        ['/api/loadtest/query', 'GET'],
        ['/api/loadtest/attachments', 'POST'],
        ['/api/loadtest/submit', 'POST'],
      ]) {
        const start = performance.now();
        const response = await send(id, path, method, {}, { data: 'x'.repeat(4096) });
        assert.equal(response.status, 200);
        await response.arrayBuffer();
        times.push(performance.now() - start);
      }
    }
  }));
  times.sort((a, b) => a - b);
  t.diagnostic(JSON.stringify({ accounts: 60, requests: times.length, elapsedMs: Math.round(performance.now() - begin), p95Ms: Math.round(times[Math.floor(times.length * .95)]), maxMs: Math.round(times.at(-1)), recloudWrites: 0 }));
});

test('account identity is authenticated, buckets independent, rejections logged', async t => {
  const { send, logs } = await start(t, { API_POLL_RATE_LIMIT_PER_MINUTE: '1' });
  assert.equal((await send(0, '/api/repairs/TEST/local-state')).status, 200);
  const limited = await send(0, '/api/repairs/TEST/local-state', 'GET', { 'X-FieldDesk-Local-User': 'spoofed' });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.ok(limited.headers.get('x-request-id'));
  assert.equal((await send(1, '/api/repairs/TEST/local-state')).status, 200);
  assert.equal((await send(0, '/api/loadtest/query')).status, 200);
  assert.equal((await send(0, '/api/loadtest/attachments', 'POST')).status, 200);
  assert.equal((await send(0, '/api/loadtest/submit', 'POST')).status, 200);
  assert.ok(logs.some(row => row.status === 429));
});

test('60 logins share an IP while one account remains capped at 10', async t => {
  const { send } = await start(t);
  for (let id = 0; id < 60; id++) {
    assert.equal((await send(id, '/api/auth/login', 'POST', {}, { userId: `test-${id}`, password: 'synthetic' })).status, 200);
  }
  for (let i = 1; i < 10; i++) {
    assert.equal((await send(0, '/api/auth/login', 'POST', {}, { userId: 'test-0' })).status, 200);
  }
  assert.equal((await send(0, '/api/auth/login', 'POST', {}, { userId: 'test-0' })).status, 429);
});
