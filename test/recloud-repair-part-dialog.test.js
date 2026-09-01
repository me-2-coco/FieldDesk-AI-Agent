const test = require("node:test");
const assert = require("node:assert/strict");
const { chooseUniqueNearbyAddButton } = require("../connectors/recloud-repair-part-dialog");

test("part add locator chooses only the add button aligned with the parts heading", () => {
  const selected = chooseUniqueNearbyAddButton(
    { x: 20, y: 300, width: 200, height: 30 },
    [
      { x: 800, y: 305, width: 60, height: 30 },
      { x: 800, y: 600, width: 60, height: 30 },
    ]
  );
  assert.equal(selected.index, 0);
});

test("part add locator refuses missing or multiple nearby add buttons", () => {
  const heading = { x: 20, y: 300, width: 200, height: 30 };
  assert.throws(() => chooseUniqueNearbyAddButton(heading, []), {
    code: "RECLOUD_REPAIR_PART_ADD_NOT_FOUND",
  });
  assert.throws(() => chooseUniqueNearbyAddButton(heading, [
    { x: 700, y: 305, width: 60, height: 30 },
    { x: 800, y: 310, width: 60, height: 30 },
  ]), { code: "RECLOUD_REPAIR_PART_ADD_AMBIGUOUS" });
});
