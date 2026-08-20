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
