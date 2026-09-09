const test = require("node:test");
const assert = require("node:assert/strict");
const { chooseUniqueNearbyAddButton } = require("../connectors/recloud-repair-part-dialog");
const { confirmPartQuantityWarning } = require("../connectors/recloud-repair-part-dialog");

test("quantity 2 and larger confirms only the quantity warning and waits for dismissal", async () => {
  for (const quantity of [2, 3]) {
    const events = [];
    const button = { filter() { return this; }, count: async () => 1,
      click: async () => events.push("confirm") };
    const warning = { first() { return this; },
      waitFor: async ({ state }) => events.push(state),
      getByRole: (role, { name }) => {
        assert.equal(role, "button");
        assert.ok(name.test("确定"));
        assert.ok(!name.test("取消"));
        return button;
      },
      filter: ({ hasText }) => {
        assert.ok(hasText.test("核销数量超出，是否继续添加?"));
        assert.ok(!hasText.test("库存不足"));
        return warning;
      },
    };
    assert.equal(await confirmPartQuantityWarning({ locator: () => warning }, quantity), true);
    assert.deepEqual(events, ["visible", "confirm", "hidden"]);
  }
});

test("single quantity and absent quantity warning continue without confirmation", async () => {
  assert.equal(await confirmPartQuantityWarning({}, 1), false);
  const warning = { filter() { return this; }, first() { return this; },
    waitFor: async () => { const error = new Error("absent"); error.name = "TimeoutError"; throw error; } };
  assert.equal(await confirmPartQuantityWarning({ locator: () => warning }, 2), false);
});

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
