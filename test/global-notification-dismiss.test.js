const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("global operation and sync notices can be dismissed until their content changes", () => {
  const source = fs.readFileSync(path.join(__dirname, "../frontend/src/App.jsx"), "utf8");
  assert.match(source, /aria-label="关闭工单同步异常通知"/);
  assert.match(source, /aria-label="关闭待处理同步任务通知"/);
  assert.match(source, /operationAlertKey !== dismissedOperationAlertKey/);
  assert.match(source, /syncAlertKey !== dismissedSyncAlertKey/);
  assert.match(source, /sessionStorage\.setItem\(`fielddesk-dismissed-\$\{type\}-alert:/);
});
