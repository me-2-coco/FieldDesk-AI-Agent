const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../server");
const { detectOrderExceptions, detectSyncExceptions, partsMismatch } = require("../services/information-exception-center");

test("exception rules detect stalled incomplete media parts assignment and shipping problems", () => {
  const order = {
    rmaNo: "RMA-EX-1", logisticsNo: "SF-EX-1", status: "SHIPPED_PENDING_COMPLETION",
    receiptCompletedAt: "2026-08-20T00:00:00Z", updatedAt: "2026-08-20T00:00:00Z",
    partApplications: [{ partCode: "P1", quantity: 1 }],
    repairCompletion: { usedParts: [{ partCode: "P2", quantity: 1 }], attachments: [] },
  };
  assert.equal(partsMismatch(order), true);
  const result = detectOrderExceptions(order, { now: Date.parse("2026-08-24T00:00:00Z") });
  const types = new Set(result.map((item) => item.type));
  for (const type of ["UNASSIGNED_TECHNICIAN", "REPORT_INCOMPLETE", "COMPLETION_MEDIA_MISSING", "PARTS_MISMATCH", "SHIPPED_NOT_COMPLETED"]) assert.equal(types.has(type), true);
  assert.equal(types.has("WORKFLOW_STALLED"), false);
});

test("completed repairs do not stall, but shortage and submit handoffs remain visible", () => {
  const base = { rmaNo:"SYNTH-COMPLETE", technicianId:"T1", status:"REPAIR_COMPLETED_PENDING_SHIPMENT", updatedAt:"2026-01-01T00:00:00Z", treatmentMode:"DEBUGGING", repairCompletion:{repairMeasure:"调试完成",operatorName:"测试师傅",attachments:[{id:"SYNTH-PHOTO"}]} };
  const now=Date.parse("2026-09-09T00:00:00Z");
  assert.deepEqual(detectOrderExceptions(base,{now}),[]);
  const types=detectOrderExceptions({...base,partsShortage:{status:"PENDING_INFORMATION",parts:[]},inspectionOnlyHandoff:{status:"PENDING_INFORMATION"}},{now}).map(e=>e.type);
  assert.deepEqual(types,["PARTS_SHORTAGE_PENDING","RECLOUD_COMPLETED_SUBMIT_PENDING"]);
  assert.ok(detectOrderExceptions({...base,status:"RECEIVED_PENDING_INSPECTION",repairCompletion:undefined},{now}).some(e=>e.type==="WORKFLOW_STALLED"));
});

test("sync exceptions expose safe status messages without raw failures", () => {
  const [item] = detectSyncExceptions([{ id: "T1", rmaNo: "R1", status: "FAILED", lastError: "secret remote body" }]);
  assert.equal(item.type, "SYNC_ATTENTION_REQUIRED");
  assert.doesNotMatch(JSON.stringify(item), /secret remote body|lastError/);
});

test("unknown Recloud receipt result is exposed for manual reconciliation", () => {
  const [item] = detectOrderExceptions({
    rmaNo: "RMA-RECEIPT-UNKNOWN",
    logisticsNo: "SF-RECEIPT-UNKNOWN",
    status: "RECEIPT_PREPARED",
    recloudReceiptSyncStatus: "RESULT_UNKNOWN",
    updatedAt: new Date().toISOString(),
  });
  assert.equal(item.type, "RECLOUD_RECEIPT_RESULT_UNKNOWN");
  assert.equal(item.severity, "HIGH");
  assert.match(item.message, /人工核对/);
});

test("inspection-only completion becomes a high-priority report address and submit task", () => {
  const [item] = detectOrderExceptions({
    rmaNo: "JXTH202609062811",
    logisticsNo: "SF5117998691836",
    status: "REPAIR_COMPLETED_PENDING_SHIPMENT",
    treatmentMode: "INSPECTION_ONLY",
    technicianName: "卢连波",
    inspectionOnlyHandoff: { status: "PENDING_INFORMATION" },
    repairCompletion: {
      repairMeasure: "只检测不维修，原机寄回",
      operatorName: "卢连波",
      attachments: [{ id: "PHOTO" }, { id: "REPORT", source: "INSPECTION_REPORT" }],
    },
    updatedAt: new Date().toISOString(),
  });
  assert.equal(item.type, "INSPECTION_ONLY_ADDRESS_AND_SUBMIT_PENDING");
  assert.equal(item.severity, "HIGH");
  assert.match(item.message, /开检测报告、上传到附件（检测报告）、修改返件地址后点击提交/);
});

async function start(t, user) {
  const receiptStore = { readAll: async () => [{ rmaNo: "R1", logisticsNo: "SF1", status: "RECEIVED_PENDING_INSPECTION", receiptCompletedAt: "2026-08-20T00:00:00Z", updatedAt: "2026-08-20T00:00:00Z" }] };
  const fileStore = { read: async () => Buffer.from("ok") };
  const app = createApp({}, receiptStore, {
    getCurrentUser: () => user,
    attachmentStore: fileStore, receiptAttachmentStore: fileStore, shippingAttachmentStore: fileStore,
    syncOutbox: { readAll: async () => [{ id: "T1", rmaNo: "R1", status: "MANUAL_REVIEW", updatedAt: "2026-08-24T00:00:00Z" }] },
  });
  const server = await new Promise((resolve, reject) => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); instance.on("error", reject); });
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test("information clerk and admin can inspect exceptions while technician cannot", async (t) => {
  const infoUrl = await start(t, { userId: "INFO", role: "INFORMATION_CLERK" });
  const infoResponse = await fetch(`${infoUrl}/api/information/exceptions`);
  assert.equal(infoResponse.status, 200);
  assert.ok((await infoResponse.json()).data.some((item) => item.type === "SYNC_ATTENTION_REQUIRED"));
  const technicianUrl = await start(t, { userId: "TECH", role: "TECHNICIAN" });
  assert.equal((await fetch(`${technicianUrl}/api/information/exceptions`)).status, 403);
});
