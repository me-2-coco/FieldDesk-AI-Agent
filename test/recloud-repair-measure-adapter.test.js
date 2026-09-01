const test = require("node:test");
const assert = require("node:assert/strict");
const {
  rankRepairMeasureRows,
  chooseUniqueRepairMeasureRow,
  createRecloudRepairMeasureAdapter,
} = require("../connectors/recloud-repair-measure-adapter");

test("repair measure row is the nearest table row below the exact section heading", () => {
  const heading = { x: 10, y: 300, width: 200, height: 30 };
  const rows = [
    { x: 10, y: 100, width: 700, height: 40 },
    { x: 10, y: 420, width: 700, height: 40 },
    { x: 10, y: 350, width: 700, height: 40 },
  ];
  assert.deepEqual(rankRepairMeasureRows(heading, rows).map((item) => item.index), [2, 1]);
  assert.equal(chooseUniqueRepairMeasureRow(heading, rows).index, 2);
});

test("repair measure row locator refuses equally positioned DOM duplicates", () => {
  const heading = { x: 10, y: 300, width: 200, height: 30 };
  assert.throws(() => chooseUniqueRepairMeasureRow(heading, [
    { x: 10, y: 350, width: 700, height: 40 },
    { x: 10, y: 350, width: 700, height: 40 },
  ]), { code: "RECLOUD_REPAIR_MEASURE_ROW_AMBIGUOUS" });
});

test("repair measure adapter reads and writes only the repairMeasure field", async () => {
  let value = "原措施";
  const field = {
    async inputValue() { return value; },
    async isEditable() { return true; },
    async fill(next) { value = next; },
  };
  const adapter = createRecloudRepairMeasureAdapter(field);
  assert.equal(await adapter.read("repairMeasure"), "原措施");
  await adapter.write("repairMeasure", "新措施");
  assert.equal(await adapter.read("repairMeasure"), "新措施");
  await assert.rejects(adapter.write("highestRepairLevel", "中修"), {
    code: "RECLOUD_REPAIR_CONTROL_EXCLUDED", fieldKey: "highestRepairLevel",
  });
});
