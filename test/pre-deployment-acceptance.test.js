const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const path = require("path");

const root = path.join(__dirname, "..");
async function source(file) { return fs.readFile(path.join(root, file), "utf8"); }

test("local workflow pages are routed and reachable from status-aware actions", async () => {
  const app = await source("frontend/src/App.jsx");
  for (const page of ["repair", "repairProcess", "partsApplication", "repairCompletion", "returnShipping"]) assert.match(app, new RegExp(`page === "${page}"`));
  const home = await source("frontend/src/pages/Home.jsx");
  const navigation = await source("frontend/src/shared/repairNavigation.js");
  for (const action of ["未完成维修", "待料", "维修已完成", "继续当前工单", "后台发货进度"]) assert.match(home, new RegExp(action));
  assert.match(home, /pageForRepairStatus/);
  assert.match(navigation, /WAIT_INSPECTION[\s\S]*partsApplication/);
  assert.match(navigation, /INSPECTION_COMPLETE[\s\S]*repairCompletion/);
  assert.match(navigation, /WAIT_PARTS[\s\S]*inventory/);
  assert.match(navigation, /REPAIRING[\s\S]*repairWork/);
  assert.match(navigation, /WAIT_CONFIRM[\s\S]*repairProcess/);
  assert.match(navigation, /REPAIR_COMPLETED_PENDING_SHIPMENT[\s\S]*repairCompletion/);
});

test("inspection parts and completion expose the current technician flow while shipping is read only", async () => {
  const inspection = await source("frontend/src/pages/RepairProcess.jsx");
  assert.match(inspection, /进入维修完工确认/);
  const parts = await source("frontend/src/pages/PartsApplication.jsx");
  assert.match(parts, /REPAIR_STATUS\.WAIT_PARTS/); assert.match(parts, /进入维修完工/);
  const repairWork = await source("frontend/src/pages/RepairWork.jsx");
  assert.doesNotMatch(repairWork, /实际维修记录/); assert.match(repairWork, /setPage\("repairProcess"\)/);
  const completion = await source("frontend/src/pages/RepairCompletion.jsx");
  assert.match(completion, /提交完工/); assert.match(completion, /if \(submit\) setPage\("home"\)/); assert.doesNotMatch(completion, /进入返件发货/);
  const shipping = await source("frontend/src/pages/ReturnShipping.jsx");
  assert.match(shipping, /仅供信息员和管理员查询/); assert.match(shipping, /未提供/);
});

test("six account profiles and role page boundaries are present", async () => {
  const users = await source("frontend/src/shared/userStore.js");
  for (const account of ["zhang", "li", "zhao", "wang", "info", "admin"]) assert.match(users, new RegExp(`account: "${account}"`));
  assert.match(users, /account: "li"[\s\S]*repairSpecialties: \["洗地机"\]/);
  assert.match(users, /account: "zhao"[\s\S]*repairSpecialties: \["扫地机", "洗地机"\]/);
  const warehouseBlock = users.slice(users.indexOf("warehouse: ["), users.indexOf("admin: ["));
  assert.doesNotMatch(warehouseBlock, /repairProcess|partsApplication|repairCompletion/);
  assert.match(warehouseBlock, /inventory/); assert.match(warehouseBlock, /returnShipping/);
  const informationClerkBlock = users.slice(users.indexOf("information_clerk: ["), users.indexOf("admin: [", users.indexOf("information_clerk: [")));
  assert.match(informationClerkBlock, /records/); assert.match(informationClerkBlock, /machineTracking/);
  assert.doesNotMatch(informationClerkBlock, /repairProcess|partsApplication|repairCompletion/);
});

test("acceptance checklist preserves dry-run and covers every business node", async () => {
  const checklist = await source("docs/PRE_DEPLOYMENT_ACCEPTANCE.md");
  for (const node of ["到店查询", "签收准备", "检测登记", "配件申请", "维修完工", "返件发货", "管理员完结"]) assert.match(checklist, new RegExp(node));
  assert.match(checklist, /DRY_RUN=true/);
  assert.match(checklist, /不写瑞云/);
});
