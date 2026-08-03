const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const path = require("path");

const root = path.join(__dirname, "..");
async function source(file) { return fs.readFile(path.join(root, file), "utf8"); }

test("all seven local workflow pages are routed and reachable from status-aware actions", async () => {
  const app = await source("frontend/src/App.jsx");
  for (const page of ["repair", "repairProcess", "partsApplication", "repairCompletion", "returnShipping"]) assert.match(app, new RegExp(`page === "${page}"`));
  const home = await source("frontend/src/pages/Home.jsx");
  for (const action of ["到店查询与签收准备", "继续当前工单", "查看个人库存与配件流水", "待发货与待完结工单"]) assert.match(home, new RegExp(action));
  assert.match(home, /WAIT_INSPECTION[\s\S]*repairProcess/);
  assert.match(home, /INSPECTION_COMPLETE[\s\S]*partsApplication/);
  assert.match(home, /REPAIR_COMPLETED_PENDING_SHIPMENT[\s\S]*returnShipping/);
});

test("inspection, parts, inventory, completion and shipping expose the next local step", async () => {
  const inspection = await source("frontend/src/pages/RepairProcess.jsx");
  assert.match(inspection, /申请配件/); assert.match(inspection, /进入维修完工/);
  const parts = await source("frontend/src/pages/PartsApplication.jsx");
  assert.match(parts, /REPAIR_STATUS\.WAIT_PARTS/); assert.match(parts, /进入个人库存使用配件/);
  const inventory = await source("frontend/src/pages/Inventory.jsx");
  assert.match(inventory, /REPAIR_STATUS\.REPAIRING/); assert.match(inventory, /进入维修完工/);
  const completion = await source("frontend/src/pages/RepairCompletion.jsx");
  assert.match(completion, /进入返件发货/);
  const shipping = await source("frontend/src/pages/ReturnShipping.jsx");
  assert.match(shipping, /管理员确认完结/); assert.match(shipping, /未提供/);
});

test("five account profiles and role page boundaries are present", async () => {
  const users = await source("frontend/src/shared/userStore.js");
  for (const account of ["zhang", "li", "zhao", "wang", "admin"]) assert.match(users, new RegExp(`account: "${account}"`));
  assert.match(users, /account: "li"[\s\S]*repairSpecialties: \["洗地机"\]/);
  assert.match(users, /account: "zhao"[\s\S]*repairSpecialties: \["扫地机", "洗地机"\]/);
  const warehouseBlock = users.slice(users.indexOf("warehouse: ["), users.indexOf("admin: ["));
  assert.doesNotMatch(warehouseBlock, /repairProcess|partsApplication|repairCompletion/);
  assert.match(warehouseBlock, /inventory/); assert.match(warehouseBlock, /returnShipping/);
});

test("acceptance checklist preserves dry-run and covers every business node", async () => {
  const checklist = await source("docs/PRE_DEPLOYMENT_ACCEPTANCE.md");
  for (const node of ["到店查询", "签收准备", "检测登记", "配件申请", "维修完工", "返件发货", "管理员完结"]) assert.match(checklist, new RegExp(node));
  assert.match(checklist, /DRY_RUN=true/);
  assert.match(checklist, /不写瑞云/);
});
