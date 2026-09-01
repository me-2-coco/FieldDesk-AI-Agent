const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const AGENT = path.join(ROOT, "agent.py");
const PLAYBOOK = path.join(ROOT, "docs", "ORDER_EXECUTION_PLAYBOOK.md");

test("fast order agent compiles and exposes one bounded complete-order entry", () => {
  const result = spawnSync("python3", ["-m", "py_compile", AGENT], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const source = fs.readFileSync(AGENT, "utf8");
  assert.match(source, /def complete_order_fast\(/);
  assert.match(source, /"complete-order"/);
  assert.match(source, /ORDER_UI_TARGET_SECONDS = 60/);
  assert.match(source, /choose_detection_radio\(page, "是否是排障问题", "否"\)/);
  assert.match(source, /choose_detection_radio\(dialog, "是否与客服登记原因一致", "是"\)/);
  assert.doesNotMatch(source, /click_named\(page, "代客户收件"/);
  assert.match(source, /field\.fill\(part_code\)/);
  assert.doesNotMatch(source, /box\["x"\] \+ box\["width"\] - 22/);
  assert.match(source, /状态=CRM_FINAL_ACTION_READY/);
  assert.doesNotMatch(source.match(/def complete_order_fast\([\s\S]*?return page, elapsed/)[0], /状态=COMPLETED/);
  assert.match(source, /Agent停在最终完工\/提交前/);
  assert.match(source, /安全拦截：Agent 禁止点击 CRM‘完工’按钮/);
});

test("playbook preserves the established order rules without redefining other modules", () => {
  const source = fs.readFileSync(PLAYBOOK, "utf8");
  for (const rule of [
    "同一浏览器会话连续执行",
    "不超过 60 秒",
    "一致时不查询飞书",
    "服务报告",
    "不得进入“备件申请单”",
    "是否是排障问题",
    "责任判定保持空白",
    "点击提交后立即停止",
  ]) assert.match(source, new RegExp(rule));
});
