const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");

test("sync task opens a local repair order through a sanitized RMA identifier", async () => {
  const app = await fs.readFile(path.join(__dirname, "../frontend/src/App.jsx"), "utf8");
  const tasks = await fs.readFile(path.join(__dirname, "../frontend/src/pages/SyncTasks.jsx"), "utf8");
  assert.match(app, /findRepairOrderByCrmOrderNo/);
  assert.match(app, /setCurrentRepairOrderId\(order\.id\)/);
  assert.match(app, /pageForRepairStatus\(order\.status\)/);
  assert.match(tasks, /onOpenOrder\(task\.rmaNo\)/);
  assert.match(tasks, /打开对应工单/);
  assert.doesNotMatch(tasks, /onOpenOrder\(task\.payload/);
});

test("repair task navigation covers completion shipping and completed statuses", async () => {
  const navigation = await fs.readFile(path.join(__dirname, "../frontend/src/shared/repairNavigation.js"), "utf8");
  assert.match(navigation, /INSPECTION_COMPLETE[\s\S]*repairCompletion/);
  assert.match(navigation, /REPAIR_COMPLETED_PENDING_SHIPMENT[\s\S]*repairCompletion/);
  assert.match(navigation, /COMPLETED[\s\S]*records/);
});
