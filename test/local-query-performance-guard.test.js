const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");

test("local history machine and sync queries fail fast instead of waiting on Recloud", async () => {
  const source = await fs.readFile(path.join(__dirname, "../frontend/src/shared/crmService.js"), "utf8");
  assert.match(source, /getRecloudSyncTasks[\s\S]*timeoutMs: 3000/);
  assert.match(source, /getRepairHistoryByPhone[\s\S]*timeoutMs: 3000/);
  assert.match(source, /getMachinesInHand[\s\S]*timeoutMs: 3000/);
  assert.match(source, /controller\.abort\(\)/);
  assert.match(source, /本地查询超过3秒/);
});
