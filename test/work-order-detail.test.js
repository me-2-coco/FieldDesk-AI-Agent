const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");

test("management detail distinguishes operation position and terminal state", async () => {
  const { workOrderStage, workOrderHolder } = await import("../frontend/src/shared/workOrderDetail.js");
  assert.equal(workOrderStage({ status: "INSPECTION_IN_PROGRESS", resumeStep: "partsApplication" }), "申请配件");
  assert.equal(workOrderStage({ status: "ON_HOLD", resumeStep: "partsApplication" }), "暂存");
  assert.equal(workOrderStage({ status: "COMPLETED", resumeStep: "repairCompletion" }), "已完结");
  assert.equal(workOrderHolder({ technicianName: "测试师傅", operatorName: "签收员" }), "测试师傅");
  assert.equal(workOrderHolder({ operatorName: "签收员" }), "签收员");
  assert.notEqual(workOrderHolder({ status: "COMPLETED", technicianName: "测试师傅" }), "测试师傅");
});

test("readonly detail contains no workflow mutation or repair form", async () => {
  const source = await fs.readFile(path.join(__dirname, "../frontend/src/components/WorkOrderDetail.jsx"), "utf8");
  assert.match(source, /机器在谁手上/);
  assert.match(source, /当前进度/);
  assert.doesNotMatch(source, /saveCurrentRepairOrder|updateRepairOrder|crmService|setPage\(/);
});
