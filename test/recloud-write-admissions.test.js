const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RecloudWriteAdmissions, admissionKey } = require('../services/recloud-write-admissions');
const { createRecloudRmaWriteGuard } = require('../server');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fielddesk-admissions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, 'admissions.json');
}
const start = Date.parse('2026-01-01T00:00:00Z');
const live = { id: 'LAB-TASK', rmaNo: 'LAB-RMA', nodeType: 'REPAIR_COMPLETED', createdAt: '2026-01-01T00:01:00Z' };

test('admitted task survives disk reload and later process starts without changing result-unknown state', t => {
  const file = fixture(t);
  const first = createRecloudRmaWriteGuard(['LAB-OTHER'], start, false, new RecloudWriteAdmissions(file));
  const task = { ...live, status: 'MANUAL_REVIEW', reconciliationRequired: true };
  assert.equal(first(task.rmaNo, task), true);
  const restarted = createRecloudRmaWriteGuard(['LAB-OTHER'], start + 86400000, false, new RecloudWriteAdmissions(file));
  assert.equal(restarted(task.rmaNo, task), true);
  assert.equal(task.status, 'MANUAL_REVIEW');
  assert.equal(task.reconciliationRequired, true);
  for (const change of [{ id: 'LAB-ANOTHER' }, { createdAt: '2025-01-01' }, { nodeType: 'ORDER_COMPLETED' }]) {
    assert.equal(restarted(task.rmaNo, { ...task, ...change }), false);
  }
  assert.equal(restarted('LAB-ANOTHER-RMA', task), false);
});

test('background updates do not admit historical records; explicit business action does', t => {
  const file = fixture(t);
  const guard = createRecloudRmaWriteGuard(['LAB-OTHER'], start, false, new RecloudWriteAdmissions(file));
  const old = { ...live, nodeType: undefined, createdAt: '2025-01-01', updatedAt: '2026-01-02' };
  assert.equal(guard(old.rmaNo, old), false);
  assert.equal(fs.existsSync(file), false);
  assert.equal(guard(old.rmaNo, { ...old, treatmentDecidedAt: '2026-01-01T00:01:00Z' }), true);
  const restarted = createRecloudRmaWriteGuard(['LAB-OTHER'], start + 86400000, false, new RecloudWriteAdmissions(file));
  assert.equal(restarted(old.rmaNo, old), true);
});

test('strict whitelist still overrides durable admission', t => {
  const file = fixture(t);
  const store = new RecloudWriteAdmissions(file);
  store.grant(admissionKey(live.rmaNo, live));
  const strict = createRecloudRmaWriteGuard(['LAB-OTHER'], start, true, store);
  assert.equal(strict(live.rmaNo, live), false);
  assert.equal(strict('LAB-OTHER'), true);
});

test('signing a previously cached order admits it durably', t => {
  const file = fixture(t);
  const order = { id: 'LAB-CACHED', rmaNo: 'LAB-CACHED', createdAt: '2025-01-01', receiptCompletedAt: '2026-01-01T00:01:00Z' };
  assert.equal(createRecloudRmaWriteGuard(['LAB-OTHER'], start, false, new RecloudWriteAdmissions(file))(order.rmaNo, order), true);
  assert.equal(createRecloudRmaWriteGuard(['LAB-OTHER'], start + 86400000, false, new RecloudWriteAdmissions(file))(order.rmaNo, order), true);
});

test('corrupted or unwritable admission store fails closed', t => {
  const file = fixture(t);
  fs.writeFileSync(file, '{bad json');
  assert.throws(() => new RecloudWriteAdmissions(file));
  fs.writeFileSync(file, JSON.stringify({ version: 1, entries: [] }));
  assert.throws(() => new RecloudWriteAdmissions(file));
  const store = new RecloudWriteAdmissions(`${file}.new`);
  fs.mkdirSync(`${file}.new`);
  const guard = createRecloudRmaWriteGuard(['LAB-OTHER'], start, false, store);
  assert.throws(() => guard(live.rmaNo, live));
  assert.equal(store.has(admissionKey(live.rmaNo, live)), false);
});
