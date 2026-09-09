const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("notifications use a collapsible panel and a short deduplicated hint", () => {
  const source = fs.readFileSync(path.join(__dirname, "../frontend/src/App.jsx"), "utf8");
  const panel = fs.readFileSync(path.join(__dirname, "../frontend/src/components/NotificationCenter.jsx"), "utf8");
  assert.match(source, /<NotificationCenter/);
  assert.doesNotMatch(source, /className="global-operation-alert|className="global-supervision-alert/);
  assert.match(panel, /3000/);
  assert.match(panel, /seen\.current\.has/);
  assert.match(panel, /收起提示不会清除待处理事项/);
  assert.match(panel, /grouped\.get\(key\)/);
});
