const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

test('scan and manual lookup send the same body and only read queries retry transport errors', async t => {
  const source = (await fs.readFile(path.join(__dirname, '../frontend/src/shared/crmService.js'), 'utf8'))
    .replace("'./queryIdentifier.js'", JSON.stringify(pathToFileURL(path.join(__dirname, '../frontend/src/shared/queryIdentifier.js')).href))
    .replace('import.meta.env.VITE_API_BASE_URL', '""');
  const originalFetch = global.fetch;
  const originalWindow = global.window;
  global.window = { setTimeout, clearTimeout };
  t.after(() => { global.fetch = originalFetch; global.window = originalWindow; });
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, ...options });
    if (calls.length === 1) throw new TypeError('connection reset');
    return new Response(JSON.stringify({ success: true, data: { rmaNo: 'TEST' } }), { status: 200 });
  };
  const service = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  await service.queryCrmRepairByAnyIdentifier(']C1SF1234567890123\r\n');
  await service.queryCrmRepairByAnyIdentifier('SF1234567890123');
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.body === '{"queryValue":"SF1234567890123"}'));
  assert.equal(calls[0].headers['X-Request-Id'], calls[1].headers['X-Request-Id']);
  assert.equal(calls[0].cache, 'no-store');
  let attempts = 0;
  global.fetch = async () => { attempts++; throw new TypeError('offline'); };
  await assert.rejects(service.changeFieldDeskPassword('synthetic-test'), /连接中断/);
  assert.equal(attempts, 1);
});
