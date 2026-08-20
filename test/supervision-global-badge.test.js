const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const path = require("path");

test("师傅在任意页面都能从首页导航看到未读督办数量", async () => {
  const app = await fs.readFile(path.join(__dirname, "../frontend/src/App.jsx"), "utf8");
  const nav = await fs.readFile(path.join(__dirname, "../frontend/src/components/BottomNav.jsx"), "utf8");
  assert.match(app, /getSupervisionInbox/);
  assert.match(app, /filter\(\(item\) => !item\.isRead\)/);
  assert.match(app, /supervisionUnreadCount=\{supervisionUnreadCount\}/);
  assert.match(nav, /item\.page === "home"/);
  assert.match(nav, /99\+/);
  assert.doesNotMatch(nav, /回复督办|提交回复/);
});

test("师傅可从任意页面直接打开并查看未读督办", async () => {
  const app = await fs.readFile(path.join(__dirname, "../frontend/src/App.jsx"), "utf8");
  const home = await fs.readFile(path.join(__dirname, "../frontend/src/pages/Home.jsx"), "utf8");
  const inbox = await fs.readFile(path.join(__dirname, "../frontend/src/components/SupervisionInbox.jsx"), "utf8");
  assert.match(app, /global-supervision-alert/);
  assert.match(app, /openSupervisionInbox/);
  assert.match(app, /supervisionOpenKey/);
  assert.match(home, /openKey=\{supervisionOpenKey\}/);
  assert.match(inbox, /scrollIntoView/);
  assert.match(inbox, /viewOrder\(rmaNo, orderItems\)/);
});

test("全局提醒显示最新督办摘要并精确打开对应寄修单", async () => {
  const app = await fs.readFile(path.join(__dirname, "../frontend/src/App.jsx"), "utf8");
  const home = await fs.readFile(path.join(__dirname, "../frontend/src/pages/Home.jsx"), "utf8");
  const inbox = await fs.readFile(path.join(__dirname, "../frontend/src/components/SupervisionInbox.jsx"), "utf8");
  assert.match(app, /latestSupervision/);
  assert.match(app, /originalContent/);
  assert.match(app, /openSupervisionInbox\(latestSupervision\?\.rmaNo\)/);
  assert.match(home, /targetRmaNo=\{supervisionTargetRmaNo\}/);
  assert.match(inbox, /targetRmaNo \? rmaNo === targetRmaNo/);
});

test("督办监测异常时全局提示师傅但不阻断维修", async () => {
  const app = await fs.readFile(path.join(__dirname, "../frontend/src/App.jsx"), "utf8");
  const service = await fs.readFile(path.join(__dirname, "../frontend/src/shared/crmService.js"), "utf8");
  const css = await fs.readFile(path.join(__dirname, "../frontend/src/App.css"), "utf8");
  assert.match(service, /getSupervisionMonitorStatus/);
  assert.match(service, /\/api\/supervision\/monitor\/status/);
  assert.match(app, /RECLOUD_LOGIN_REQUIRED/);
  assert.match(app, /督办监测长时间未成功检查/);
  assert.match(app, /global-monitor-warning/);
  assert.match(css, /\.global-monitor-warning/);
  assert.doesNotMatch(app, /回复督办|提交回复/);
});
