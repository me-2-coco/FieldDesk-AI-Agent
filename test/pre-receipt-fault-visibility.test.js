const test = require("node:test");
const assert = require("node:assert/strict");
const {
  protectPreReceiptFaults,
  restrictFaultVisibilityForUser,
} = require("../services/pre-receipt-fault-visibility");

test("ordinary technician cannot see current or historical faults before receipt", () => {
  const result = protectPreReceiptFaults({
    rmaNo: "JXTH-UNSIGNED",
    reportedFault: "无法开机",
    localWorkflow: { status: "RECEIPT_PREPARED", reportedFault: "无法开机" },
    repairHistory: [{ rmaNo: "OLD", reportedFault: "主板故障" }],
  }, { restricted: true });

  assert.equal(result.reportedFault, "");
  assert.equal(result.localWorkflow.reportedFault, "");
  assert.equal(result.repairHistory[0].reportedFault, "");
  assert.equal(result.reportedFaultHiddenUntilReceipt, true);
});

test("fault becomes visible after receipt", () => {
  const detail = {
    rmaNo: "JXTH-SIGNED",
    reportedFault: "无法开机",
    localWorkflow: { receiptCompletedAt: "2026-09-08T08:00:00.000Z" },
  };
  assert.equal(protectPreReceiptFaults(detail, { restricted: true }), detail);
});

test("a Recloud-only signed state does not reveal the fault before FieldDesk receipt", () => {
  const result = protectPreReceiptFaults({
    reportedFault: "复杂故障",
    receiptState: { receiptRequired: false, label: "已签收" },
  }, { restricted: true });
  assert.equal(result.reportedFault, "");
  assert.equal(result.reportedFaultHiddenUntilReceipt, true);
});

test("administrator and owner responses remain unrestricted", () => {
  const detail = { rmaNo: "JXTH-VISIBLE", reportedFault: "无法充电" };
  assert.equal(protectPreReceiptFaults(detail, { restricted: false }), detail);
});

test("the formal Recloud test technician account is also restricted", () => {
  assert.equal(restrictFaultVisibilityForUser({ userId: "FieldDesk0004", role: "TECHNICIAN" }), true);
  assert.equal(restrictFaultVisibilityForUser({ userId: "FieldDesk0001", role: "ADMIN" }), false);
  assert.equal(restrictFaultVisibilityForUser({ userId: "FieldDesk0002", role: "INFORMATION_CLERK" }), true);
});

test("every unsigned result in a multi-order lookup is protected independently", () => {
  const result = protectPreReceiptFaults({
    matches: [
      { rmaNo: "A", reportedFault: "简单故障" },
      { rmaNo: "B", reportedFault: "复杂故障", receiptCompletedAt: "2026-09-08T08:00:00.000Z" },
    ],
  }, { restricted: true });
  assert.equal(result.matches[0].reportedFault, "");
  assert.equal(result.matches[1].reportedFault, "复杂故障");
});

test("unsigned local-order lists are protected too", () => {
  const result = protectPreReceiptFaults([
    { rmaNo: "A", reportedFault: "待签收故障" },
    { rmaNo: "B", reportedFault: "签收后故障", receiptCompletedAt: "2026-09-08T08:00:00.000Z" },
  ], { restricted: true });
  assert.equal(result[0].reportedFault, "");
  assert.equal(result[0].reportedFaultHiddenUntilReceipt, true);
  assert.equal(result[1].reportedFault, "签收后故障");
});
