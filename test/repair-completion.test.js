const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { JsonReceiptPreparationStore } = require("../database/receipt-preparation-store");
const { JsonInventoryStore } = require("../database/inventory-store");
const { LocalRepairAttachmentStore } = require("../database/repair-attachment-store");
const { getOutOfWarrantyFeePolicy } = require("../server");

const USER = {
  userId: "TECH-REPAIR-1", displayName: "本地测试师傅",
  role: "TECHNICIAN", repairSpecialties: ["扫地机"],
};
const ADMIN = {
  userId: "ADMIN-REPAIR-1", displayName: "测试管理员", role: "ADMIN",
};

test("调试按 SN 质保结果显示费用，但只有正常保外维修必填", () => {
  assert.deepEqual(getOutOfWarrantyFeePolicy({ treatmentMode: "DEBUGGING", technicianWarranty: "保内" }), {
    noPartsService: true,
    isOutOfWarranty: false,
    requiresOutOfWarrantyFee: false,
  });
  assert.deepEqual(getOutOfWarrantyFeePolicy({ treatmentMode: "DEBUGGING", technicianWarranty: "保外" }), {
    noPartsService: true,
    isOutOfWarranty: true,
    requiresOutOfWarrantyFee: false,
  });
  assert.deepEqual(getOutOfWarrantyFeePolicy({ treatmentMode: "REPAIR", technicianWarranty: "保外" }), {
    noPartsService: false,
    isOutOfWarranty: true,
    requiresOutOfWarrantyFee: true,
  });
});

test("完工页按处理方式显示质保标签，并使用紧凑收费卡片", async () => {
  const source = await fs.readFile(
    path.join(__dirname, "../frontend/src/pages/RepairCompletion.jsx"),
    "utf8"
  );

  assert.match(source, /"保外弃修"/);
  assert.doesNotMatch(source, /"保内弃修"/);
  assert.match(source, /"保外调试"/);
  assert.match(source, /compact-pricing-summary/);
  assert.match(source, /保外费用明细/);
  assert.match(source, /价格资料不完整/);
  assert.match(source, /仍可先填写运费/);
  assert.match(source, /查看费用明细/);
  assert.match(source, /scrollIntoView/);
  assert.match(source, /查看费用备注/);
  assert.match(source, /logisticsChargeMode !== "WAIVED"/);
  assert.match(source, /if \(nextMode === "WAIVED"\) setOneWayLogisticsFee\(""\)/);
  assert.match(source, /选择全免后无需填写/);
});

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
  await receiptStore.markModelAuthorization("TEST-RMA", { repairability: "SUPPORTED", status: "MATCHED" }, USER);
  await receiptStore.addReceiptAttachment("TEST-RMA", { id: "RECEIPT-PHOTO", name: "receipt.jpg", mimeType: "image/jpeg" }, USER);
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

test("reselecting repair preserves a saved inspection and can return to completion", async (t) => {
  const { receiptStore } = await fixture(t);
  await receiptStore.saveInspection("TEST-RMA", {
    inspectionResult: "维修",
    faultCategory: "产品质量|无法启动|电源模块不良",
    technicianWarranty: "保外",
  }, USER);
  await receiptStore.applyPart("TEST-RMA", {
    code: "00100123", name: "主刷电机", stock: 3,
    retailPrice: 29, repairLevel: "中修",
  }, 1, USER);

  const reselected = await receiptStore.saveTreatmentDecision("TEST-RMA", {
    treatmentMode: "REPAIR",
  }, USER);
  assert.equal(reselected.status, "INSPECTION_COMPLETED_PENDING_REPAIR");
  assert.equal(reselected.faultCategory, "产品质量|无法启动|电源模块不良");

  const confirmed = await receiptStore.confirmParts("TEST-RMA", USER);
  assert.equal(confirmed.order.status, "INSPECTION_COMPLETED_PENDING_REPAIR");
  assert.equal(confirmed.nextStep, "repairProcess");
});

test("unfinished order persists the exact page to resume", async (t) => {
  const { receiptStore } = await fixture(t);
  assert.equal((await receiptStore.readAll())[0].resumeStep, "repairProcess");

  await receiptStore.setResumeStep("TEST-RMA", "partsApplication", USER);
  assert.equal((await receiptStore.readAll())[0].resumeStep, "partsApplication");

  await receiptStore.setResumeStep("TEST-RMA", "repairCompletion", USER);
  assert.equal((await receiptStore.readAll())[0].resumeStep, "repairCompletion");

  await assert.rejects(
    receiptStore.setResumeStep("TEST-RMA", "unknownPage", USER),
    { code: "REPAIR_RESUME_STEP_INVALID" }
  );
});

