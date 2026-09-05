const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");

test("administrator receives safe global alerts for actionable sync states", async () => {
  const app = await fs.readFile(path.join(__dirname, "../frontend/src/App.jsx"), "utf8");
  assert.match(app, /getRecloudSyncTasks/);
  assert.match(app, /FAILED", "MANUAL_REVIEW", "READY_DRY_RUN", "AWAITING_FINAL_CONFIRM/);
  assert.match(app, /hasBusinessRole\(currentUser, USER_ROLES\.ADMIN\)/);
  assert.match(app, /window\.setTimeout\(refreshSyncAttention, 10000\)/);
  assert.match(app, /setPage\("syncTasks"\)/);
  assert.doesNotMatch(app, /syncAttentionTasks\[0\]\?\.(?:payload|lastError|sn|logisticsNo)/);
});
