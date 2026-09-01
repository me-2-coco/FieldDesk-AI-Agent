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

module.exports = { validateProjectCorrectionInput };
