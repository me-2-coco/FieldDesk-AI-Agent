const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { JsonReceiptPreparationStore } = require("../database/receipt-preparation-store");
const { parseRecloudPartOptionText } = require("../connectors/recloud-repair-page-adapter");
const { buildNodePayload } = require("../connectors/recloud-sync-mapping");

const TECH = { userId: "LIVE-PART-TECH", displayName: "瑞云配件测试", role: "TECHNICIAN" };

async function repairOrder(store, rmaNo) {
  await store.prepare({ logisticsNo: `SF-${rmaNo}`, rmaNo, sn: "R2508054NCN000001", productLine: "扫地机" });
  await store.markModelAuthorization(rmaNo, { repairability: "SUPPORTED", status: "MATCHED" }, TECH);
  await store.addReceiptAttachment(rmaNo, { id: `PHOTO-${rmaNo}`, name: "receipt.jpg", mimeType: "image/jpeg" }, TECH);
  await store.completeReceipt(rmaNo, TECH);
  await store.saveWarrantyDecision(rmaNo, { technicianWarranty: "保内" }, TECH);
  await store.saveTreatmentDecision(rmaNo, { treatmentMode: "REPAIR" }, TECH);
  await store.saveInspection(rmaNo, {
    inspectionResult: "维修",
    faultCategory: "产品质量|功能异常|部件不良",
    technicianWarranty: "保内",
  }, TECH);
}

test("Recloud part suggestions return an authoritative full code and name", () => {
  assert.deepEqual(
    parseRecloudPartOptionText("售后风机及线束组件 20020100013826"),
    { code: "20020100013826", name: "售后风机及线束组件", source: "RECLOUD_SERVICE_ORDER" }
  );
  assert.deepEqual(
    parseRecloudPartOptionText("售后主板｜ABC-2508-01"),
    { code: "ABC-2508-01", name: "售后主板", source: "RECLOUD_SERVICE_ORDER" }
  );
});

test("confirmed Recloud parts are immutable in FieldDesk", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fielddesk-live-parts-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new JsonReceiptPreparationStore(path.join(directory, "orders.json"));
  await repairOrder(store, "LIVE-PART-1");
  const added = await store.applyPart("LIVE-PART-1", {
    code: "20020100013826",
    name: "售后风机及线束组件",
    stock: 1,
    recloudConfirmed: true,
  }, 1, TECH);
  assert.equal(added.application.status, "RECLOUD_PART_CONFIRMED");
  await assert.rejects(
    store.updatePartApplication("LIVE-PART-1", added.application.id, { remove: true }, TECH),
    { code: "RECLOUD_PART_APPLICATION_LOCKED" }
  );
});

test("a Recloud shortage is locked, cannot be bypassed, and completion keeps it pending", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fielddesk-live-shortage-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new JsonReceiptPreparationStore(path.join(directory, "orders.json"));
  await repairOrder(store, "LIVE-PART-2");
  const shortage = await store.recordRecloudPartShortage("LIVE-PART-2", {
    partCode: "NO-STOCK-1",
    partName: "缺件测试",
    quantity: 1,
    reason: "瑞云明确无库存",
  }, TECH);
  assert.equal(shortage.partsShortage.status, "PENDING_INFORMATION");
  await assert.rejects(
    store.confirmParts("LIVE-PART-2", TECH, { noParts: true, noPartsReason: "跳过" }),
    { code: "PARTS_SHORTAGE_BYPASS_FORBIDDEN" }
  );
  const confirmed = await store.confirmParts("LIVE-PART-2", TECH);
  assert.equal(confirmed.nextStep, "repairCompletion");
  assert.equal(confirmed.order.partsShortage.status, "PENDING_INFORMATION");
  assert.deepEqual(buildNodePayload(confirmed.order, "REPAIR_COMPLETED").missingParts, [{
    partCode: "NO-STOCK-1",
    partName: "缺件测试",
    quantity: 1,
    repairLevel: "",
    retailPrice: 0,
    returnRequired: false,
  }]);
});

test("a successful Recloud substitute resolves the original shortage", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fielddesk-live-substitute-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new JsonReceiptPreparationStore(path.join(directory, "orders.json"));
  await repairOrder(store, "LIVE-PART-3");
  await store.recordRecloudPartShortage("LIVE-PART-3", {
    partCode: "OLD-PART",
    partName: "原缺件",
    quantity: 1,
  }, TECH);
  const resolved = await store.resolveRecloudPartShortageWithReplacement(
    "LIVE-PART-3",
    "OLD-PART",
    { partCode: "NEW-PART", partName: "瑞云替代料" },
    TECH
  );
  assert.equal(resolved.partsShortage.status, "RESOLVED");
  assert.equal(resolved.recloudRepairPreparation.status, "CONFIRMED");
  assert.deepEqual(buildNodePayload(resolved, "REPAIR_COMPLETED").missingParts, []);
});

test("shortage replacement must be explicit and parts cannot be confirmed before Recloud is ready", async () => {
  const serverSource = await fs.readFile(path.join(__dirname, "../server.js"), "utf8");
  const pageSource = await fs.readFile(path.join(__dirname, "../frontend/src/pages/PartsApplication.jsx"), "utf8");
  assert.match(serverSource, /requestedReplacementFor && !shortageCodes\.includes\(requestedReplacementFor\)/);
  assert.doesNotMatch(serverSource, /shortageCodes\.length === 1 \? shortageCodes\[0\]/);
  assert.match(serverSource, /order\.treatmentMode === "REPAIR"\) assertRecloudPartInteractionReady\(order\)/);
  assert.match(pageSource, /只是新增，不解除缺件/);
  assert.match(pageSource, /!recordOnly && !partInteractionReady/);
});
