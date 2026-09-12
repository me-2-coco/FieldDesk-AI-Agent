const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { JsonRecloudRepairCheckpointStore, safeCheckpoint } = require("../database/recloud-repair-checkpoint-store");

test("repair checkpoints persist only resumable state and safe step names", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fielddesk-repair-checkpoint-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "checkpoints.json");
  const store = new JsonRecloudRepairCheckpointStore(file);
  await store.save({
    orderKey: "JXTH900001234",
    fingerprint: "a".repeat(64),
    status: "WAITING_SUBMIT_READY",
    completedSteps: ["PARTS_VERIFIED", "COMPLETE_CLICKED", "UNSAFE_STEP"],
    reviewReasons: [{ step: "PARTS", reason: "do not persist details" }],
    payload: { phone: "13900000000" },
  });
  const restored = await new JsonRecloudRepairCheckpointStore(file).load("JXTH900001234");
  assert.deepEqual(restored.completedSteps, ["PARTS_VERIFIED", "COMPLETE_CLICKED"]);
  assert.deepEqual(restored.reviewSteps, ["PARTS"]);
  assert.equal(restored.payload, undefined);
  assert.doesNotMatch(await fs.readFile(file, "utf8"), /13900000000/);
});

test("repair checkpoint rejects an empty or oversized order key", () => {
  assert.throws(() => safeCheckpoint({ orderKey: "" }), { code: "RECLOUD_REPAIR_CHECKPOINT_ORDER_INVALID" });
  assert.throws(() => safeCheckpoint({ orderKey: "X".repeat(81) }), { code: "RECLOUD_REPAIR_CHECKPOINT_ORDER_INVALID" });
});
test('uncertain attachment and submit markers survive actual disk reload', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fd-checkpoint-marker-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'checkpoint.json');
  const name = `fd-m-${'b'.repeat(64)}.mp4`;
  for (const status of ['ATTACHMENTS_UPLOADING', 'SUBMITTING']) {
    await new JsonRecloudRepairCheckpointStore(file).save({ orderKey: 'LAB', fingerprint: 'a'.repeat(64), status, attachmentManifest: [name, '/private/secret'] });
    const saved = await new JsonRecloudRepairCheckpointStore(file).load('LAB');
    assert.equal(saved.status, status);
    assert.deepEqual(saved.attachmentManifest, [name]);
  }
});
