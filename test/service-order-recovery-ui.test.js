const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("service-order recovery requires explicit confirmation for the checked order", () => {
  const source = fs.readFileSync(path.join(__dirname, "../frontend/src/pages/SyncTasks.jsx"), "utf8");
  assert.match(source, /recloudServiceOrderSyncStatus === "RESULT_UNKNOWN"/);
  assert.match(source, /!confirmedEmpty \|\| recoveryBusy \|\| creationStatus\?\.rmaNo !== keyword.trim\(\).toUpperCase\(\)/);
  assert.match(source, /onChange=\{\(event\) => \{ setKeyword[\s\S]*?setCreationStatus\(null\); setConfirmedEmpty\(false\)/);
  assert.match(source, /reconcileServiceOrderNotCreated\(creationStatus.rmaNo\)/);
});

test("recovery uses the authenticated API and keeps the server administrator guard", () => {
  const client = fs.readFileSync(path.join(__dirname, "../frontend/src/shared/crmService.js"), "utf8");
  const server = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
  assert.match(client, /request\("\/api\/admin\/recloud\/service-order\/reconcile-not-created", \{\s*rmaNo, confirmedNotCreated: true/);
  const route = server.slice(server.indexOf('app.post("/api/admin/recloud/service-order/reconcile-not-created"'));
  assert.match(route, /hasBusinessRole\(user, USER_ROLES.ADMIN\)/);
  assert.match(route, /confirmedNotCreated !== true/);
});
