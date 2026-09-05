const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeControlText,
  uniqueExactCandidate,
  uniqueFullPathOrLeafCandidate,
  readSelectValue,
  clickDropdownInput,
  chooseDropdownValue,
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
  assert.equal(normalizeControlText("产品质量|万向轮异常|万向轮不良"), "产品质量 / 万向轮异常 / 万向轮不良");
});

test("saved pipe-delimited fault paths match Recloud slash-delimited options", async () => {
  const calls = [];
  const selected = await uniqueFullPathOrLeafCandidate([
    option("产品质量 / 万向轮异常 / 万向轮不良", calls),
    option("产品质量 / 异音 / 万向轮不良", calls),
  ], "产品质量|万向轮异常|万向轮不良", "faultCategory");
  await selected.click();
  assert.deepEqual(calls, ["产品质量 / 万向轮异常 / 万向轮不良"]);
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

test("restoration may match a unique leaf label from a full fault path", async () => {
  const calls = [];
  const selected = await uniqueFullPathOrLeafCandidate([
    option("产品质量 / 外观不良 / 软管外观不良", calls),
    option("产品质量 / 外观不良 / 主机外观不良", calls),
  ], "软管外观不良", "faultCategory");
  await selected.click();
  assert.deepEqual(calls, ["产品质量 / 外观不良 / 软管外观不良"]);
});

test("restoration may match a unique leaf when the saved value contains a shorter path", async () => {
  const calls = [];
  const selected = await uniqueFullPathOrLeafCandidate([
    option("产品质量 / 管路问题 / 污水管道包胶开裂", calls),
    option("产品质量 / 外观不良 / 软管外观不良", calls),
  ], "产品质量 / 污水管道包胶开裂", "faultCategory");
  assert.equal(await selected.text(), "产品质量 / 管路问题 / 污水管道包胶开裂");
});

test("a complete fault path wins over other options with the same leaf label", async () => {
  const calls = [];
  const selected = await uniqueFullPathOrLeafCandidate([
    option("产品质量 / 无法开机 / 电池包不良", calls),
    option("产品质量 / 离线 / 电池包不良", calls),
    option("产品质量 / 无法充电 / 电池包不良", calls),
  ], "产品质量 / 离线 / 电池包不良", "faultCategory");
  await selected.click();
  assert.deepEqual(calls, ["产品质量 / 离线 / 电池包不良"]);
});

test("restoration refuses duplicate leaf labels from different fault paths", async () => {
  await assert.rejects(
    uniqueFullPathOrLeafCandidate([
      option("产品质量 / 路径甲 / 软管不良", []),
      option("产品质量 / 路径乙 / 软管不良", []),
    ], "软管不良", "faultCategory"),
    { code: "RECLOUD_DETECTION_OPTION_AMBIGUOUS", fieldKey: "faultCategory" }
  );
});

test("Recloud select value is read from the visible selected tag instead of the empty search input", async () => {
  const item = {
    locator(selector) {
      assert.match(selector, /rt-picklist__tags/);
      return {
        async count() { return 1; },
        first() {
          return { async innerText() { return " 保外 "; } };
        },
      };
    },
  };

  assert.equal(await readSelectValue(item), "保外");
});

test("restoring an empty searchable value clears the selected tag, not only the search text", async () => {
  let selected = "功能问题";
  const calls = [];
  const input = {
    async count() { return 1; },
    async fill(value) { calls.push(["fill", value]); },
    async click(options) { calls.push(["input-click", options]); },
  };
  const clear = {
    async count() { return 1; },
    first() {
      return {
        async click() {
          calls.push(["clear-click"]);
          selected = "";
        },
      };
    },
  };
  const item = {
    locator(selector) {
      if (selector.includes("role='combobox'")) return { last: () => input };
      if (selector.includes("picklist-clearicon")) return clear;
      if (selector.includes("rt-picklist__tags")) {
        return {
          async count() { return selected ? 1 : 0; },
          first() { return { async innerText() { return selected; } }; },
        };
      }
      throw new Error(`unexpected selector: ${selector}`);
    },
  };

  await chooseDropdownValue({ waitForTimeout: async () => {} }, item, "", "faultCategory", true);
  assert.equal(selected, "");
  assert.deepEqual(calls, [["fill", ""], ["input-click", { timeout: 3000 }], ["clear-click"]]);
});

test("Recloud select retries with a forced click only when a selected tag intercepts the input", async () => {
  const calls = [];
  const input = {
    async click(options) {
      calls.push(options);
      if (!options.force) throw new Error("element intercepts pointer events");
    },
  };
  await clickDropdownInput(input);
  assert.deepEqual(calls, [
    { timeout: 3000 },
    { timeout: 3000, force: true },
  ]);
});
