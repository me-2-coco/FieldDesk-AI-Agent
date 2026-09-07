const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeCell, parseInventoryRow } = require("../connectors/recloud-parts-inventory");

test("瑞云备件库存按表头解析真实库存字段", () => {
  const headers = ["", "仓库名称", "仓库编码", "配件名称", "配件编码", "数量", "单位", "创建时间", "产品线"];
  const cells = ["", "成都欣益胜电器有限公司", "11005055", "边刷", "20010100001007", "7", "EA", "2026-04-24 18:39:53", "扫地机"];
  assert.deepEqual(parseInventoryRow(headers, cells), {
    warehouseName: "成都欣益胜电器有限公司",
    warehouseCode: "11005055",
    partName: "边刷",
    partCode: "20010100001007",
    quantity: 7,
    unit: "EA",
    createdAt: "2026-04-24 18:39:53",
    productLine: "扫地机",
  });
});

test("瑞云库存单元格会清理换行并保留零库存", () => {
  assert.equal(normalizeCell("  成都\n欣益胜  "), "成都 欣益胜");
  assert.equal(parseInventoryRow(["配件编码", "数量"], ["20010100000426", "0"]).quantity, 0);
});
