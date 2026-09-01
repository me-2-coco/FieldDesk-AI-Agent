const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");

test("sync task page auto refreshes and reports safe status transitions", async () => {
  const source = await fs.readFile(path.join(__dirname, "../frontend/src/pages/SyncTasks.jsx"), "utf8");
  assert.match(source, /setInterval\(\(\) => refresh\(\), 5000\)/);
  assert.match(source, /同步状态更新/);
  assert.match(source, /previousStatus === task\.status/);
  assert.match(source, /不会自动点击最终确认/);
  assert.match(source, /window\.clearInterval\(timer\)/);
  assert.doesNotMatch(source, /Notification\.requestPermission|new Notification/);
});
