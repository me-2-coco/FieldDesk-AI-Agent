const test = require("node:test");
const assert = require("node:assert/strict");
const { executeRecloudRepairAttachmentUpload } = require("../services/recloud-repair-attachment-uploader");

const FILES = [
  { fileName: "finish.jpg", size: 200000, mimeType: "image/jpeg", path: "/safe/finish.jpg" },
  { fileName: "finish.mp4", size: 20000000, mimeType: "video/mp4", path: "/safe/finish.mp4" },
];

function uploadAdapter(overrides = {}) {
  let staged = [];
  let existing = [];
  let uploadCalls = 0;
  return {
    get uploadCalls() { return uploadCalls; },
    async supportsMultiple() { return true; },
    async stage(files) { staged = files.map(({ fileName, size, mimeType }) => ({ fileName, size, mimeType })); },
    async readStaged() { return staged; },
    async upload() { uploadCalls += 1; existing = [...staged]; },
    async readExisting() { return existing; },
    ...overrides,
  };
}

const PLAN = { additions: FILES, skipped: [], conflicts: [], readyToUpload: true };

test("repair attachment uploader verifies the full queue and CRM list exactly once", async () => {
  const adapter = uploadAdapter();
  const result = await executeRecloudRepairAttachmentUpload(PLAN, adapter, { writeEnabled: true });
  assert.equal(adapter.uploadCalls, 1);
  assert.equal(result.uploadedCount, 2);
  assert.equal(result.uploadVerified, true);
  assert.equal(result.autoRetryAttempted, false);
  assert.equal(result.finalConfirmClicked, false);
});

test("repair attachment uploader is blocked unless the write switch is explicit", async () => {
  const adapter = uploadAdapter();
  await assert.rejects(executeRecloudRepairAttachmentUpload(PLAN, adapter, { writeEnabled: false }), {
    code: "RECLOUD_REPAIR_ATTACHMENT_UPLOAD_DISABLED", phase: "PLAN",
  });
  assert.equal(adapter.uploadCalls, 0);
});

test("repair attachment uploader refuses partial staging and single-select windows", async () => {
  const partial = uploadAdapter({
    async readStaged() { return [FILES[0]]; },
  });
  await assert.rejects(executeRecloudRepairAttachmentUpload(PLAN, partial, { writeEnabled: true }), {
    code: "RECLOUD_REPAIR_ATTACHMENT_STAGE_MISMATCH", phase: "STAGE",
  });
  assert.equal(partial.uploadCalls, 0);

  const single = uploadAdapter({ async supportsMultiple() { return false; } });
  await assert.rejects(executeRecloudRepairAttachmentUpload(PLAN, single, { writeEnabled: true }), {
    code: "RECLOUD_REPAIR_ATTACHMENT_MULTISELECT_REQUIRED", phase: "STAGE",
  });
  assert.equal(single.uploadCalls, 0);
});

test("unknown upload result is never retried automatically", async () => {
  let calls = 0;
  const adapter = uploadAdapter({
    async upload() { calls += 1; throw new Error("timeout"); },
  });
  await assert.rejects(executeRecloudRepairAttachmentUpload(PLAN, adapter, { writeEnabled: true }), {
    code: "RECLOUD_REPAIR_ATTACHMENT_UPLOAD_UNCERTAIN", phase: "UPLOAD",
  });
  assert.equal(calls, 1);
});

test("uploader requires every new file to appear in Recloud after upload", async () => {
  const adapter = uploadAdapter({
    async readExisting() { return [FILES[0]]; },
  });
  await assert.rejects(executeRecloudRepairAttachmentUpload(PLAN, adapter, { writeEnabled: true }), {
    code: "RECLOUD_REPAIR_ATTACHMENT_POSTVERIFY_FAILED", phase: "POSTVERIFY",
  });
});
