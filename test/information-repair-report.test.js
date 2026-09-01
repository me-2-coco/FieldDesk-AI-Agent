const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../server");
const { buildInformationRepairReport, searchInformationRepairReports } = require("../services/information-repair-report");

const order = {
  rmaNo: "JXTH-REPORT-1", logisticsNo: "SF-REPORT-1", phoneMasked: "138****0000", sn: "SN-1",
  productLine: "洗地机", status: "REPAIR_COMPLETED_PENDING_SHIPMENT", technicianName: "李师傅",
  customerName: "不得返回", address: "不得返回",
  receiptAttachments: [{ id: "A1", name: "签收.jpg", mimeType: "image/jpeg", fileName: "stored-a.jpg", size: 3 }],
  inspectionResult: "功能正常", inspectionRemark: "已检测", technicianWarranty: "保外",
  repairCompletion: {
    faultLevel1: "功能故障", faultLevel2: "清洁功能", faultLevel3: "不出水",
    repairMeasure: "更换软管", operatorName: "李师傅", submittedAt: "2026-08-24T01:00:00Z",
    usedParts: [{ partCode: "P-1", partName: "软管", quantity: 1, repairLevel: "小修" }],
    attachments: [{ id: "A2", name: "完工.mp4", mimeType: "video/mp4", fileName: "stored-b.mp4", size: 4 }],
  },
};

test("information report is complete but excludes private and storage fields", () => {
  assert.equal(searchInformationRepairReports([order], "13812340000")[0].technicianName, "李师傅");
  const report = buildInformationRepairReport(order);
  assert.equal(report.repairCompletion.repairMeasure, "更换软管");
  assert.equal(report.usedParts[0].partName, "软管");
  assert.equal(report.attachments.length, 2);
  assert.doesNotMatch(JSON.stringify(report), /不得返回|stored-a|stored-b|phoneMasked/);
});

async function start(t, user) {
  const receiptStore = { readAll: async () => [order] };
  const fileStore = { read: async (rmaNo, attachment) => Buffer.from(attachment.id === "A1" ? "abc" : "defg") };
  const app = createApp({}, receiptStore, {
    getCurrentUser: () => user,
    attachmentStore: fileStore,
    receiptAttachmentStore: fileStore,
    shippingAttachmentStore: fileStore,
  });
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); instance.on("error", reject);
  });
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test("information clerk can read and download while technician is forbidden", async (t) => {
  const infoUrl = await start(t, { userId: "INFO", role: "INFORMATION_CLERK" });
  const search = await fetch(`${infoUrl}/api/information/repair-reports?keyword=SF-REPORT-1`);
  assert.equal(search.status, 200);
  const detail = await fetch(`${infoUrl}/api/information/repair-reports/JXTH-REPORT-1`);
  assert.equal((await detail.json()).data.usedParts[0].partName, "软管");
  const single = await fetch(`${infoUrl}/api/information/repair-reports/JXTH-REPORT-1/attachments/repair/A2`);
  assert.equal(await single.text(), "defg");
  const technicianUrl = await start(t, { userId: "TECH", role: "TECHNICIAN" });
  assert.equal((await fetch(`${technicianUrl}/api/information/repair-reports?keyword=SF-REPORT-1`)).status, 403);
  assert.equal((await fetch(`${technicianUrl}/api/information/repair-reports/JXTH-REPORT-1/attachments/repair/A2`)).status, 403);
});
