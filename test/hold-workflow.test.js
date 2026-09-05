const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const { JsonReceiptPreparationStore } = require("../database/receipt-preparation-store");
const { queryMachinesInHand } = require("../services/repair-history-query");
const { RECLOUD_HOLD_REASON_GROUPS, validateHoldInput } = require("../shared/recloud-hold-reasons");
const { createApp } = require("../server");

const TECHNICIAN = { userId: "TECH-HOLD", displayName: "测试师傅", role: "TECHNICIAN" };

test("Recloud hold reasons are validated from the local mirror", () => {
  assert.ok(RECLOUD_HOLD_REASON_GROUPS.find((group) => group.category === "保内")?.reasons.includes("网点缺件"));
  assert.ok(RECLOUD_HOLD_REASON_GROUPS.find((group) => group.category === "保外")?.reasons.includes("不认可费用，沟通中"));
  assert.deepEqual(validateHoldInput({ category: "保内", reason: "网点缺件", remark: "配件预计明天到货" }), {
    category: "保内",
    reason: "网点缺件",
    remark: "配件预计明天到货",
  });
  assert.throws(() => validateHoldInput({ category: "保内", reason: "网点缺件", remark: "" }), /请填写暂存备注/);
  assert.throws(() => validateHoldInput({ category: "保内", reason: "前端伪造原因", remark: "备注" }), /有效的瑞云滞处理原因/);
});

test("a held order records reason, remark, holder, progress and Recloud sync result", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fielddesk-hold-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new JsonReceiptPreparationStore(path.join(directory, "orders.json"));
  const order = await store.prepare({
    logisticsNo: "SF-HOLD-1", rmaNo: "JXTH-HOLD-1", sn: "W-HOLD-SN-1",
    specialty: "扫地机", productLine: "扫地机", operatorId: TECHNICIAN.userId,
    operatorName: TECHNICIAN.displayName,
  });
  await store.markModelAuthorization(order.rmaNo, { repairability: "SUPPORTED", status: "MATCHED", localWorkflowAllowed: true }, TECHNICIAN);
  await store.addReceiptAttachment(order.rmaNo, { id: "PHOTO-1", name: "receipt.jpg", mimeType: "image/jpeg" }, TECHNICIAN);
  await store.completeReceipt(order.rmaNo, TECHNICIAN);
  await store.saveWarrantyDecision(order.rmaNo, { technicianWarranty: "保外" }, TECHNICIAN);
  const held = await store.saveTreatmentDecision(order.rmaNo, {
    treatmentMode: "ON_HOLD",
    technicianWarranty: "保外",
    holdCategory: "保外",
    holdReason: "用户要求暂放",
    holdRemark: "用户考虑是否继续维修",
  }, TECHNICIAN);

  assert.equal(held.status, "ON_HOLD");
  assert.equal(held.resumeStep, "");
  assert.equal(held.hold.status, "PENDING");
  assert.equal(held.hold.category, "保外");
  assert.equal(held.hold.reason, "用户要求暂放");
  assert.match(held.timeline.at(-1).label, /用户要求暂放/);

  const tracked = queryMachinesInHand(await store.readAll(), "");
  assert.equal(tracked.length, 1);
  assert.equal(tracked[0].currentHolder, TECHNICIAN.displayName);
  assert.equal(tracked[0].currentStage, "暂存 · 用户要求暂放");
  assert.equal(tracked[0].recentTimeline[0].type, "ORDER_HOLD_REQUESTED");

  const confirmed = await store.markRecloudHoldConfirmed(order.rmaNo, { confirmed: true }, TECHNICIAN);
  assert.equal(confirmed.hold.status, "CONFIRMED");
  assert.equal(confirmed.timeline.at(-1).type, "RECLOUD_HOLD_CONFIRMED");
});

