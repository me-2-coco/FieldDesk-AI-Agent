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

test("检测必须等待签收、项目号和签收附件完成，并在签收恢复后自动继续", async () => {
  const source = await fs.readFile(path.join(__dirname, "../server.js"), "utf8");
  assert.match(source, /const receiptDependenciesReady = Boolean\([\s\S]*recloudReceiptConfirmedAt[\s\S]*recloudProjectVerificationConfirmedAt[\s\S]*recloudReceiptAttachmentConfirmedAt/);
  assert.match(source, /if \(rmaNo && isRecloudReceiptWriteEnabled\(runtimeEnv\) && !receiptDependenciesReady\) \{[\s\S]*scheduleRecloudReceiptSync[\s\S]*return false/);
  assert.match(source, /const syncedOrder = [\s\S]*inspectionUpdatedAt[\s\S]*scheduleRecloudDetectionSync\(syncedOrder, operator\)/);
  assert.match(source, /order\.receiptCompletedAt[\s\S]*!order\.recloudReceiptConfirmedAt[\s\S]*scheduleRecloudReceiptSync\(order, user/);
});
