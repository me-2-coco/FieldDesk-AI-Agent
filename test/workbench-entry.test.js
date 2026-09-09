const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('workbench has name search and direct technician entry with self-only filtering', () => {
  const home = fs.readFileSync(path.join(__dirname, '../frontend/src/pages/Home.jsx'), 'utf8');
  assert.match(home, /aria-label="搜索师傅姓名"/);
  assert.match(home, /searchedTechnicians\.map/);
  assert.match(home, /view: "work", title: "师傅工作台"/);
  assert.match(home, /workflows\.filter\(item => \(item\.technicianId \|\| item\.operatorId\) === \(currentUser\?\.userId \|\| currentUser\?\.id\)\)/);
  assert.match(home, /desktopView === "work" && isTechnician/);
  assert.doesNotMatch(home, /className="home-technician-back"/);
});
