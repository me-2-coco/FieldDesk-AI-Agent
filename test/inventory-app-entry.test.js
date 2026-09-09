const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
test('inventory exposes independent functional views and retains warehouse permission and return target', () => {
  const source = fs.readFileSync(path.join(__dirname,'../frontend/src/pages/Inventory.jsx'),'utf8');
  for(const view of ['query','personal','ledger']) {
    assert.ok(source.includes(`setView("${view}")`));
    assert.ok(source.includes(`view === "${view}" && <section`));
  }
  assert.ok(source.includes('view={view}'));
  assert.ok(source.includes('setView("apps")'));
  assert.ok(source.includes('canUseWarehouse && <button'));
  assert.ok(source.includes('isTechnicianRole && <div>'));
  assert.ok(!source.includes('setView("overview")'));
});
