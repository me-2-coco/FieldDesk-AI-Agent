const test = require("node:test");
const assert = require("node:assert/strict");
const { FeishuModelCatalog, parseModelRows, resolveModel, resolveProjectModel, getSnProjectMatch } = require("../connectors/feishu-model-catalog");

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
  assert.equal(result.correctionLookupRequired, false);
});

test("project matching ignores Chinese and ASCII parentheses from Feishu cells", () => {
  for (const projectCode of ["(W2449)", "（W2449）"]) {
    const result = resolveProjectModel([
      { projectCode, model: "H40 Pro（W2449）", modelCode: "011101AA000163", repairFees: { 大修: 80, 中修: 60, 小修: 0 } },
    ], { sn: "W2449054ACN6286029", currentProjectCode: "WRONG" });
    assert.equal(result.status, "CHANGE_REQUIRED");
    assert.equal(result.repairability, "SUPPORTED");
    assert.equal(result.productModelCode, "011101AA000163");
  }
});

test("project matching ignores explanatory text after a project code", () => {
  const result = resolveProjectModel([
    { projectCode: "W2448R（此款机型SN码是不带W）", model: "G20 Pro/T20 Plus/T40 Turbo", modelCode: "011104AA000005" },
  ], { sn: "W2448R55VCN6215129", currentProjectCode: "WRONG" });
  assert.equal(result.repairability, "SUPPORTED");
  assert.equal(result.productModelCode, "011104AA000005");
});

test("mismatch resolves one Feishu product model code for Recloud search", () => {
  const result = resolveProjectModel([
    { projectCode: "W2448", model: "T40 Ultra 中版", modelCode: "010103AA000001" },
  ], { sn: "W24480531CN6612529", currentProjectCode: "WRONG" });
  assert.equal(result.status, "CHANGE_REQUIRED");
  assert.equal(result.productModelCode, "010103AA000001");
  assert.equal(result.correctionLookupRequired, true);
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

test("correct current project never requires a product-code correction lookup", () => {
  const result = resolveProjectModel([
    { projectCode: "R2573", model: "S40 铂金版", modelCode: "010204AA000720", repairFees: { 大修: 80, 中修: 70, 小修: 50 } },
    { projectCode: "R2573", model: "组合编码", modelCode: "TM202412250001", repairFees: { 大修: 80, 中修: 70, 小修: 50 } },
  ], { sn: "R25730123456", currentProjectCode: "R2573" });
  assert.equal(result.status, "MATCHED");
  assert.equal(result.canContinue, true);
});

test("missing Recloud current project stops instead of guessing a correction", () => {
  const result = resolveProjectModel([
    { projectCode: "R2580X", model: "X50 Pro 履带上下水版", modelCode: "010201AA000656", repairFees: { 大修: 80, 中修: 70, 小修: 50 } },
  ], { sn: "R2580X5AMCN0146633" });
  assert.equal(result.status, "CURRENT_PROJECT_MISSING");
  assert.equal(result.canContinue, false);
  assert.equal(result.correctionLookupRequired, false);
  assert.equal(result.productModelCode, undefined);
  assert.deepEqual(result.repairFees, { 大修: 80, 中修: 70, 小修: 50 });
});

test("missing Recloud project does not guess between conflicting repair fee schedules", () => {
  const result = resolveProjectModel([
    { projectCode: "W2336", model: "H30", modelCode: "011101AA000024", repairFees: { 大修: 60, 中修: 40, 小修: 20 } },
    { projectCode: "W2336", model: "H30 other", modelCode: "011101AA000025", repairFees: { 大修: 80, 中修: 60, 小修: 30 } },
  ], { sn: "W233603AMCN012032" });
  assert.equal(result.repairFees, undefined);
});

test("R2580X example resolves the numeric model code used to correct Recloud", () => {
  const result = resolveProjectModel([
    { projectCode: "R2580X", model: "X50 Pro 履带上下水版", modelCode: "010201AA000656", repairFees: { 大修: 80, 中修: 70, 小修: 50 } },
    { projectCode: "R2580X", model: "X50 Pro 履带上下水版组合", modelCode: "TM202609010001" },
  ], { sn: "R2580X5AMCN0146633", currentProjectCode: "R25808" });
  assert.equal(result.status, "CHANGE_REQUIRED");
  assert.equal(result.projectCode, "R2580X");
  assert.equal(result.productModelCode, "010201AA000656");
});

test("live model catalog finds the named worksheet when sheet id is not configured", async () => {
  const requested = [];
  const responses = [
    { tenant_access_token: "TOKEN", code: 0 },
    { code: 0, data: { sheets: [{ sheet_id: "MODEL-SHEET", title: "网点派单机型汇总" }] } },
    { code: 0, data: { valueRange: { values: [
      ["机器型号", "项目编码", "产品型号编码", "大修", "中修", "小修"],
      ["X50 Pro 履带上下水版", "R2580X", "010201AA000656", 80, 70, 50],
    ] } } },
  ];
  const catalog = new FeishuModelCatalog({
    env: { FEISHU_APP_ID: "APP", FEISHU_APP_SECRET: "SECRET", FEISHU_SPREADSHEET_TOKEN: "SHEET" },
    fetch: async (url) => {
      requested.push(String(url));
      const body = responses.shift();
      return { ok: true, json: async () => body };
    },
  });
  const result = await catalog.authorize({ sn: "R2580X5AMCN0146633", currentProjectCode: "R25808" });
  assert.equal(result.productModelCode, "010201AA000656");
  assert.ok(requested.some((url) => url.includes("sheets/query")));
  assert.ok(requested.some((url) => url.includes("MODEL-SHEET")));
});
