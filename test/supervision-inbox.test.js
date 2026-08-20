const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const path = require("path");

test("师傅首页汇总本人全部工单督办并保留信息员回复边界", async () => {
  const source = await fs.readFile(path.join(__dirname, "../frontend/src/components/SupervisionInbox.jsx"), "utf8");
  assert.match(source, /getSupervisionInbox/);
  assert.match(source, /寄修单：/);
  assert.match(source, /瑞云督办单仍由信息员统一回复/);
  assert.doesNotMatch(source, /回复督办|修改瑞云状态|提交回复/);
});