test("only ordinary technicians are workflow-restricted while owner admin and FieldDesk0004 are exempt", async () => {
  const [app, userStore, bottomNav, decision, navigation, tracking, completion, styles] = await Promise.all([
    fs.readFile(path.join(__dirname, "../frontend/src/App.jsx"), "utf8"),
    fs.readFile(path.join(__dirname, "../frontend/src/shared/userStore.js"), "utf8"),
    fs.readFile(path.join(__dirname, "../frontend/src/components/BottomNav.jsx"), "utf8"),
    fs.readFile(path.join(__dirname, "../frontend/src/pages/RepairDecision.jsx"), "utf8"),
    fs.readFile(path.join(__dirname, "../frontend/src/shared/repairNavigation.js"), "utf8"),
    fs.readFile(path.join(__dirname, "../frontend/src/pages/MachineTracking.jsx"), "utf8"),
    fs.readFile(path.join(__dirname, "../frontend/src/pages/RepairCompletion.jsx"), "utf8"),
    fs.readFile(path.join(__dirname, "../frontend/src/App.css"), "utf8"),
  ]);
  assert.match(decision, /6 选 1/);
  assert.match(decision, /value: "ON_HOLD"/);
  assert.match(decision, /RECLOUD_HOLD_REASON_GROUPS/);
  for (const tone of ["repair", "abandoned", "inspection", "debugging", "transfer", "hold"]) {
    assert.match(decision, new RegExp(`tone: "${tone}"`));
  }
  assert.match(completion, /const nextPage = "repairProcess"/);
  assert.doesNotMatch(styles, /\.treatment-option:last-child\{grid-column:1\/-1/);
  assert.match(app, /nextPage === "home"/);
  assert.match(app, /nextPage === "repair"/);
  assert.match(app, /isWorkflowRestrictedTechnician\(latestUser\)/);
  assert.match(app, /resumePageForLocalWorkflow\(activeOrder\)/);
  assert.match(userStore, /!isBusinessRuleExempt\(user\)/);
  assert.match(bottomNav, /item\.page === "home"/);
  assert.match(bottomNav, /item\.page === "repair" \? "workflow-resume"/);
  assert.doesNotMatch(bottomNav, /\["home", "repair"\]\.includes/);
  assert.match(navigation, /isTechnicianWorkflowLocked/);
  assert.match(tracking, /查看全部进度/);
  assert.match(tracking, /机器在谁手里/);
});

test("hold API returns immediately and syncs the same reason and remark to Recloud", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fielddesk-hold-api-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new JsonReceiptPreparationStore(path.join(directory, "orders.json"));
  const prepared = await store.prepare({
    logisticsNo: "SF-HOLD-API", rmaNo: "JXTH-HOLD-API", sn: "W-HOLD-API-SN",
    specialty: "洗地机", productLine: "洗地机", operatorId: TECHNICIAN.userId,
    operatorName: TECHNICIAN.displayName,
  });
  await store.markModelAuthorization(prepared.rmaNo, { repairability: "SUPPORTED", status: "MATCHED", localWorkflowAllowed: true }, TECHNICIAN);
  await store.addReceiptAttachment(prepared.rmaNo, { id: "PHOTO-API", name: "receipt.jpg", mimeType: "image/jpeg" }, TECHNICIAN);
  await store.completeReceipt(prepared.rmaNo, TECHNICIAN);
  await store.saveWarrantyDecision(prepared.rmaNo, { technicianWarranty: "保外" }, TECHNICIAN);

  let received = null;
  const connector = {
    openRecloud: async () => ({ loginRequired: false, page: {} }),
    queryRmaByLogisticsNo: async () => ({ rmaNo: prepared.rmaNo }),
    submitRmaHold: async (_page, input, options) => {
      received = { input, options };
      return { confirmed: true };
    },
  };
  const app = createApp(connector, store, {
    env: { ...process.env, RECLOUD_HOLD_WRITE_ENABLED: "true" },
    getCurrentUser: () => TECHNICIAN,
    feishuModelCatalog: { authorize: async () => ({ repairability: "SUPPORTED", status: "MATCHED" }) },
  });
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
    instance.on("error", reject);
  });
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${url}/api/repairs/treatment-decision`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      rmaNo: prepared.rmaNo,
      treatmentMode: "ON_HOLD",
      holdCategory: "保内",
      holdReason: "网点缺件",
      holdRemark: "等待主刷电机到货",
    }),
  });
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.data.holdSyncQueued, true);

  for (let index = 0; index < 100 && !received; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.deepEqual(received, {
    input: { category: "保内", reason: "网点缺件", remark: "等待主刷电机到货" },
    options: { writeEnabled: true },
  });
  let saved;
  for (let index = 0; index < 100; index += 1) {
    saved = (await store.readAll()).find((item) => item.rmaNo === prepared.rmaNo);
    if (saved?.hold?.status === "CONFIRMED") break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(saved.hold.status, "CONFIRMED");
});
