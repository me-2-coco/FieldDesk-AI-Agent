const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");

test("technical synchronization details are limited to administrators and owner", async () => {
  const { canViewRecloudSyncDetails } = await import("../frontend/src/shared/accountAccessPolicy.js");
  for (const role of ["technician", "information_clerk", "warehouse", ""]) {
    assert.equal(canViewRecloudSyncDetails({ userId: "SYNTHETIC", role }), false);
  }
  assert.equal(canViewRecloudSyncDetails({ userId: "FieldDesk0004", role: "technician" }), false);
  assert.equal(canViewRecloudSyncDetails({ role: "admin" }), true);
  assert.equal(canViewRecloudSyncDetails({ userId: "FieldDesk0001" }), true);
  assert.equal(canViewRecloudSyncDetails(), false);
});

test("completion sync panel uses role gate without removing business content", async () => {
  const source = await fs.readFile(path.join(__dirname, "../frontend/src/pages/RepairCompletion.jsx"), "utf8");
  assert.match(source, /showSyncDetails && syncStatus &&/);
  assert.match(source, /<SupervisionNoticeCard/);
  assert.match(source, /completion-order-card/);
});
