const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

async function generator() {
  return import(pathToFileURL(path.join(__dirname, "../frontend/src/shared/repairMeasure.js")));
}

test("维修措施按已完工瑞云样本生成并保留正式配件名称", async () => {
  const { buildRepairMeasure } = await generator();
  const result = buildRepairMeasure(
    "机器无法使用，客诉故障复现，检测不良，更换，清理，测试OK寄回",
    [{ partName: "售后电机" }, { partName: "售后主PCB盖板" }],
    "机器异响#"
  );
  assert.equal(result, "机器异响# 客诉故障复现，检测售后电机、售后主PCB盖板不良，更换售后电机、售后主PCB盖板，清理，测试ok寄回");
});

test("维修措施使用本次真实做单确认的多配件固定话术", async () => {
  const { buildRepairMeasure } = await generator();
  assert.equal(
    buildRepairMeasure(
      "机器无法使用，客诉故障复现，检测不良，更换，清理，测试OK寄回",
      [
        { partName: "售后水泵ATK-21.6-A2.46P-FT" },
        { partName: "售后硬滚轴承盖（嵌件）" },
        { partName: "售后滚刷悬臂装饰片" },
      ],
      "机器不出水，污水箱上不了污水#"
    ),
    "机器不出水，污水箱上不了污水# 客诉故障复现，检测售后水泵ATK-21.6-A2.46P-FT、售后硬滚轴承盖（嵌件）、售后滚刷悬臂装饰片不良，更换售后水泵ATK-21.6-A2.46P-FT、售后硬滚轴承盖（嵌件）、售后滚刷悬臂装饰片，清理，测试ok寄回"
  );
});

test("故障未复现不编造更换配件", async () => {
  const { buildRepairMeasure } = await generator();
  assert.equal(
    buildRepairMeasure("机器正常使用，客诉故障未复现，清理，测试OK寄回", [], "不出水"),
    "不出水# 机器正常使用，客诉故障未复现，清理，测试ok寄回"
  );
});

test("客户弃修不写更换动作", async () => {
  const { buildRepairMeasure } = await generator();
  assert.equal(
    buildRepairMeasure("机器无法使用，客诉故障复现，检测主电机不良，客户弃修，清理，寄回", [{ partName: "主电机" }], "无法启动"),
    "无法启动# 客诉故障复现，检测主电机不良，客户弃修，清理，寄回"
  );
});

test("只检测不维修使用保内检测话术", async () => {
  const { buildRepairMeasure } = await generator();
  assert.equal(
    buildRepairMeasure("只检测不维修，清理，寄回", [], "不吸水", "主电机"),
    "不吸水# 客诉故障复现，检测主电机不良，客户机无法使用，只检测不维修，清理，寄回"
  );
});
