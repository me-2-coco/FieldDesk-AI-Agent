const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");

test("information exception center is read-only searchable and refreshes automatically", async () => {
  const page = await fs.readFile(path.join(__dirname, "../frontend/src/pages/InformationExceptionCenter.jsx"), "utf8");
  const users = await fs.readFile(path.join(__dirname, "../frontend/src/shared/userStore.js"), "utf8");
  assert.match(page, /问题工单/);
  assert.match(page, /本页只读汇总/);
  assert.match(page, /setInterval\(refresh, 30000\)/);
  assert.match(page, /查看完整报告和附件/);
  assert.match(page, /信息员不能修改或重试同步/);
  assert.match(page, /item\.type !== "SYNC_ATTENTION_REQUIRED"/);
  assert.match(page, /严重程度/);
  assert.doesNotMatch(page, /method:\s*["'](?:POST|PUT|PATCH|DELETE)|保存|修改工单|删除/);
  const infoBlock = users.slice(users.indexOf("information_clerk: ["), users.indexOf("admin: [", users.indexOf("information_clerk: [")));
  assert.match(infoBlock, /exceptionCenter/);
});
