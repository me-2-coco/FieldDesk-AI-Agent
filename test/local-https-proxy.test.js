const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createLocalProxy } = require('../scripts/local-https-proxy');

async function listen(t, handler) {
  const server = http.createServer(handler).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return server.address().port;
}

test('API POST bypasses frontend and preserves body and authentication', async t => {
  const logs = [];
  const apiPort = await listen(t, (req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => res.end(JSON.stringify({ body, auth: req.headers.authorization, origin: req.headers.origin })));
  });
  const frontendPort = await listen(t, (req, res) => res.end('frontend'));
  const port = await listen(t, createLocalProxy({ apiPort, frontendPort, log: line => logs.push(JSON.parse(line)) }));
  const response = await fetch(`http://127.0.0.1:${port}/api/crm/repairs/query`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer synthetic', Origin: 'https://test.invalid' }, body: '{"queryValue":"TEST"}',
  });
  assert.deepEqual(await response.json(), { body: '{"queryValue":"TEST"}', auth: 'Bearer synthetic', origin: 'https://test.invalid' });
  assert.ok(response.headers.get('x-request-id'));
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), 'frontend');
  assert.ok(logs.some(item => item.event === 'proxy_request_finished'));
  assert.ok(!JSON.stringify(logs).includes('synthetic'));
});

test('stalled upstream returns explicit timeout instead of hanging', async t => {
  const apiPort = await listen(t, () => {});
  const port = await listen(t, createLocalProxy({ apiPort, timeoutMs: 30, log: () => {} }));
  const response = await fetch(`http://127.0.0.1:${port}/api/test`);
  assert.equal(response.status, 504);
  assert.equal((await response.json()).code, 'LOCAL_PROXY_TIMEOUT');
});
