const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const path = require("path");

test("admin recovery is wired through an admin-only page and API", async () => {
  const root = path.join(__dirname, "..");
  const [server, app, home, users, api, page] = await Promise.all([
    fs.readFile(path.join(root, "server.js"), "utf8"),
    fs.readFile(path.join(root, "frontend/src/App.jsx"), "utf8"),
    fs.readFile(path.join(root, "frontend/src/pages/Home.jsx"), "utf8"),
    fs.readFile(path.join(root, "frontend/src/shared/userStore.js"), "utf8"),
    fs.readFile(path.join(root, "frontend/src/shared/crmService.js"), "utf8"),
    fs.readFile(path.join(root, "frontend/src/pages/AdminRepairRecovery.jsx"), "utf8"),
  ]);

  assert.match(server, /\/api\/repairs\/admin\/reopen-treatment/);
  assert.match(server, /user\.role !== USER_ROLES\.ADMIN/);
  assert.match(server, /cancelOrderNodes/);
  assert.match(app, /page === "adminRepairRecovery"/);
  assert.match(home, /title: "工单恢复"/);
  assert.match(users, /"adminRepairRecovery"/);
  assert.match(users, /String\(user\?\.role \|\| ""\)\.trim\(\)\.toLowerCase\(\)/);
  assert.match(api, /reopenRepairTreatment/);
  assert.match(page, /恢复到选择处理方式/);
  assert.match(page, /原维修师傅/);
  assert.match(page, /window\.confirm/);
});
