const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeAttachmentName,
  buildRecloudRepairAttachmentsPlan,
} = require("../services/recloud-repair-attachments-plan");

test("repair attachment plan skips exact files and uploads only missing files", () => {
  const plan = buildRecloudRepairAttachmentsPlan([
    { path: "/safe/finish.jpg", size: 200000, mimeType: "image/jpeg" },
    { path: "/safe/video.mp4", size: 24000000, mimeType: "video/mp4" },
  ], [
    { fileName: "finish.jpg", size: 200200, mimeType: "image/jpeg" },
    { fileName: "receipt.jpg", size: 100000, mimeType: "image/jpeg" },
  ]);
  assert.deepEqual(plan.skipped, [{ fileName: "finish.jpg", reason: "ALREADY_MATCHED" }]);
  assert.deepEqual(plan.additions.map((item) => item.fileName), ["video.mp4"]);
  assert.equal(plan.ignoredExistingCount, 1);
  assert.equal(plan.readyToUpload, true);
  assert.equal(plan.mayDeleteExisting, false);
  assert.equal(plan.mayOverwriteExisting, false);
});

test("repair attachment plan stops on same-name size or type conflicts", () => {
  const sizeConflict = buildRecloudRepairAttachmentsPlan(
    [{ name: "finish.jpg", size: 200000, mimeType: "image/jpeg" }],
    [{ name: "finish.jpg", size: 300000, mimeType: "image/jpeg" }]
  );
  assert.equal(sizeConflict.readyToUpload, false);
  assert.equal(sizeConflict.conflicts[0].reason, "SIZE_MISMATCH");

  const typeConflict = buildRecloudRepairAttachmentsPlan(
    [{ name: "finish.jpg", size: 200000, mimeType: "image/jpeg" }],
    [{ name: "finish.jpg", size: 200000, mimeType: "image/png" }]
  );
  assert.equal(typeConflict.conflicts[0].reason, "TYPE_MISMATCH");
});

test("repair attachment plan refuses duplicate names and unknown existing sizes", () => {
  assert.throws(() => buildRecloudRepairAttachmentsPlan([
    { path: "/a/finish.jpg", size: 100 },
    { path: "/b/FINISH.JPG", size: 100 },
  ], []), { code: "RECLOUD_REPAIR_ATTACHMENT_DUPLICATE" });

  const plan = buildRecloudRepairAttachmentsPlan(
    [{ name: "finish.jpg", size: 100 }],
    [{ name: "finish.jpg" }]
  );
  assert.equal(plan.readyToUpload, false);
  assert.equal(plan.conflicts[0].reason, "EXISTING_SIZE_UNKNOWN");
  assert.equal(normalizeAttachmentName("/tmp/Finish.JPG"), "finish.jpg");
});