test("completion validates required fields and moves to pending shipment", async (t) => {
  const { receiptStore } = await fixture(t);
  await assert.rejects(receiptStore.saveRepairCompletion("TEST-RMA", {}, USER, true), {
    code: "REPAIR_COMPLETION_INVALID",
  });
  const completed = await receiptStore.saveRepairCompletion("TEST-RMA", {
    faultLevel1: "功能故障", faultLevel2: "清洁功能", faultLevel3: "不出水",
    responsibilityType: "保内质保", speechTemplate: "维修完成",
    detectionResult: "维修后检测正常",
    repairMeasure: "维修完成；实际更换配件：主刷电机×1",
    attachments: [{ id: "SAFE-ATTACHMENT", name: "repair.jpg" }],
  }, USER, true);
  assert.equal(completed.status, "REPAIR_COMPLETED_PENDING_SHIPMENT");
  assert.equal(completed.repairCompletion.faultLevel3, "不出水");
  assert.equal(completed.repairCompletion.operatorId, USER.userId);
});

test("admin can restore a treated order to decision while preserving receipt ownership and history", async (t) => {
  const { receiptStore } = await fixture(t);
  await receiptStore.saveTreatmentDecision("TEST-RMA", {
    treatmentMode: "ABANDONED",
    detectionResult: "弃修",
    technicianWarranty: "保外",
  }, USER);
  await receiptStore.saveRepairCompletion("TEST-RMA", {
    responsibilityType: "保外维修",
    detectionResult: "弃修",
    speechTemplate: "客户弃修",
    repairMeasure: "用户原先决定弃修",
    attachments: [{ id: "ABANDONED-PHOTO", name: "abandoned.jpg", mimeType: "image/jpeg" }],
  }, USER, true);

  await assert.rejects(
    receiptStore.reopenTreatmentDecision("TEST-RMA", USER),
    { code: "TREATMENT_REOPEN_ADMIN_REQUIRED" }
  );
  const before = (await receiptStore.readAll())[0];
  const reopened = await receiptStore.reopenTreatmentDecision("TEST-RMA", ADMIN);
  assert.equal(reopened.status, "RECEIVED_PENDING_INSPECTION");
  assert.equal(reopened.resumeStep, "repairDecision");
  assert.equal(reopened.treatmentMode, "");
  assert.equal(reopened.repairCompletion, null);
  assert.equal(reopened.technicianId, before.technicianId);
  assert.equal(reopened.receiptCompletedAt, before.receiptCompletedAt);
  assert.deepEqual(reopened.receiptAttachments, before.receiptAttachments);
  assert.equal(reopened.treatmentReopenHistory.length, 1);
  assert.equal(reopened.treatmentReopenHistory[0].previousTreatmentMode, "ABANDONED");
  assert.equal(reopened.treatmentReopenHistory[0].previousRepairCompletion.repairMeasure, "用户原先决定弃修");
  assert.equal(reopened.timeline.at(-1).type, "TREATMENT_REOPENED");
});

test("admin cannot restore an order after return shipment", async (t) => {
  const { receiptStore } = await fixture(t);
  await receiptStore.saveTreatmentDecision("TEST-RMA", {
    treatmentMode: "DEBUGGING",
    detectionResult: "调试",
    technicianWarranty: "保外",
  }, USER);
  await receiptStore.saveRepairCompletion("TEST-RMA", {
    responsibilityType: "保外调试",
    detectionResult: "调试完成",
    speechTemplate: "调试完成",
    repairMeasure: "完成调试并寄回",
    attachments: [{ id: "DEBUG-PHOTO", name: "debug.jpg", mimeType: "image/jpeg" }],
  }, USER, true);
  await receiptStore.submitReturnShipment("TEST-RMA", {
    logisticsCompany: "顺丰",
    trackingNo: "SF1234567890",
    attachments: [{ id: "SHIP-PHOTO", name: "shipping.jpg", mimeType: "image/jpeg" }],
  }, ADMIN);
  await assert.rejects(
    receiptStore.reopenTreatmentDecision("TEST-RMA", ADMIN),
    { code: "TREATMENT_REOPEN_SHIPPED" }
  );
});

