const test = require("node:test");
const assert = require("node:assert/strict");
const { searchTargetTechnician } = require("../connectors/recloud-repair-execution-inspector");

function fixture(results) {
  let names = [];
  const queries = [];
  const dialog = { getByText(pattern) {
    const matches = names.filter(name => pattern.test(name));
    return { filter() { return this; }, async count() { return matches.length; },
      nth(index) { return { locator() { return {
        async count() { return 1; }, async isVisible() { return true; },
        first() { return matches[index]; },
      }; } }; },
    };
  } };
  return { dialog, queries, async search(query) { queries.push(query); names = results[query] || []; } };
}

test("full name is preferred and no fallback is needed when unique", async () => {
  const f = fixture({ "杨勇": ["杨勇"] });
  assert.deepEqual(await searchTargetTechnician(f.dialog, "杨勇", f.search), ["杨勇"]);
  assert.deepEqual(f.queries, ["杨勇"]);
});
test("surname fallback matches full name ignoring whitespace, not other people", async () => {
  const f = fixture({ "杨": ["杨明", "杨　 勇", "杨勇刚"] });
  assert.deepEqual(await searchTargetTechnician(f.dialog, "杨勇", f.search), ["杨　 勇"]);
  assert.deepEqual(f.queries, ["杨勇", "杨"]);
});
test("duplicate full names stay ambiguous without fallback", async () => {
  const f = fixture({ "杨勇": ["杨勇", "杨 勇"] });
  assert.equal((await searchTargetTechnician(f.dialog, "杨勇", f.search)).length, 2);
  assert.deepEqual(f.queries, ["杨勇"]);
});
test("surname results with duplicate normalized names stay ambiguous", async () => {
  const f = fixture({ "杨": ["杨勇", "杨 勇"] });
  assert.equal((await searchTargetTechnician(f.dialog, "杨勇", f.search)).length, 2);
});
test("no full-name match after surname search remains empty", async () => {
  const f = fixture({ "杨": ["杨明", "杨勇刚"] });
  assert.deepEqual(await searchTargetTechnician(f.dialog, "杨勇", f.search), []);
});
