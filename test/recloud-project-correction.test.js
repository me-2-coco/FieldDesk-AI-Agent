const test = require("node:test");
const assert = require("node:assert/strict");
const { validateProjectCorrectionInput, buildProjectCorrectionPlan } = require("../services/recloud-project-correction-rules");
const { projectTextMatchesCode } = require("../connectors/recloud");

test("project verification accepts a code shown together with the model name", () => {
  assert.equal(projectTextMatchesCode("S10 Plus（R2246B）", "R2246B"), true);
  assert.equal(projectTextMatchesCode("R2246B", "R2246B"), true);
  assert.equal(projectTextMatchesCode("R2246B1", "R2246B"), false);
});

test("accepts the R2580X correction learned from the model summary", () => {
  assert.deepEqual(validateProjectCorrectionInput({
    sn: "R2580X5AMCN0146633",
    currentProjectCode: "R25808",
    expectedProjectCode: "R2580X",
    productModelCode: "010201AA000656",
  }), {
    sn: "R2580X5AMCN0146633",
    currentProjectCode: "R25808",
    expectedProjectCode: "R2580X",
    productModelCode: "010201AA000656",
  });
});

test("rejects the letter-starting duplicate product model code", () => {
  assert.throws(() => validateProjectCorrectionInput({
    sn: "R2580X5AMCN0146633",
    expectedProjectCode: "R2580X",
    productModelCode: "TM202609010001",
  }), /数字开头/);
});

test("reports the exact missing project-correction field", () => {
  assert.throws(
    () => validateProjectCorrectionInput({ sn: "R2228Z2CBCN045960000P01", expectedProjectCode: "R2228" }),
    (error) => error.code === "RECLOUD_PROJECT_CORRECTION_INPUT_MISSING"
      && error.message === "修改项目号缺少：产品型号编码"
  );
});

test("matching project produces a keep plan with no modification", () => {
  assert.deepEqual(buildProjectCorrectionPlan({
    status: "MATCHED",
    currentProjectCode: "W2458S",
    projectCode: "W2458S",
  }, "W2458S53NCN7170529"), {
    action: "KEEP",
    required: false,
    currentProjectCode: "W2458S",
    expectedProjectCode: "W2458S",
    canAutoSave: false,
  });
});

test("mismatch produces the exact R2580X numeric-code correction plan", () => {
  const plan = buildProjectCorrectionPlan({
    status: "CHANGE_REQUIRED",
    currentProjectCode: "R25808",
    projectCode: "R2580X",
    productModelCode: "010201AA000656",
  }, "R2580X5AMCN0146633");
  assert.equal(plan.action, "REPLACE");
  assert.equal(plan.required, true);
  assert.equal(plan.productModelCode, "010201AA000656");
  assert.equal(plan.canAutoSave, false);
  assert.deepEqual(plan.steps, [
    "双击当前项目号",
    "点击产品名称后的放大镜",
    "用数字开头的产品型号编码搜索",
    "勾选唯一结果并确认",
    "保存项目号修改",
  ]);
});
