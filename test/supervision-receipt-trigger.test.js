const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const path = require("path");

test("本地签收成功后立即触发督办重新匹配且不阻塞签收响应", async () => {
  const source = await fs.readFile(path.join(__dirname, "../server.js"), "utf8");
  const route = source.slice(
    source.indexOf('app.post("/api/repairs/complete-local-receipt"'),
    source.indexOf('app.post("/api/repairs/inspection/warranty-check"')
  );
  assert.match(route, /await receiptStore\.completeReceipt/);
  assert.match(route, /void supervisionMonitor\?\.pollNow\?\.\(\)/);
  assert.doesNotMatch(route, /await supervisionMonitor\?\.pollNow/);
});
