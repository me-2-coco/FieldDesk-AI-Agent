const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");

test("repair page requests and displays only a safe per-order sync summary", async () => {
  const server = await fs.readFile(path.join(__dirname, "../server.js"), "utf8");
  const page = await fs.readFile(path.join(__dirname, "../frontend/src/pages/RepairCompletion.jsx"), "utf8");
  const service = await fs.readFile(path.join(__dirname, "../frontend/src/shared/crmService.js"), "utf8");
  assert.match(server, /\/api\/recloud-sync\/order-status/);
  assert.match(server, /isAssignedTechnician/);
  assert.match(server, /completedSteps:[\s\S]*reviewSteps:[\s\S]*updatedAt:/);
  const endpoint = server.match(/app\.get\("\/api\/recloud-sync\/order-status"[\s\S]*?\n  \}\);/)?.[0] || "";
  assert.doesNotMatch(endpoint, /payload:/);
  assert.match(service, /encodeURIComponent\(String\(rmaNo/);
  assert.match(page, /瑞云同步状态/);
  assert.match(page, /已点击完工，正在等待瑞云进入可提交状态/);
  assert.match(page, /系统会在瑞云状态变化后自动提交/);
});
