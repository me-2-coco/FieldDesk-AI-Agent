const test = require("node:test");
const assert = require("node:assert/strict");
const {
  RECLOUD_WORK_ORDER_OPERATION_POLICY,
  buildRecloudAssignmentPlan,
  assertRecloudOperationAllowed,
} = require("../services/recloud-work-order-operation-policy");

test("改派固定选择目标师傅行的负责人，不允许协助", () => {
  assert.deepEqual(buildRecloudAssignmentPlan("唐张帅"), {
    servicePerson: "唐张帅",
    action: "负责人",
    forbiddenAction: "协助",
  });
  assert.throws(
    () => assertRecloudOperationAllowed({ action: "协助" }),
    { code: "RECLOUD_ASSIGNMENT_ACTION_FORBIDDEN" }
  );
});

test("签收、配件、字段和附件禁区全部失败关闭", () => {
  const blocked = [
    [{ action: "代客户收件" }, "RECLOUD_RECEIPT_ACTION_FORBIDDEN"],
    [{ action: "放大镜" }, "RECLOUD_PART_LOOKUP_FORBIDDEN"],
    [{ target: "责任判定" }, "RECLOUD_FIELD_TARGET_FORBIDDEN"],
    [{ target: "品质描述" }, "RECLOUD_FIELD_TARGET_FORBIDDEN"],
    [{ target: "附件（检测报告）" }, "RECLOUD_ATTACHMENT_TARGET_FORBIDDEN"],
    [{ action: "查看审批历史", afterSubmit: true }, "RECLOUD_POST_SUBMIT_ACTION_FORBIDDEN"],
  ];
  for (const [operation, code] of blocked) {
    assert.throws(() => assertRecloudOperationAllowed(operation), { code });
  }
});

test("正式操作策略固定直接输编码、主附件和提交后停止", () => {
  assert.equal(RECLOUD_WORK_ORDER_OPERATION_POLICY.partEntryMode, "DIRECT_CODE_INPUT");
  assert.equal(RECLOUD_WORK_ORDER_OPERATION_POLICY.partEntryTarget, "新件名称");
  assert.equal(RECLOUD_WORK_ORDER_OPERATION_POLICY.attachmentTarget, "附件");
  assert.equal(RECLOUD_WORK_ORDER_OPERATION_POLICY.troubleshootingValue, "否");
  assert.equal(RECLOUD_WORK_ORDER_OPERATION_POLICY.approvalFlow, "内部维修单自动审批（成都欣益）");
  assert.equal(RECLOUD_WORK_ORDER_OPERATION_POLICY.terminalAction, "提交");
});
