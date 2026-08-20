const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveWarrantyConversion } = require("../services/warranty-conversion-policy");

test("普通保内和普通保外的保外转保内都填否", () => {
  assert.equal(resolveWarrantyConversion({ warrantyStatus: "保内" }).value, "否");
  assert.equal(resolveWarrantyConversion({ warrantyStatus: "保外" }).value, "否");
});

test("只有存在厂家特殊申请单号的批准记录才填是", () => {
  const result = resolveWarrantyConversion({
    warrantyStatus: "保外",
    manufacturerApproved: true,
    manufacturerApprovalNo: "SPECIAL-APPROVAL-001",
  });
  assert.equal(result.value, "是");
  assert.equal(result.status, "APPROVED");
});

test("声称批准但没有厂家申请单号时停止并转人工", () => {
  const result = resolveWarrantyConversion({
    warrantyStatus: "保外",
    manufacturerApproved: true,
  });
  assert.equal(result.value, null);
  assert.equal(result.status, "MANUAL_CONFIRMATION_REQUIRED");
});