test("treatment decision routes repair to parts and no-parts modes to detection", async (t) => {
  const { receiptStore } = await fixture(t);
  await assert.rejects(receiptStore.saveTreatmentDecision("TEST-RMA", {
    treatmentMode: "ABANDONED",
    detectionResult: "弃修",
    technicianWarranty: "保内",
  }, USER), { code: "IN_WARRANTY_ABANDONMENT_NOT_ALLOWED" });
  const abandoned = await receiptStore.saveTreatmentDecision("TEST-RMA", {
    treatmentMode: "ABANDONED",
    detectionResult: "弃修",
    technicianWarranty: "保外",
  }, USER);
  assert.equal(abandoned.status, "INSPECTION_COMPLETED_PENDING_REPAIR");
  assert.equal(abandoned.skipsParts, true);
  assert.equal(abandoned.detectionResult, "弃修");

  await receiptStore.saveInspection("TEST-RMA", {
    inspectionResult: "弃修",
    faultCategory: "产品质量|无法启动|电源模块不良",
    technicianWarranty: "保外",
  }, USER);

  const completed = await receiptStore.saveRepairCompletion("TEST-RMA", {
    responsibilityType: "保外维修",
    detectionResult: "弃修",
    speechTemplate: "客户弃修",
    repairMeasure: "客诉故障复现，客户弃修，清理，寄回",
    attachments: [{ id: "ABANDONED-PHOTO", name: "abandoned.jpg", mimeType: "image/jpeg" }],
  }, USER, true);
  assert.equal(completed.status, "REPAIR_COMPLETED_PENDING_SHIPMENT");
  assert.equal(completed.repairCompletion.faultLevel1, "");
});

