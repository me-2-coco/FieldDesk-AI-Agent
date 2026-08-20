const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { JsonReceiptPreparationStore } = require("../database/receipt-preparation-store");
const { LocalShippingAttachmentStore } = require("../database/shipping-attachment-store");

const ROLES = { ADMIN: "ADMIN", TECHNICIAN: "TECHNICIAN", WAREHOUSE: "WAREHOUSE" };
const TECH = { userId: "TECH-1", displayName: "测试师傅", role: ROLES.TECHNICIAN };
const OTHER_TECH = { userId: "TECH-2", displayName: "其他师傅", role: ROLES.TECHNICIAN };
const ADMIN = { userId: "ADMIN-1", displayName: "测试管理员", role: ROLES.ADMIN };
const WAREHOUSE = { userId: "WAREHOUSE-1", displayName: "测试库房", role: ROLES.WAREHOUSE };

async function createFixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fielddesk-shipping-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new JsonReceiptPreparationStore(path.join(directory, "orders.json"));
  await store.prepare({
    logisticsNo: "INBOUND-TEST", rmaNo: "RMA-SHIPPING-1", sn: "SN-SHIPPING-1",
    productLine: "洗地机", customerName: "模拟用户", phoneMasked: "138****0000",
    regionAddress: "模拟省模拟市", reportedFault: "模拟故障",
    operatorId: TECH.userId, operatorName: TECH.displayName,
  });
  await store.markModelAuthorization("RMA-SHIPPING-1", { repairability: "SUPPORTED", status: "MATCHED" }, TECH);
  await store.addReceiptAttachment("RMA-SHIPPING-1", { id: "RECEIPT-PHOTO", name: "receipt.jpg", mimeType: "image/jpeg" }, TECH);
  await store.completeReceipt("RMA-SHIPPING-1", TECH);
  await store.saveInspection("RMA-SHIPPING-1", { inspectionResult: "检测完成" }, TECH);
  await store.saveRepairCompletion("RMA-SHIPPING-1", {
    faultLevel1: "功能故障", faultLevel2: "清洁功能", faultLevel3: "不出水",
    responsibilityType: "保内质保", speechTemplate: "维修完成",
    detectionResult: "维修后检测正常",
    repairMeasure: "维修完成；实际更换配件：无",
    attachments: [{ id: "REPAIR-PHOTO", name: "repair.jpg", mimeType: "image/jpeg" }],
  }, TECH, true);
  return { directory, store };
}

test("only repair-completed orders can be shipped and tracking number is required", async (t) => {
  const { store } = await createFixture(t);
  await assert.rejects(store.submitReturnShipment("RMA-SHIPPING-1", {
    logisticsCompany: "顺丰速运", trackingNo: "",
  }, TECH), { code: "RETURN_SHIPMENT_INVALID" });

  const shipped = await store.submitReturnShipment("RMA-SHIPPING-1", {
    logisticsCompany: "顺丰速运", trackingNo: " sf-test-001 ",
    attachments: [{ id: "PROOF-1", name: "proof.jpg" }],
  }, TECH);
  assert.equal(shipped.status, "SHIPPED_PENDING_COMPLETION");
  assert.equal(shipped.returnShipment.trackingNo, "SF-TEST-001");
  assert.equal(shipped.returnShipment.operatorId, TECH.userId);
  assert.equal(shipped.timeline.at(-1).type, "RETURN_SHIPPED");
  await assert.rejects(store.submitReturnShipment("RMA-SHIPPING-1", {
    logisticsCompany: "顺丰速运", trackingNo: "SF-AGAIN",
  }, TECH), { code: "RETURN_SHIPMENT_DUPLICATE" });
});

test("administrator completes a shipped order once", async (t) => {
  const { store } = await createFixture(t);
  await assert.rejects(store.confirmCompletion("RMA-SHIPPING-1", ADMIN), { code: "ORDER_COMPLETION_NOT_ALLOWED" });
  await store.submitReturnShipment("RMA-SHIPPING-1", { logisticsCompany: "京东物流", trackingNo: "JD-001" }, TECH);
  const completed = await store.confirmCompletion("RMA-SHIPPING-1", ADMIN);
  assert.equal(completed.status, "COMPLETED");
  assert.equal(completed.timeline.at(-1).type, "ORDER_COMPLETED");
  await assert.rejects(store.confirmCompletion("RMA-SHIPPING-1", ADMIN), { code: "ORDER_COMPLETION_DUPLICATE" });
});

test("technicians see only own shipping orders while admin and warehouse see all", async (t) => {
  const { store } = await createFixture(t);
  assert.equal((await store.listShippingOrders(TECH, ROLES)).length, 1);
  assert.equal((await store.listShippingOrders(OTHER_TECH, ROLES)).length, 0);
  assert.equal((await store.listShippingOrders(ADMIN, ROLES)).length, 1);
  assert.equal((await store.listShippingOrders(WAREHOUSE, ROLES)).length, 1);
});

test("timeline covers query, receipt, inspection, repair and shipping", async (t) => {
  const { store } = await createFixture(t);
  await store.addTimelineEvent("RMA-SHIPPING-1", "PART_APPLICATION", "配件申请完成", TECH);
  await store.submitReturnShipment("RMA-SHIPPING-1", { logisticsCompany: "中通快递", trackingNo: "ZT-001" }, TECH);
  const order = (await store.readAll())[0];
  const types = order.timeline.map((item) => item.type);
  for (const type of ["CRM_QUERIED", "RECEIPT_COMPLETED", "INSPECTION_COMPLETED", "PART_APPLICATION", "REPAIR_COMPLETED", "RETURN_SHIPPED"]) {
    assert.ok(types.includes(type), `missing ${type}`);
  }
});

test("shipping proof store accepts images and rejects video", async (t) => {
  const { directory } = await createFixture(t);
  const store = new LocalShippingAttachmentStore(path.join(directory, "proofs"));
  const saved = await store.save({
    rmaNo: "RMA-SHIPPING-1", name: "proof.jpg", mimeType: "image/jpeg",
    data: Buffer.from("safe image fixture").toString("base64"),
  });
  assert.equal(saved.localOnly, true);
  await assert.rejects(store.save({
    rmaNo: "RMA-SHIPPING-1", name: "proof.mp4", mimeType: "video/mp4",
    data: Buffer.from("safe video fixture").toString("base64"),
  }), { code: "SHIPPING_ATTACHMENT_INVALID" });
});

test("frontend exposes scan, proof, timeline and admin completion without Recloud", async () => {
  const page = await fs.readFile(path.join(__dirname, "../frontend/src/pages/ReturnShipping.jsx"), "utf8");
  assert.match(page, /扫描返件物流单号/);
  assert.match(page, /发货凭证照片/);
  assert.match(page, /工单时间线/);
  assert.match(page, /管理员确认完结/);
  assert.doesNotMatch(page, /queryCrm|recloudConnector/);
  const server = await fs.readFile(path.join(__dirname, "../server.js"), "utf8");
  assert.match(server, /\/api\/shipping\/submit/);
  assert.match(server, /\/api\/shipping\/complete/);
  assert.match(server, /user\.role !== USER_ROLES\.ADMIN/);
  const shippingBlock = server.slice(server.indexOf('app.get("/api/shipping/orders"'), server.indexOf("// 保留已有调用方兼容性"));
  assert.doesNotMatch(shippingBlock, /withRecloud|connector\./);
});
