const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeControlText,
  uniqueExactCandidate,
} = require("../connectors/recloud-detection-control-adapter");

function option(text, calls) {
  return {
    async text() { return text; },
    async click() { calls.push(text); },
  };
}

test("Recloud detection option matching normalizes whitespace but requires an exact value", async () => {
  const calls = [];
  const selected = await uniqueExactCandidate([
    option(" 保内 ", calls),
    option("保外", calls),
  ], "保内", "warrantyStatus");
  await selected.click();
  assert.deepEqual(calls, [" 保内 "]);
  assert.equal(normalizeControlText("产品质量  /\n水泵不良"), "产品质量 / 水泵不良");
});

test("Recloud detection option matching refuses a partial match", async () => {
  await assert.rejects(
    uniqueExactCandidate([option("维修完成", [])], "维修", "detectionResult"),
    { code: "RECLOUD_DETECTION_OPTION_NOT_FOUND", fieldKey: "detectionResult" }
  );
});

test("Recloud detection option matching refuses duplicate exact labels", async () => {
  await assert.rejects(
    uniqueExactCandidate([option("是", []), option("是", [])], "是", "originalConsumables"),
    { code: "RECLOUD_DETECTION_OPTION_AMBIGUOUS", fieldKey: "originalConsumables" }
  );
});
