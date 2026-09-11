const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server');

test('local state distinguishes missing orders from inaccessible orders without writes', async () => {
  const app = createApp({}, { readAll: async () => [
    { rmaNo: 'TEST-OWN', technicianId: 'tech' },
    { rmaNo: 'TEST-OTHER', technicianId: 'other' },
  ] }, { getCurrentUser: () => ({ userId: 'tech', role: 'TECHNICIAN' }) });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/repairs`;
    assert.deepEqual((await (await fetch(`${url}/TEST-MISSING/local-state`)).json()).data,
      { rmaNo: 'TEST-MISSING', exists: false });
    assert.deepEqual((await (await fetch(`${url}/TEST-OWN/local-state`)).json()).data,
      { rmaNo: 'TEST-OWN', exists: true });
    assert.equal((await fetch(`${url}/TEST-OTHER/local-state`)).status, 403);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
