const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { JsonReceiptPreparationStore } = require("../database/receipt-preparation-store");
const { JsonInventoryStore } = require("../database/inventory-store");
const { LocalRepairAttachmentStore } = require("../database/repair-attachment-store");

const USER = {
  userId: "TECH-REPAIR-1", displayName: "本地测试师傅",
  role: "TECHNICIAN", repairSpecialties: ["扫地机"],
};

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fielddesk-completion-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const receiptStore = new JsonReceiptPreparationStore(path.join(directory, "orders.json"));
  const inventoryStore = new JsonInventoryStore(path.join(directory, "inventory.json"));
  await receiptStore.prepare({
    logisticsNo: "TEST-LOGISTICS", rmaNo: "TEST-RMA", sn: "TEST-SN-01",
    specialty: "扫地机", remark: "扫地机", productLine: "扫地机",
    reportedFault: "模拟报修故障", operatorId: USER.userId, operatorName: USER.displayName,
  });
  await receiptStore.completeReceipt("TEST-RMA", USER);
  await receiptStore.saveInspection("TEST-RMA", { inspectionResult: "检测完成" }, USER);
  return { directory, receiptStore, inventoryStore };
}

test("only inspected orders may enter repair completion", async (t) => {
  const { receiptStore } = await fixture(t);
  const draft = await receiptStore.saveRepairCompletion("TEST-RMA", { speechTemplate: "测试话术" }, USER, false);
  assert.equal(draft.status, "REPAIR_COMPLETION_DRAFT");

  const other = await new JsonReceiptPreparationStore(path.join(os.tmpdir(), `fielddesk-other-${Date.now()}.json`));
  t.after(() => fs.rm(other.filePath, { force: true }));
  await other.prepare({ logisticsNo: "L2", rmaNo: "R2", sn: "SN2" });
  await assert.rejects(other.saveRepairCompletion("R2", {}, USER, false), { code: "REPAIR_COMPLETION_NOT_ALLOWED" });
});

test("completion validates required fields and moves to pending shipment", async (t) => {
  const { receiptStore } = await fixture(t);
  await assert.rejects(receiptStore.saveRepairCompletion("TEST-RMA", {}, USER, true), {
    code: "REPAIR_COMPLETION_INVALID",
  });
  const completed = await receiptStore.saveRepairCompletion("TEST-RMA", {
    faultLevel1: "功能故障", faultLevel2: "清洁功能", faultLevel3: "不出水",
    responsibilityType: "保内质保", speechTemplate: "维修完成",
    repairMeasure: "维修完成；实际更换配件：主刷电机×1",
    attachments: [{ id: "SAFE-ATTACHMENT", name: "repair.jpg" }],
  }, USER, true);
  assert.equal(completed.status, "REPAIR_COMPLETED_PENDING_SHIPMENT");
  assert.equal(completed.repairCompletion.faultLevel3, "不出水");
  assert.equal(completed.repairCompletion.operatorId, USER.userId);
});

test("used parts are aggregated from PART_USED inventory transactions", async (t) => {
  const { inventoryStore } = await fixture(t);
  const context = { rmaNo: "TEST-RMA", sn: "TEST-SN-01" };
  await inventoryStore.apply(context, "00100123", 3, USER);
  await inventoryStore.use(context, "00100123", 1, USER);
  await inventoryStore.use(context, "00100123", 2, USER);
  assert.deepEqual(await inventoryStore.usedPartsForOrder("TEST-RMA", "TEST-SN-01"), [
    { partCode: "00100123", partName: "主刷电机", quantity: 3 },
  ]);
});

test("local attachment store saves media outside tracked data", async (t) => {
  const { directory } = await fixture(t);
  const store = new LocalRepairAttachmentStore(path.join(directory, "uploads"));
  const result = await store.save({
    rmaNo: "TEST-RMA", name: "repair.jpg", mimeType: "image/jpeg",
    data: Buffer.from("safe fixture").toString("base64"),
  });
  assert.equal(result.localOnly, true);
  const files = await fs.readdir(path.join(directory, "uploads", require("crypto").createHash("sha256").update("TEST-RMA").digest("hex")));
  assert.equal(files.length, 1);
});

test("frontend completion page includes fault search, warranty, media, draft and submit", async () => {
  const source = await fs.readFile(path.join(__dirname, "../frontend/src/pages/RepairCompletion.jsx"), "utf8");
  assert.match(source, /模糊搜索故障名称/);
  assert.match(source, /责任判定\/质保类型/);
  assert.match(source, /维修照片\/视频/);
  assert.match(source, /保存草稿/);
  assert.match(source, /提交完工/);
  assert.doesNotMatch(source, /recloud|瑞云.*fetch/i);
  const serverSource = await fs.readFile(path.join(__dirname, "../server.js"), "utf8");
  assert.match(serverSource, /\/api\/repairs\/completion\/attachments/);
  assert.match(serverSource, /attachmentStore\.save/);
});
