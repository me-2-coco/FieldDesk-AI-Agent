const test = require("node:test");
const assert = require("node:assert/strict");
const { parseModelRows, resolveModel, resolveProjectModel, getSnProjectMatch } = require("../connectors/feishu-model-catalog");

test("parses a Feishu model sheet by header names instead of fixed columns", () => {
  const rows = parseModelRows([
    ["网点派单机型汇总"],
    ["类型", "机器型号", "项目编码", "产品型号的编码", "大修", "中修", "小修"],
    ["洗地机", "M13/M13S", "W2211", "01010300000058", 80, 60, 40],
  ]);
  assert.deepEqual(rows[0], { sourceRow: 3, productLine: "洗地机", productName: "", model: "M13/M13S", modelCode: "01010300000058", projectCode: "W2211", snPrefix: "", repairFees: { 大修: 80, 中修: 60, 小修: 40 } });
});

test("returns MATCHED when Recloud already has the Feishu model", () => {
  const result = resolveModel([{ model: "M13S", productLine: "洗地机", productName: "", projectCode: "W2211", snPrefix: "W2211" }], {
    productLine: "洗地机", projectCode: "W2211", sn: "W221102ABC", currentModel: "M13S",
  });
  assert.equal(result.status, "MATCHED");
});

test("returns CHANGE_REQUIRED only for one unambiguous model", () => {
  const result = resolveModel([{ model: "M13S", productLine: "洗地机", productName: "", projectCode: "W2211", snPrefix: "W2211" }], {
    productLine: "洗地机", projectCode: "W2211", sn: "W221102ABC", currentModel: "M13",
  });
  assert.equal(result.status, "CHANGE_REQUIRED");
  assert.equal(result.expectedModel, "M13S");
});

test("refuses to guess when several models remain", () => {
  const result = resolveModel([
    { model: "M13", productLine: "洗地机", productName: "", projectCode: "", snPrefix: "" },
    { model: "M13S", productLine: "洗地机", productName: "", projectCode: "", snPrefix: "" },
  ], { productLine: "洗地机" });
  assert.equal(result.status, "AMBIGUOUS");
});

test("SN project matching ignores a zero sixth character", () => {
  assert.deepEqual(getSnProjectMatch("W24480531CN6612529"), { projectCode: "W2448", comparisonLength: 5 });
});

test("SN project matching keeps a letter sixth character", () => {
  assert.deepEqual(getSnProjectMatch("W2211B123456"), { projectCode: "W2211B", comparisonLength: 6 });
});

test("SN project matching keeps a non-zero numeric sixth character", () => {
  assert.deepEqual(getSnProjectMatch("W22118123456"), { projectCode: "W22118", comparisonLength: 6 });
});

test("matching Recloud project number skips model correction", () => {
  const result = resolveProjectModel([
    { projectCode: "W2448", model: "T40 Ultra 中版", modelCode: "010103AA000001", repairFees: { 大修: 80, 中修: 60, 小修: 40 } },
  ], { sn: "W24480531CN6612529", currentProjectCode: "W2448" });
  assert.equal(result.status, "MATCHED");
  assert.equal(result.canContinue, true);
});

test("mismatch resolves one Feishu product model code for Recloud search", () => {
  const result = resolveProjectModel([
    { projectCode: "W2448", model: "T40 Ultra 中版", modelCode: "010103AA000001" },
  ], { sn: "W24480531CN6612529", currentProjectCode: "WRONG" });
  assert.equal(result.status, "CHANGE_REQUIRED");
  assert.equal(result.productModelCode, "010103AA000001");
});

test("mismatch stops on duplicate model codes", () => {
  const result = resolveProjectModel([
    { projectCode: "W2213/W2213D", model: "H11 S", modelCode: "01010300000061" },
    { projectCode: "W2213", model: "H11 S other", modelCode: "01010300000999" },
  ], { sn: "W221301234", currentProjectCode: "WRONG" });
  assert.equal(result.status, "DATA_ANOMALY");
  assert.equal(result.canContinue, false);
});

test("missing project in the authorized model sheet transfers to headquarters", () => {
  const result = resolveProjectModel([], { sn: "W99990123456", currentProjectCode: "W9999" });
  assert.equal(result.status, "TRANSFER_TO_HEADQUARTERS");
  assert.equal(result.repairability, "UNSUPPORTED");
  assert.equal(result.canContinue, false);
});

test("same project prefers the one numeric product model code", () => {
  const result = resolveProjectModel([
    { projectCode: "R2573", model: "S40 铂金版", modelCode: "010204AA000720", repairFees: { 大修: 80, 中修: 70, 小修: 50 } },
    { projectCode: "R2573", model: "S40 铂金版+上下水装置", modelCode: "TM202412250001", repairFees: { 大修: 80, 中修: 70, 小修: 50 } },
  ], { sn: "R25730123456", currentProjectCode: "WRONG" });
  assert.equal(result.status, "CHANGE_REQUIRED");
  assert.equal(result.productModelCode, "010204AA000720");
});
