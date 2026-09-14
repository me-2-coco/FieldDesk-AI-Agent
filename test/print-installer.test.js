const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { PrintJobStore } = require('../database/print-job-store');

test('preconfigured ZIP preserves Unicode and JSON without shell interpolation', async (t) => {
  const { buildStoredZip, installerFiles } = await import('../frontend/src/shared/printInstaller.js');
  const credential = { terminal: { id: 'test-terminal', printerName: '标签机 $(bad)' }, token: 'synthetic-token' };
  const files = installerFiles(credential, 'https://example.com', 'param()', '# agent');
  assert.equal(JSON.parse(files['setup.json']).printerName, credential.terminal.printerName);
  assert.ok(!files['Install.cmd'].includes(credential.token));
  assert.ok(files['Install-FieldDesk-Print-Agent.ps1'].startsWith('\uFEFF'));
  assert.throws(() => installerFiles(credential, 'http://example.com', '', ''), /HTTPS/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fielddesk-print-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'setup.zip');
  fs.writeFileSync(file, Buffer.from(await buildStoredZip(files).arrayBuffer()));
  execFileSync('unzip', ['-t', file]);
  assert.equal(execFileSync('unzip', ['-p', file, 'setup.json'], { encoding: 'utf8' }), files['setup.json']);
});

test('renewal revokes old terminal credentials, preserves membership and refuses printing jobs', async () => {
  const store = new PrintJobStore({ driver: 'memory' });
  const first = await store.saveTerminal({ name: 'Test', printerName: 'Test printer', memberUserIds: ['test-user'] });
  const next = await store.renewEnrollment(first.terminal.id);
  assert.equal(await store.authenticate(first.terminal.id, first.enrollmentToken), null);
  assert.ok(await store.authenticate(first.terminal.id, next.enrollmentToken));
  assert.deepEqual(next.terminal.memberUserIds, ['test-user']);
  assert.equal(next.terminal.tokenHash, undefined);
  await store.backend.update(data => { data.jobs.push({ terminalId: first.terminal.id, status: 'PRINTING' }); });
  await assert.rejects(() => store.renewEnrollment(first.terminal.id), /正在打印/);
  assert.ok(await store.authenticate(first.terminal.id, next.enrollmentToken));
});
