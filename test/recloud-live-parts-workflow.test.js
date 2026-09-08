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
  await store.startRepair(rmaNo, {
    partsPending: true,
    repairPreparation: { assignee: TECH.displayName, assignmentSource: "DIRECT", usedParts: [] },
  }, TECH);
  await store.markRecloudServiceOrderConfirmed(rmaNo, TECH, { serviceOrderNo: `SO-${rmaNo}` });
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
  assert.equal(resolved.recloudRepairPreparation.status, "WAITING_PART_VERIFICATION");
  assert.deepEqual(buildNodePayload(resolved, "REPAIR_COMPLETED").missingParts, []);
});

test("Recloud availability must be confirmed before the repair can advance", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fielddesk-part-preflight-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new JsonReceiptPreparationStore(path.join(directory, "orders.json"));
  await repairOrder(store, "LIVE-PART-4");
  const queued = await store.applyPart("LIVE-PART-4", {
    code: "风机",
    name: "风机",
    stock: 1,
    verificationQuery: "风机",
    verificationStatus: "PENDING",
  }, 1, TECH);
  assert.equal(queued.application.recloudVerificationStatus, "PENDING");
  await assert.rejects(store.confirmParts("LIVE-PART-4", TECH), { code: "RECLOUD_PART_VERIFICATION_PENDING" });
  const verified = await store.markRecloudPartVerification("LIVE-PART-4", queued.application.id, {
    status: "AVAILABLE",
    partCode: "20020100013826",
    partName: "风机及线束组件",
  }, TECH);
  assert.equal(verified.partApplications[0].recloudConfirmedAt, "");
  const confirmed = await store.confirmParts("LIVE-PART-4", TECH);
  assert.equal(confirmed.order.recloudRepairPreparation.status, "PENDING");
  assert.equal(confirmed.order.recloudRepairPreparation.usedParts[0].partCode, "20020100013826");
});

test("an explicitly authorized live add is locked after Recloud confirms the saved row", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fielddesk-part-live-add-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new JsonReceiptPreparationStore(path.join(directory, "orders.json"));
  await repairOrder(store, "LIVE-PART-ADD");
  const queued = await store.applyPart("LIVE-PART-ADD", {
    code: "20020100013826",
    name: "售后风机及线束组件",
    stock: 1,
    retailPrice: 66,
    catalogProjectCode: "R2501",
    catalogMatchScope: "ALL_CATALOG",
    catalogMatchLabel: "全表匹配·需瑞云确认",
    verificationStatus: "PENDING",
    recloudAddAuthorized: true,
  }, 1, TECH);
  const confirmed = await store.markRecloudPartVerification("LIVE-PART-ADD", queued.application.id, {
    status: "AVAILABLE",
    partCode: "20020100013826",
    partName: "售后风机及线束组件",
    retailPrice: 66,
    confirmed: true,
  }, TECH);
  assert.equal(confirmed.partApplications[0].status, "RECLOUD_PART_CONFIRMED");
  assert.equal(confirmed.partApplications[0].catalogProjectCode, "R2501");
  assert.equal(confirmed.partApplications[0].catalogMatchScope, "ALL_CATALOG");
  assert.ok(confirmed.partApplications[0].recloudConfirmedAt);
  await assert.rejects(
    store.updatePartApplication("LIVE-PART-ADD", queued.application.id, { remove: true }, TECH),
    { code: "RECLOUD_PART_APPLICATION_LOCKED" }
  );
});

