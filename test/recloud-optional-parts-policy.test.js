const test = require("node:test");
const assert = require("node:assert/strict");
const {
  OPTIONAL_WHEN_OUT_OF_STOCK_PART_CODES,
  isOptionalWhenOutOfStockPart,
  onlyOptionalWhenOutOfStockParts,
} = require("../services/recloud-optional-parts-policy");

test("only the six approved universal logistics-box codes may be skipped when add-part search has no result", () => {
  assert.deepEqual([...OPTIONAL_WHEN_OUT_OF_STOCK_PART_CODES], [
    "20020100011511",
    "20020100011510",
    "20020100011509",
    "04170200001111",
    "04170200001110",
    "04170200001112",
  ]);
  assert.equal(isOptionalWhenOutOfStockPart({ partCode: "20020100011511" }), true);
  assert.equal(isOptionalWhenOutOfStockPart({ partCode: "20020100000108" }), false);
  assert.equal(onlyOptionalWhenOutOfStockParts([
    { partCode: "20020100011511" },
    { partCode: "04170200001112" },
  ]), true);
  assert.equal(onlyOptionalWhenOutOfStockParts([{ partCode: "20020100000108" }]), false);
  assert.equal(onlyOptionalWhenOutOfStockParts([]), false);
});
