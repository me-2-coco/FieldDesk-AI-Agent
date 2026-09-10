const test = require('node:test');
const assert = require('node:assert/strict');
const { withRecloud } = require('../server');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('query deadline covers opening and never runs a late query', async () => {
  let ran = false;
  let closed = false;
  const connector = { openRecloud: async () => {
    await delay(80);
    return { page: { close: async () => { closed = true; } } };
  } };
  await assert.rejects(withRecloud(connector, () => { ran = true; }, {
    concurrency: 2, totalTimeoutMs: 20,
  }), { code: 'RECLOUD_QUERY_TIMEOUT' });
  await delay(100);
  assert.equal(ran, false);
  assert.equal(closed, true);
});

test('a stalled page close does not stall the deadline or other queries', async () => {
  const connector = { openRecloud: async () => ({ page: { close: () => new Promise(() => {}) } }) };
  await assert.rejects(withRecloud(connector, () => new Promise(() => {}), {
    concurrency: 2, totalTimeoutMs: 20,
  }), { code: 'RECLOUD_QUERY_TIMEOUT' });
  assert.equal(await withRecloud(connector, async () => 'ok', {
    concurrency: 2, totalTimeoutMs: 100,
  }), 'ok');
});

test('expired queued query is removed without opening another page', async () => {
  let opened = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const connector = { openRecloud: async () => { opened++; return { page: {} }; } };
  const options = { concurrency: 2, totalTimeoutMs: 1000 };
  const active = [withRecloud(connector, () => gate, options), withRecloud(connector, () => gate, options)];
  await assert.rejects(withRecloud(connector, () => 'never', {
    concurrency: 2, totalTimeoutMs: 20,
  }), { code: 'RECLOUD_QUERY_BUSY' });
  release('ok');
  await Promise.all(active);
  assert.equal(opened, 2);
});
