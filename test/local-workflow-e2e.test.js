const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { JsonReceiptPreparationStore } = require("../database/receipt-preparation-store");
const { JsonInventoryStore } = require("../database/inventory-store");
const { JsonRecloudSyncOutbox } = require("../database/recloud-sync-outbox");
const { DryRunRecloudAdapter } = require("../connectors/recloud-adapter");
const { RecloudSyncService } = require("../services/recloud-sync-service");
const { resolveReceiptSpecialty } = require("../server");

const ROLES = { ADMIN: "ADMIN", TECHNICIAN: "TECHNICIAN", WAREHOUSE: "WAREHOUSE" };
const TECH = {
  userId: "E2E-TECH-SWEEP", displayName: "本地扫地机测试师傅",
  role: ROLES.TECHNICIAN, repairSpecialties: ["扫地机"],
};
const OTHER_TECH = {
  userId: "E2E-TECH-WASH", displayName: "本地洗地机测试师傅",
  role: ROLES.TECHNICIAN, repairSpecialties: ["洗地机"],
};
const ADMIN = { userId: "E2E-ADMIN", displayName: "本地测试管理员", role: ROLES.ADMIN };

test("one local order completes the full FieldDesk workflow and creates five dry-run sync tasks", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fielddesk-local-e2e-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const orders = new JsonReceiptPreparationStore(path.join(directory, "orders.json"));
  const inventory = new JsonInventoryStore(path.join(directory, "inventory.json"));
  const outbox = new JsonRecloudSyncOutbox(path.join(directory, "outbox.json"));
  const sync = new RecloudSyncService(outbox, new DryRunRecloudAdapter(), { scheduler: () => {} });
  const states = [];

  // 到店查询结果使用完全虚构的数据；不连接瑞云。
  const queryResult = {
    logisticsNo: "E2E-INBOUND-001", rmaNo: "E2E-RMA-001", sn: " e2e-sn-001 ",
    productLine: "扫地机", customerName: "虚构测试用户", phoneMasked: "138****0000",
    regionAddress: "虚构测试地址", reportedFault: "模拟无法启动",
  };
  const specialty = resolveReceiptSpecialty(TECH, queryResult.productLine, "");
  assert.equal(specialty, "扫地机");
  assert.throws(() => resolveReceiptSpecialty(OTHER_TECH, queryResult.productLine, ""), {
    code: "REPAIR_SPECIALTY_FORBIDDEN",
  });

  const prepared = await orders.prepare({
    ...queryResult, specialty, remark: specialty,
    operatorId: TECH.userId, operatorName: TECH.displayName,
  });
  await orders.markModelAuthorization(prepared.rmaNo, { repairability: "SUPPORTED", status: "MATCHED" }, TECH);
  await orders.addReceiptAttachment(prepared.rmaNo, { id: "E2E-RECEIPT-PHOTO", name: "receipt.jpg", mimeType: "image/jpeg" }, TECH);
  states.push(prepared.status);
  assert.equal(prepared.sn, "E2E-SN-001");
  assert.equal(prepared.remark, "扫地机");

  const received = await orders.completeReceipt(prepared.rmaNo, TECH);
  states.push(received.status);
  await sync.enqueueOrderNode(received, "RECEIPT", received.receiptCompletedAt);

  const inspected = await orders.saveInspection(prepared.rmaNo, {
    inspectionResult: "维修", inspectionRemark: "模拟检测备注",
    faultCategory: "产品质量 / 无法启动 / 电源模块不良",
    technicianWarranty: "保内",
    detectionResult: "维修",
  }, TECH);
  states.push(inspected.status);
  await sync.enqueueOrderNode(inspected, "INSPECTION_COMPLETED", inspected.inspectionUpdatedAt);

  const context = { rmaNo: prepared.rmaNo, sn: prepared.sn };
  await inventory.apply(context, "00100123", 2, TECH);
  await orders.addTimelineEvent(prepared.rmaNo, "PART_APPLICATION", "配件申请完成", TECH);
  await inventory.use(context, "00100123", 1, TECH);
  const technicianView = await inventory.view(TECH, ROLES);
  assert.deepEqual(Object.keys(technicianView.technicianStock), [TECH.userId]);
  assert.equal(technicianView.technicianStock[TECH.userId].parts[0].stock, 1);
  assert.deepEqual(technicianView.transactions.map((item) => item.type), ["PART_APPLIED", "PART_USED"]);
  const usedParts = await inventory.usedPartsForOrder(prepared.rmaNo, prepared.sn);
  assert.equal(usedParts[0].quantity, 1);

  const repaired = await orders.saveRepairCompletion(prepared.rmaNo, {
    faultLevel1: "电气故障", faultLevel2: "供电系统", faultLevel3: "无法开机",
    responsibilityType: "保内质保", speechTemplate: "已完成维修",
    detectionResult: "维修后整机功能检测正常",
    repairMeasure: "已完成维修；实际更换配件：主刷电机×1", usedParts,
    attachments: [{ id: "E2E-REPAIR-PHOTO", name: "repair.jpg", mimeType: "image/jpeg" }],
  }, TECH, true);
  states.push(repaired.status);
  await sync.enqueueOrderNode(repaired, "REPAIR_COMPLETED", repaired.repairCompletion.submittedAt);

  const shipped = await orders.submitReturnShipment(prepared.rmaNo, {
    logisticsCompany: "模拟物流", trackingNo: "E2E-RETURN-001", attachments: [],
  }, TECH);
  states.push(shipped.status);
  await sync.enqueueOrderNode(shipped, "RETURN_SHIPPED", shipped.returnShipment.shippedAt);

  const completed = await orders.confirmCompletion(prepared.rmaNo, ADMIN);
  states.push(completed.status);
  await sync.enqueueOrderNode(completed, "ORDER_COMPLETED", completed.completedAt);

  assert.deepEqual(states, [
    "RECEIPT_PREPARED",
    "RECEIVED_PENDING_INSPECTION",
    "INSPECTION_COMPLETED_PENDING_REPAIR",
    "REPAIR_COMPLETED_PENDING_SHIPMENT",
    "SHIPPED_PENDING_COMPLETION",
    "COMPLETED",
  ]);

  const tasks = await outbox.readAll();
  assert.deepEqual(tasks.map((task) => task.nodeType), [
    "RECEIPT", "INSPECTION_COMPLETED", "REPAIR_COMPLETED", "RETURN_SHIPPED", "ORDER_COMPLETED",
  ]);
  assert.ok(tasks.every((task) => task.status === "PENDING"));
  for (const task of tasks) await sync.processTask(task.id);
  const syncTasks = await outbox.readAll();
  assert.ok(syncTasks
    .filter((task) => task.nodeType !== "REPAIR_COMPLETED")
    .every((task) => task.status === "SUCCESS"));
  assert.equal(
    syncTasks.find((task) => task.nodeType === "REPAIR_COMPLETED")?.status,
    "READY_DRY_RUN"
  );

  assert.equal((await orders.listOrdersForUser(ADMIN, ROLES)).length, 1);
  assert.equal((await orders.listOrdersForUser(TECH, ROLES)).length, 1);
  assert.equal((await orders.listOrdersForUser(OTHER_TECH, ROLES)).length, 0);
  const adminInventory = await inventory.view(ADMIN, ROLES);
  assert.ok(adminInventory.technicianStock[TECH.userId]);

  const timelineTypes = completed.timeline.map((item) => item.type);
  for (const type of ["CRM_QUERIED", "RECEIPT_COMPLETED", "INSPECTION_COMPLETED", "PART_APPLICATION", "REPAIR_COMPLETED", "RETURN_SHIPPED", "ORDER_COMPLETED"]) {
    assert.ok(timelineTypes.includes(type), `missing timeline node ${type}`);
  }
});

test("frontend workflow lets technicians finish locally while shipping stays in the background", async () => {
  const parts = await fs.readFile(path.join(__dirname, "../frontend/src/pages/PartsApplication.jsx"), "utf8");
  const completion = await fs.readFile(path.join(__dirname, "../frontend/src/pages/RepairCompletion.jsx"), "utf8");
  const home = await fs.readFile(path.join(__dirname, "../frontend/src/pages/Home.jsx"), "utf8");
  assert.match(parts, /setPage\("repairProcess"\)/);
  assert.match(completion, /if \(submit\) setPage\("home"\)/);
  assert.doesNotMatch(completion, /setPage\("returnShipping"\)/);
  assert.match(home, /后台发货进度/);
  assert.match(home, /workflow\.technicianWarranty \|\| workflow\.warrantyType/);
  assert.match(home, /level3Fault: workflow\.faultCategory/);
  assert.match(home, /resumePageForLocalWorkflow/);
  assert.doesNotMatch(home, /partApplications\?\.length > 0/);
});
