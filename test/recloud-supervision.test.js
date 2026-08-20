const test = require("node:test");
const assert = require("node:assert/strict");
const { parseSupervisionRows } = require("../connectors/recloud-supervision");

test("按瑞云真实督办单表头提取通知所需字段", () => {
  const result = parseSupervisionRows(
    ["督办单号", "关联寄修单", "督办类型", "督办子类", "客服备注", "处理状态", "创建时间", "客户", "联系电话"],
    [["DB-SYNTHETIC-001", "JXTH-SYNTHETIC-001", "用户诉求", "催维修", "客户希望尽快处理并联系", "待处理", "2026-08-20 10:00", "匿名客户", "13800000000"]]
  );
  assert.deepEqual(result, [{
    sourceId: "DB-SYNTHETIC-001",
    rmaNo: "JXTH-SYNTHETIC-001",
    type: "用户诉求",
    subtype: "催维修",
    content: "客户希望尽快处理并联系",
    status: "待处理",
    createdAt: "2026-08-20 10:00",
  }]);
});

test("空行和无督办标识的布局行不会进入结果", () => {
  assert.deepEqual(parseSupervisionRows(["督办单号", "客服备注"], [["", ""], ["", "   "]]), []);
});