test("Feishu candidates stay searchable before service-order creation and Next waits for Recloud verification", async () => {
  const serverSource = await fs.readFile(path.join(__dirname, "../server.js"), "utf8");
  const pageSource = await fs.readFile(path.join(__dirname, "../frontend/src/pages/PartsApplication.jsx"), "utf8");
  const adapterSource = await fs.readFile(path.join(__dirname, "../connectors/recloud-repair-page-adapter.js"), "utf8");
  assert.match(serverSource, /queuePartForRecloudVerification/);
  assert.match(serverSource, /scheduleRecloudPartVerification/);
  assert.match(serverSource, /adapter\.searchParts\(query, \{ limit: 30, timeoutMs: 2600 \}\)/);
  assert.match(serverSource, /order\.treatmentMode === "REPAIR"\) assertRecloudPartInteractionReady\(order\)/);
  assert.match(pageSource, /添加并在瑞云核实/);
  assert.match(serverSource, /searchWithFallback/);
  assert.match(serverSource, /"FEISHU_LIVE", "RECLOUD_SERVICE_ORDER"/);
  assert.match(pageSource, /机型优先 · 全表兜底/);
  assert.match(pageSource, /正在查询飞书备件表/);
  assert.doesNotMatch(pageSource, /keyword\.trim\(\)\.length < 2 \|\| \(!recordOnly && !partInteractionReady\)/);
  assert.match(pageSource, /disabled=\{isSaving \|\| !selectedPart \|\| selectedPartAlreadyApplied\}/);
  assert.match(pageSource, /searchKeyword: keyword\.trim\(\)/);
  assert.match(serverSource, /RECLOUD_PART_SELECTION_EXPIRED/);
  assert.match(serverSource, /application\.recloudAddAuthorized !== true/);
  assert.match(serverSource, /await adapter\.addParts/);
  assert.match(serverSource, /remotelyConfirmed: true/);
  assert.match(serverSource, /retailPrice: cachedPart\.retailPrice/);
  assert.match(pageSource, /!partInteractionReady \|\| !partVerificationComplete/);
  assert.doesNotMatch(pageSource, /disabled=\{!recordOnly && !partInteractionReady\}/);
  assert.match(pageSource, /排队待核实[\s\S]*瑞云核实中[\s\S]*异常，自动重试中/);
  assert.match(adapterSource, /items\.length === 0 && lookup\.selectedCode/);
  assert.match(adapterSource, /lookup\.optionCount > 0 && !lookup\.selectedCode/);
  assert.match(adapterSource, /getAttribute\?\.\("popperclass"\)/);
  assert.match(adapterSource, /locateAutocompleteLookup\(page, partInput\)/);
  assert.match(adapterSource, /rawOptions\.filter\(\{ hasText: \/\\S\/ \}\)/);
  assert.match(adapterSource, /await optionLocator\.nth\(index\)\.click/);
  assert.match(adapterSource, /waitForSelectedPartCode\(page, partCodeInput/);
  assert.match(adapterSource, /retailPrice: Number\.isFinite\(salesPrice\)/);
  assert.match(adapterSource, /waitForRecloudPartPrice\(page, salesPriceInput/);
});

test("Recloud preflight price is authoritative and Feishu only fills missing metadata", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fielddesk-recloud-price-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new JsonReceiptPreparationStore(path.join(directory, "orders.json"));
  await repairOrder(store, "LIVE-PART-PRICE");
  const queued = await store.applyPart("LIVE-PART-PRICE", {
    code: "12884",
    name: "12884",
    stock: 1,
    verificationStatus: "PENDING",
  }, 1, TECH);
  await store.markRecloudPartVerification("LIVE-PART-PRICE", queued.application.id, {
    status: "AVAILABLE",
    partCode: "20020100012884",
    partName: "售后主机自动进水回充组件",
    retailPrice: 33,
    metadataSource: "RECLOUD_SERVICE_ORDER",
  }, TECH);
  const enriched = await store.enrichRecloudPartApplication("LIVE-PART-PRICE", queued.application.id, {
    retailPrice: 99,
    repairLevel: "中修",
  });
  assert.equal(enriched.partApplications[0].retailPrice, 33);
  assert.equal(enriched.partApplications[0].repairLevel, "中修");
  assert.equal(enriched.partApplications[0].metadataSource, "RECLOUD_SERVICE_ORDER");
});
