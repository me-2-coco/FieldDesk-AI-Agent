const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { acquireProcessLock } = require('../services/process-lock');
test('live lock refuses takeover; a confirmed dead owner permits one restart', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fielddesk-lock-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'monitor.lock');
  await acquireProcessLock(file); await assert.rejects(acquireProcessLock(file), /STILL_OWNS/);
  const child = spawn(process.execPath, ['-e', 'process.exit(0)']); await once(child, 'close');
  await fs.writeFile(file, String(child.pid));
  await acquireProcessLock(file);
  assert.equal(await fs.readFile(file, 'utf8'), String(process.pid));
  assert.equal((await fs.readdir(root)).filter(x => x.includes('.stale-')).length, 1);
});
