const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { fork } = require("node:child_process");
const { once } = require("node:events");
const { JsonReceiptPreparationStore } = require("../database/receipt-preparation-store");
const { shouldAutoResumeDetection } = require("../server");

test("killed process leaves a durable detection intent that prevents resubmission", { timeout: 10000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fielddesk-detection-crash-"));
  const file = path.join(dir, "records.json");
  const child = fork(path.join(__dirname, "fixtures/detection-crash-worker.cjs"), [file], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await fs.rm(dir, { recursive: true, force: true }); });
  const exited = once(child, "exit");
  const ready = await Promise.race([once(child, "message"), exited.then(() => { throw new Error("child exited before checkpoint"); })]);
  assert.equal(ready[0], "intent-saved");
  child.kill("SIGKILL");
  await exited;
  const reopened = new JsonReceiptPreparationStore(file);
  const [order] = await reopened.readAll();
  assert.ok(order.recloudDetectionSubmissionStartedAt);
  assert.equal(shouldAutoResumeDetection({ ...order, status: "INSPECTION_COMPLETED_PENDING_REPAIR", inspectionUpdatedAt: "2000-01-01" }), false);
  await assert.rejects(reopened.markRecloudDetectionSyncing(order.rmaNo), { code: "RECLOUD_DETECTION_RECONCILIATION_REQUIRED" });
  await reopened.markRecloudDetectionConfirmed(order.rmaNo);
  assert.equal((await reopened.readAll())[0].recloudDetectionSubmissionStartedAt, "");
});