test("inspection-only completion requires a PDF inspection report", async (t) => {
  const { receiptStore } = await fixture(t);
  await receiptStore.saveTreatmentDecision("TEST-RMA", {
    treatmentMode: "INSPECTION_ONLY",
    detectionResult: "只检测不维修",
    technicianWarranty: "保内",
  }, USER);
  await receiptStore.saveInspection("TEST-RMA", {
    inspectionResult: "只检测不维修",
    faultCategory: "产品质量|无法启动|电源模块不良",
    technicianWarranty: "保内",
  }, USER);
  const base = {
    responsibilityType: "保内质保",
    detectionResult: "只检测不维修",
    speechTemplate: "出具检测报告",
    repairMeasure: "已完成检测并出具检测报告，只检测不维修，原机寄回",
  };
  await assert.rejects(receiptStore.saveRepairCompletion("TEST-RMA", {
    ...base,
    attachments: [{ id: "PHOTO", name: "inspection.jpg", mimeType: "image/jpeg" }],
  }, USER, true), { code: "REPAIR_COMPLETION_INVALID" });
  await assert.rejects(receiptStore.saveRepairCompletion("TEST-RMA", {
    ...base,
    attachments: [{ id: "REPORT", name: "inspection.pdf", mimeType: "application/pdf" }],
  }, USER, true), { code: "REPAIR_COMPLETION_INVALID" });
  const completed = await receiptStore.saveRepairCompletion("TEST-RMA", {
    ...base,
    attachments: [
      { id: "REPORT", name: "inspection.pdf", mimeType: "application/pdf" },
      { id: "PHOTO", name: "inspection.jpg", mimeType: "image/jpeg" },
    ],
  }, USER, true);
  assert.equal(completed.status, "REPAIR_COMPLETED_PENDING_SHIPMENT");
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

test("frontend completion page reuses confirmed fault and includes warranty, media, draft and submit", async () => {
  const source = await fs.readFile(path.join(__dirname, "../frontend/src/pages/RepairCompletion.jsx"), "utf8");
  const receiptSource = await fs.readFile(path.join(__dirname, "../frontend/src/pages/Repair.jsx"), "utf8");
  const previewSource = await fs.readFile(path.join(__dirname, "../frontend/src/components/AttachmentPreviewList.jsx"), "utf8");
  const appStyles = await fs.readFile(path.join(__dirname, "../frontend/src/App.css"), "utf8");
  const partsSource = await fs.readFile(path.join(__dirname, "../frontend/src/pages/PartsApplication.jsx"), "utf8");
  const measureSource = await fs.readFile(path.join(__dirname, "../frontend/src/shared/repairMeasure.js"), "utf8");
  assert.match(source, /已确认三级故障/);
  assert.doesNotMatch(source, /模糊搜索故障名称/);
  assert.match(source, /technicianWarranty === "保外"/);
  assert.doesNotMatch(source, /id="responsibility-type"/);
  assert.match(source, /维修措施/);
  assert.match(source, /系统生成 · 只读/);
  assert.match(source, /机器无法使用，客诉故障复现，检测不良，更换，清理，测试OK寄回/);
  assert.match(source, /机器正常使用，客诉故障未复现，清理，测试OK寄回/);
  assert.match(measureSource, /充电母端子组件已打胶/);
  assert.match(source, /维修照片\/视频/);
  assert.match(source, /AttachmentPreviewList/);
  assert.match(receiptSource, /AttachmentPreviewList/);
  assert.match(previewSource, /<img/);
  assert.match(previewSource, /<video[^>]+controls/);
  assert.match(previewSource, /点击放大/);
  assert.match(previewSource, /aria-label="关闭图片预览"/);
  assert.match(appStyles, /attachment-preview-list\{[^}]*grid-template-columns:repeat\(4/);
  assert.match(appStyles, /attachment-preview-list\{[^}]*max-height:176px/);
  assert.match(appStyles, /attachment-preview-list\{[^}]*overflow-y:auto/);
  assert.match(source, /保存草稿/);
  assert.match(source, /提交完工/);
  assert.match(source, /canSubmitCompletion/);
  assert.match(source, /保外费用待核对/);
  assert.match(source, /请填写单程物流费/);
  assert.match(source, /保外调试费用选填/);
  assert.match(source, /正在读取维修资料/);
  assert.match(source, /维修资料读取失败/);
  assert.match(partsSource, /完整费用在维修完工页核对/);
  assert.match(partsSource, /const backPage = "repairDecision"/);
  assert.match(source, /requiresOutOfWarrantyFee/);
  assert.match(source, /disabled=\{busy \|\| !canSubmitCompletion\}/);
  assert.doesNotMatch(source, /recloud|瑞云.*fetch/i);
  const serverSource = await fs.readFile(path.join(__dirname, "../server.js"), "utf8");
  assert.match(serverSource, /\/api\/repairs\/completion\/attachments/);
  assert.ok(serverSource.includes('/api/repairs/:rmaNo/attachments/:category/:attachmentId'));
  assert.match(serverSource, /Content-Disposition", `inline;/);
  assert.match(serverSource, /attachmentStore\.save/);
  assert.match(serverSource, /requiresOutOfWarrantyFee/);
  assert.match(serverSource, /!logisticsFeeIsWaived/);
  assert.match(serverSource, /hasSavedInspection/);
  assert.match(serverSource, /\/api\/repairs\/resume-step/);
});

test("completed orders reopen as read-only completion details", async () => {
  const homeSource = await fs.readFile(path.join(__dirname, "../frontend/src/pages/Home.jsx"), "utf8");
  assert.match(homeSource, /COMPLETED_WORKFLOW_STATUSES\.has\(workflow\.status\)/);
  assert.match(homeSource, /repairStatusForLocalWorkflow\(workflow\.status\)/);
});

test("frontend exposes six treatment choices including headquarters transfer and hold", async () => {
  const decisionSource = await fs.readFile(path.join(__dirname, "../frontend/src/pages/RepairDecision.jsx"), "utf8");
  const completionSource = await fs.readFile(path.join(__dirname, "../frontend/src/pages/RepairCompletion.jsx"), "utf8");
  for (const mode of ["REPAIR", "ABANDONED", "INSPECTION_ONLY", "DEBUGGING", "TRANSFER_TO_HEADQUARTERS", "ON_HOLD"]) {
    assert.match(decisionSource, new RegExp(mode));
  }
  assert.match(decisionSource, /申请配件/);
  assert.match(decisionSource, /transferToHeadquarters/);
  assert.match(decisionSource, /6 选 1/);
  assert.match(decisionSource, /RECLOUD_HOLD_REASON_GROUPS/);
  const serverSource = await fs.readFile(path.join(__dirname, "../server.js"), "utf8");
  assert.match(serverSource, /ABANDONED: \{ label: "弃修", detectionResult: "弃修", nextStep: "repairProcess" \}/);
  assert.match(completionSource, /application\/pdf/);
  assert.match(completionSource, /检测报告与照片\/视频/);
  assert.match(completionSource, /保内检测/);
});
