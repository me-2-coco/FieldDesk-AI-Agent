const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeHeader, findHeaderIndex } = require("../connectors/recloud-repair-parts-reader");

test("repair parts headers are matched by exact normalized aliases", () => {
  const headers = [" 产品明细 ", "新件名称", "新件编码\n", "配件数量", "操作"];
  assert.equal(findHeaderIndex(headers, ["新件编码", "配件编码", "物料编码"]), 2);
  assert.equal(findHeaderIndex(headers, ["数量", "配件数量", "更换数量"]), 3);
  assert.equal(normalizeHeader(" 新件 编码\n"), "新件编码");
});

test("repair parts header matcher refuses missing and duplicate aliases", () => {
  assert.equal(findHeaderIndex(["产品明细"], ["新件编码", "配件编码"]), -1);
  assert.equal(findHeaderIndex(["新件编码", "配件编码"], ["新件编码", "配件编码"]), -1);
});
