const test = require("node:test");
const assert = require("node:assert/strict");
const { validateProjectCorrectionInput } = require("../services/recloud-project-correction-rules");

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
