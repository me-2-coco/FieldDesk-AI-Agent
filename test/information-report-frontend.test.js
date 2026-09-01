const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");

test("information clerk has a read-only full report with browser-managed individual downloads", async () => {
  const page = await fs.readFile(path.join(__dirname, "../frontend/src/pages/InformationRepairReports.jsx"), "utf8");
  const users = await fs.readFile(path.join(__dirname, "../frontend/src/shared/userStore.js"), "utf8");
  assert.match(page, /信息员只读查看本地维修报告，不能修改/);
  assert.match(page, /查看完整报告/);
  assert.match(page, /更换配件/);
  assert.match(page, /一键逐个下载全部/);
  assert.match(page, /正在逐个下载/);
  assert.match(page, /失败.*可使用对应文件旁的“单个下载”补下/);
  assert.match(page, /保存位置由电脑浏览器的下载设置决定/);
  assert.match(page, /单个下载/);
  assert.match(page, /预览/);
  assert.match(page, /<video[\s\S]*controls/);
  assert.match(page, /<img[\s\S]*preview\.url/);
  assert.doesNotMatch(page, /ZIP|\.zip/);
  assert.doesNotMatch(page, /saveAdminUser|submitRepairCompletion|updateRepairPart|删除/);
  const infoBlock = users.slice(users.indexOf("information_clerk: ["), users.indexOf("admin: [", users.indexOf("information_clerk: [")));
  assert.match(infoBlock, /repairReports/);
});
