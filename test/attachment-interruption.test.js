const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { once } = require('node:events');
const { LocalRepairAttachmentStore } = require('../database/repair-attachment-store');
const { createApp } = require('../server');
async function fixture(t, options) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fielddesk-attachment-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return new LocalRepairAttachmentStore(dir, options);
}
const input = (data, rmaNo = 'LAB-ATTACHMENT') => ({ rmaNo, name: 'synthetic.mp4', mimeType: 'video/mp4', data: data.toString('base64') });

test('20MB attachment retry after response loss and store reopen returns the same file', async t => {
  const store = await fixture(t);
  const bytes = Buffer.alloc(20 * 1024 * 1024, 7);
  const first = await store.save(input(bytes));
  // The client loses this response. It resends the same bytes after reopening.
  const reopened = new LocalRepairAttachmentStore(store.directory);
  const second = await reopened.save(input(bytes));
  assert.deepEqual(second, first);
  assert.deepEqual(await reopened.read('LAB-ATTACHMENT', second), bytes);
  assert.equal(await reopened.storageUsage(), bytes.length);
});

test('concurrent duplicates across store instances consume one copy and enforce quota', async t => {
  const bytes = Buffer.alloc(1024 * 1024, 4);
  const store = await fixture(t, { maxStorageBytes: bytes.length });
  const other = new LocalRepairAttachmentStore(store.directory, { maxStorageBytes: bytes.length });
  const results = await Promise.all(Array.from({ length: 30 }, (_, i) => (i % 2 ? store : other).save(input(bytes))));
  assert.equal(new Set(results.map(result => result.id)).size, 1);
  await assert.rejects(other.save(input(bytes, 'LAB-OTHER')), { code: 'ATTACHMENT_STORAGE_LIMIT' });
  assert.equal(await store.storageUsage(), bytes.length);
});

test('failed final rename exposes no partial attachment and later upload succeeds', async t => {
  const store = await fixture(t);
  const original = fs.rename;
  fs.rename = async () => { throw Object.assign(new Error('synthetic disk failure'), { code: 'EIO' }); };
  try { await assert.rejects(store.save(input(Buffer.alloc(1024))), { code: 'EIO' }); }
  finally { fs.rename = original; }
  assert.equal(await store.storageUsage(), 0);
  const result = await store.save(input(Buffer.alloc(1024)));
  assert.equal((await store.read('LAB-ATTACHMENT', result)).length, 1024);
});

test('interrupted HTTP body leaves no file; full 20MB retry succeeds without duplication', { timeout: 30000 }, async t => {
  const store = await fixture(t);
  const app = createApp({}, null, { env: { DRY_RUN: 'true', FIELDDESK_AUTH_MODE: 'local' },
    attachmentStore: store, syncService: {}, operationalLogger: { write: () => {} },
    recloudRecoveryWatchdogEnabled: false, resumePendingRecloudReceipts: false,
    resumePendingRecloudDetections: false, resumePendingRecloudServiceOrders: false,
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const endpoint = `${origin}/api/repairs/completion/attachments`;
  const body = JSON.stringify(input(Buffer.alloc(20 * 1024 * 1024, 9)));
  const req = http.request(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } });
  req.on('error', () => {});
  const closed = new Promise(resolve => req.once('close', resolve));
  req.write(body.slice(0, 1024 * 1024), () => req.destroy());
  await closed;
  assert.equal(await store.storageUsage(), 0);
  let previous;
  const started = performance.now();
  for (let i = 0; i < 2; i++) {
    const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    assert.equal(response.status, 200);
    const result = (await response.json()).data;
    if (previous) assert.deepEqual(result, previous);
    previous = result;
  }
  assert.equal(await store.storageUsage(), 20 * 1024 * 1024);
  assert.equal((await fetch(`${origin}/api/health`)).status, 200);
  t.diagnostic(JSON.stringify({ fileMB: 20, fullRequests: 2, elapsedMs: Math.round(performance.now() - started), rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024) }));
});
