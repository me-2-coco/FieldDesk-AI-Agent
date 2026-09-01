function normalize(value) {
  return String(value || "").trim();
}

function validateProjectCorrectionInput(input = {}) {
  const sn = normalize(input.sn);
  const currentProjectCode = normalize(input.currentProjectCode);
  const expectedProjectCode = normalize(input.expectedProjectCode);
  const productModelCode = normalize(input.productModelCode);
  if (!sn || !expectedProjectCode || !productModelCode) {
    throw new Error("修改项目号前必须提供 SN、正确项目号和产品型号编码");
  }
  if (!/^\d/.test(productModelCode)) {
    throw new Error("产品型号编码必须选择数字开头的编码");
  }
  return { sn, currentProjectCode, expectedProjectCode, productModelCode };
}

function buildProjectCorrectionPlan(authorization = {}, sn = "") {
  const status = normalize(authorization.status);
  const expectedProjectCode = normalize(
    authorization.expectedProjectCode || authorization.projectCode
  );
  if (status === "MATCHED") {
    return {
      action: "KEEP",
      required: false,
      currentProjectCode: normalize(authorization.currentProjectCode || authorization.projectCode),
      expectedProjectCode,
      canAutoSave: false,
    };
  }
  if (status !== "CHANGE_REQUIRED") return null;
  const values = validateProjectCorrectionInput({
    sn,
    currentProjectCode: authorization.currentProjectCode,
    expectedProjectCode,
    productModelCode: authorization.productModelCode,
  });
  return {
    action: "REPLACE",
    required: true,
    ...values,
    steps: [
      "双击当前项目号",
      "点击产品名称后的放大镜",
      "用数字开头的产品型号编码搜索",
      "勾选唯一结果并确认",
      "保存项目号修改",
    ],
    canAutoSave: false,
  };
}

module.exports = { validateProjectCorrectionInput, buildProjectCorrectionPlan };
