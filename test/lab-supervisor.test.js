const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { once } = require('node:events');
const { provision } = require('../scripts/start-isolated-lab');
const { superviseLab } = require('../scripts/lab-supervisor');

test('lab API restarts on same port after SIGKILL and preserves saved draft', { timeout: 20000 }, async t => {
  const root = await provision(path.resolve(__dirname, '..'));
  const alertFile = path.join(root, 'guard-alert.json');
  await fs.writeFile(alertFile, JSON.stringify({ id: 'synthetic-incident', status: 'OPEN', openedAt: new Date().toISOString() }));
  const guard = superviseLab(path.join(root, 'scripts/isolated-lab-server.js'), {
    cwd: root, delayMs: 50, alertFile, env: { PATH: process.env.PATH, TMPDIR: os.tmpdir(), FIELDDESK_LAB_PORT: '0' },
  });
  t.after(() => guard.stop());
  const [first] = await once(guard, 'ready');
  const recovered = JSON.parse(await fs.readFile(alertFile));
  assert.equal(recovered.status, 'RECOVERED'); assert.equal(recovered.id, 'synthetic-incident');
  const origin = `http://127.0.0.1:${first.port}`;
  const { password } = JSON.parse(await fs.readFile(path.join(root, 'lab-login.json')));
  const login = await fetch(origin + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: 'lab-tech', password }) });
  assert.equal(login.status, 200); await login.json();
  const headers = { Cookie: login.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json' };
  const bytes = Buffer.alloc(1024, 7);
  const upload = await fetch(origin + '/api/repairs/completion/attachments', { method: 'POST', headers, body: JSON.stringify({ rmaNo: 'LAB-DRAFT-0004', name: 'synthetic.png', mimeType: 'image/png', data: bytes.toString('base64') }) });
  assert.equal(upload.status, 200);
  const attachment = (await upload.json()).data;
  const saved = await fetch(origin + '/api/repairs/completion/draft', { method: 'POST', headers, body: JSON.stringify({ rmaNo: 'LAB-DRAFT-0004', detectionResult: '维修', repairMeasure: '模拟守护恢复', attachments: [attachment] }) });
  assert.equal(saved.status, 200); await saved.json();
  const file = path.join(root, 'database/data/receipt-preparations.json');
  const before = await fs.readFile(file, 'utf8');
  const ready = once(guard, 'ready');
  process.kill(first.pid, 'SIGKILL');
  const [second] = await ready;
  assert.notEqual(second.pid, first.pid); assert.equal(second.port, first.port);
  assert.equal((await fetch(origin + '/api/health')).status, 200);
  assert.equal(await fs.readFile(file, 'utf8'), before);
  const relogin = await fetch(origin + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: 'lab-tech', password }) });
  assert.equal(relogin.status, 200); await relogin.json();
  const download = await fetch(origin + `/api/repairs/LAB-DRAFT-0004/attachments/repair/${attachment.id}`, { headers: { Cookie: relogin.headers.get('set-cookie').split(';')[0] } });
  assert.equal(download.status, 200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
  await guard.stop();
  await assert.rejects(fetch(origin + '/api/health'));
  t.diagnostic('Real isolated API restored on same port; draft unchanged; explicit stop closes service.');
});

test('lab guard stops restarting after bounded launch failures', { timeout: 5000 }, async t => {
  const guard = superviseLab('/nonexistent-fielddesk-lab-worker.js', { cwd: os.tmpdir(), env: { PATH: process.env.PATH }, delayMs: 10, maxRestarts: 2 });
  t.after(() => guard.stop());
  await once(guard, 'exhausted');
  await guard.stop();
});

test('exhaustion alert persists and repeated incident does not emit duplicates', { timeout: 5000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fielddesk-guard-alert-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const alertFile = path.join(root, 'alert.json');
  let alerts = 0;
  async function fail() {
    const guard = superviseLab('/nonexistent-fielddesk-lab-worker.js', { cwd: root, env: { PATH: process.env.PATH }, delayMs: 10, maxRestarts: 1, alertFile });
    guard.on('alert', () => alerts++);
    t.after(() => guard.stop());
    await once(guard, 'exhausted'); await guard.stop();
    return JSON.parse(await fs.readFile(alertFile));
  }
  const first = await fail(), second = await fail();
  assert.equal(first.status, 'OPEN');
  assert.equal(second.id, first.id); assert.equal(alerts, 1);
  assert.equal(second.notificationStatus, 'NOT_CONFIGURED');
  assert.equal((await fs.stat(alertFile)).mode & 0o777, 0o600);
});

test('alert write failure is surfaced without interrupting exhaustion event', { timeout: 5000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fielddesk-guard-alert-error-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const guard = superviseLab('/nonexistent-fielddesk-lab-worker.js', { cwd: root, env: { PATH: process.env.PATH }, maxRestarts: 0, alertFile: root });
  t.after(() => guard.stop());
  const failure = once(guard, 'alertPersistenceFailed');
  await once(guard, 'exhausted');
  assert.equal((await failure)[0].code, 'LAB_ALERT_SAVE_FAILED');
});
