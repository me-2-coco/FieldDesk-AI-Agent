const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

async function generator() {
  return import(pathToFileURL(path.join(__dirname, "../frontend/src/shared/repairMeasure.js")));
}

test("维修措施按已完工瑞云样本生成并去掉售后前缀", async () => {
  const { buildRepairMeasure } = await generator();
  const result = buildRepairMeasure(
    "机器无法使用，客诉故障复现，检测不良，更换，清理，测试OK寄回",
    [{ partName: "售后电机" }, { partName: "售后主PCB盖板" }],
    "机器异响#"
  );
  assert.equal(result, "机器异响# 客诉故障复现，检测电机，主PCB盖板不良，更换电机，主PCB盖板，清理，测试ok寄回");
});

test("故障未复现不编造更换配件", async () => {
  const { buildRepairMeasure } = await generator();
  assert.equal(
    buildRepairMeasure("机器正常使用，客诉故障未复现，清理，测试OK寄回", [], "不出水"),
    "机器正常使用，客诉故障未复现，清理，测试ok寄回"
  );
});

test("客户弃修不写更换动作", async () => {
  const { buildRepairMeasure } = await generator();
  assert.equal(
    buildRepairMeasure("机器无法使用，客诉故障复现，检测主电机不良，客户弃修，清理，寄回", [{ partName: "主电机" }], "无法启动"),
    "客诉故障复现，检测主电机不良，客户弃修，清理，寄回"
  );
});

test("只检测不维修使用保内检测话术", async () => {
  const { buildRepairMeasure } = await generator();
  assert.equal(
    buildRepairMeasure("只检测不维修，清理，寄回", [], "不吸水", "主电机"),
    "客诉故障复现，检测主电机不良，客户机无法使用，只检测不维修，清理，寄回"
  );
});
