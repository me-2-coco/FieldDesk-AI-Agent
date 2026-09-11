const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createUploadAdmission } = require('../services/upload-admission');
function request(gate, path = '/api/repairs/completion/attachments') {
  const req = Object.assign(new EventEmitter(), { method: 'POST', path, pause() {}, resume() {} });
  const res = Object.assign(new EventEmitter(), {
    headers: {}, setHeader(k, v) { this.headers[k] = v; },
    status(s) { this.code = s; return this; }, json(body) { this.body = body; this.emit('finish'); },
  });
  let entered = 0;
  gate(req, res, () => entered++);
  return { req, res, get entered() { return entered; } };
}
test('60 uploads wait before parsing while other requests bypass the queue', () => {
  const gate = createUploadAdmission();
  const items = Array.from({ length: 60 }, () => request(gate));
  assert.equal(items.reduce((sum, item) => sum + item.entered, 0), 2);
  assert.equal(gate.snapshot().queued, 58);
  assert.equal(request(gate, '/api/repairs/resume-step').entered, 1);
  for (const item of items) {
    assert.equal(item.entered, 1);
    assert.ok(gate.snapshot().active <= 2);
    item.res.emit('finish'); item.res.emit('close');
  }
  assert.equal(gate.snapshot().active, 0);
  assert.equal(gate.snapshot().queued, 0);
});
test('aborted queued upload never starts and an active disconnect frees its slot', () => {
  const gate = createUploadAdmission({ concurrency: 1 });
  const first = request(gate), abandoned = request(gate), next = request(gate);
  abandoned.req.emit('aborted');
  first.res.emit('close');
  assert.equal(abandoned.entered, 0);
  assert.equal(next.entered, 1);
  next.res.emit('finish');
  assert.equal(gate.snapshot().active, 0);
});
test('full queue and timed out wait return explicit retry guidance without parsing', async () => {
  const gate = createUploadAdmission({ concurrency: 1, maxQueue: 1, waitMs: 10 });
  const first = request(gate), waiting = request(gate), rejected = request(gate);
  assert.equal(rejected.res.code, 503);
  assert.equal(rejected.entered, 0);
  assert.equal(rejected.res.headers['Retry-After'], '3');
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(waiting.res.body.code, 'UPLOAD_BUSY');
  first.res.emit('finish');
  assert.equal(waiting.entered, 0);
  assert.equal(gate.snapshot().active, 0);
});

test('real HTTP queued bodies parse only after admission and health remains available', { timeout: 10000 }, async t => {
  const express = require('express');
  const { once } = require('node:events');
  const app = express();
  const gate = createUploadAdmission({ concurrency: 2 });
  let parsed = 0;
  let firstTwo;
  const entered = new Promise(resolve => { firstTwo = resolve; });
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  app.use(gate);
  app.use(express.json({ limit: '2mb' }));
  app.post('/api/repairs/completion/attachments', async (_req, res) => {
    parsed++;
    if (parsed === 2) firstTwo();
    await barrier;
    res.json({ success: true });
  });
  app.get('/api/health', (_req, res) => res.json({ success: true }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { release(); server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const work = Promise.all(Array.from({ length: 8 }, () => fetch(`${origin}/api/repairs/completion/attachments`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: 'x'.repeat(1024 * 1024) }),
  }).then(async response => { assert.equal(response.status, 200); await response.json(); })));
  await entered;
  assert.equal((await fetch(`${origin}/api/health`)).status, 200);
  assert.equal(parsed, 2);
  release();
  await work;
  assert.equal(parsed, 8);
  assert.equal(gate.snapshot().active, 0);
});
