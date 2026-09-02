const test = require("node:test");
const assert = require("node:assert/strict");
const { parsePartRows, parseSweepPartRows, projectCodesFromTitle, partSupportsProject, retailPrice } = require("../connectors/feishu-parts-catalog");

test("零售价兼容飞书货币符号和千位分隔格式", () => {
  assert.equal(retailPrice("¥1,299.50"), 1299.5);
  assert.equal(retailPrice("￥ 88"), 88);
  assert.equal(retailPrice(""), null);
});

test("零售价列兼容带单位和零售价格别名", () => {
  const withUnit = parseSweepPartRows([
    ["物料编号", "物料名称", "维修等级", "零售价（元）"],
    ["20020100007740", "售后软管下刮条组件", "中修", "¥39.00"],
  ], { title: "H30 Ultra（W2306）", productLine: "洗地机" });
  const alias = parseSweepPartRows([
    ["物料编号", "物料名称", "维修等级", "零售价格"],
    ["20020100007742", "售后刮条弹簧", "小修", 12],
  ], { title: "H30 Ultra（W2306）", productLine: "洗地机" });
  const finalPrice = parseSweepPartRows([
    ["物料编号", "物料名称", "维修等级", "最终零售价"],
    ["20020100007717", "售后喷水器组件", "中修", 17],
  ], { title: "H30 Ultra（W2306）", productLine: "洗地机" });
  assert.equal(withUnit[0].retailPrice, 39);
  assert.equal(alias[0].retailPrice, 12);
  assert.equal(finalPrice[0].retailPrice, 17);
});

test("解析飞书售后配件表并保留收费规则", () => {
  const rows = [
    ["序号", "物料编号", "售后配件名称", "配置", "单位", "零售价", "维修等级", "可否补损", "旧件返厂", "适用机型", "备件图片"],
    [1, "01020300000123", "水泵组件", "", "个", 199, "大修", "否", "是", "W2448/W2448A", ""],
  ];
  assert.deepEqual(parsePartRows(rows), [{
    sourceRow: 2,
    code: "01020300000123",
    name: "水泵组件",
    retailPrice: 199,
    repairLevel: "大修",
    returnRequired: true,
    projectCode: "W2448/W2448A",
    productLine: "洗地机",
  }]);
});

test("配件适用机型按完整项目号匹配", () => {
  const part = { projectCode: "W2448/W2448A，W2501" };
  assert.equal(partSupportsProject(part, "w2448"), true);
  assert.equal(partSupportsProject(part, "W244"), false);
});

test("从扫地机机型工作表标题和表头解析适用配件", () => {
  assert.deepEqual(projectCodesFromTitle("X40&X40Pro（R2426&R2416)"), ["R2426", "R2416"]);
  const rows = [
    ["序号", "物料编号", "备件名称", "配置", "单位", "维修等级", "零售价", "备注"],
    [1, "20020100009112", "售后主控板PCBA", 1, "pcs", "大修", 399, ""],
  ];
  const [part] = parseSweepPartRows(rows, { sheetId: "demo", title: "X40&X40Pro（R2426&R2416)" });
  assert.equal(part.projectCode, "R2426/R2416");
  assert.equal(part.productLine, "扫地机");
  assert.equal(part.repairLevel, "大修");
});

test("从洗地机工作表标题精确提取带后缀和不带后缀的项目号", () => {
  assert.deepEqual(projectCodesFromTitle("T40 Ultra（W2448）"), ["W2448"]);
  assert.deepEqual(projectCodesFromTitle("T40 Pro（W2448Q）"), ["W2448Q"]);
});

test("扫地机通用物料匹配任意扫地机项目号", () => {
  assert.equal(partSupportsProject({ projectCode: "*" }, "R2426"), true);
});

test("洗地机机型页支持物料名称表头和旧件返厂字段", () => {
  const rows = [
    ["序号", "物料编号", "物料名称", "配置", "单位", "维修等级", "备件图片", "零售价", "可否补损", "旧件返厂"],
    [1, "20020100013703", "售后水泵", 1, "个", "中修", "", 29, "否", "是"],
  ];
  const [part] = parseSweepPartRows(rows, { title: "T40 Ultra（W2448）", productLine: "洗地机" });
  assert.equal(part.code, "20020100013703");
  assert.equal(part.retailPrice, 29);
  assert.equal(part.returnRequired, true);
});
