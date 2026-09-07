const test = require("node:test");
const assert = require("node:assert/strict");
const {
  FREIGHT_WAIVER_APPLICATION_SOURCE,
  FREIGHT_WAIVER_TEMPLATE_SLOTS,
  buildFreightWaiverApplicationData,
  closeFreightWaiverApplicationRenderer,
  renderFreightWaiverApplicationHtml,
  renderFreightWaiverApplicationPng,
} = require("../services/freight-waiver-application");

test("freight waiver template maps every editable field in the 13-row source form", () => {
  assert.equal(FREIGHT_WAIVER_APPLICATION_SOURCE, "FREIGHT_WAIVER_APPLICATION");
  assert.deepEqual(
    FREIGHT_WAIVER_TEMPLATE_SLOTS.map((item) => item.key),
    [
      "customerName", "customerPhone", "rmaNo", "sn", "outOfWarrantyReason",
      "partsFee", "serviceFee", "expressFee", "quotedTotalFee", "applicationReason",
      "waiverType", "actualPaid", "applicant", "applicationDate", "approvalHeaders", "approvalRule",
    ]
  );
  assert.equal(Math.max(...FREIGHT_WAIVER_TEMPLATE_SLOTS.map((item) => item.row)), 12);
});

test("abandoned return data fills the quote while keeping actual payment at zero", () => {
  const data = buildFreightWaiverApplicationData({
    order: {
      customerName: "葛先生",
      phone: "18883147697",
      rmaNo: "JXTH202609052173",
      sn: "W2210B33VCN0076505",
      createdAt: "2026-09-07T02:43:47.843Z",
      technicianName: "刘朝阳",
    },
    pricing: {
      partsFee: 422,
      fee: 60,
      oneWayLogisticsFee: 40,
      quotedLogisticsFee: 80,
      quotedTotalFee: 562,
    },
    now: new Date("2026-09-07T04:00:00.000Z"),
  });

  assert.equal(data.customerName, "葛先生");
  assert.equal(data.customerPhone, "18883147697");
  assert.equal(data.rmaNo, "JXTH202609052173");
  assert.equal(data.partsFee, "422");
  assert.equal(data.serviceFee, "60");
  assert.equal(data.expressFee, "80");
  assert.equal(data.quotedTotalFee, "562");
  assert.equal(data.waiverType, "免运费");
  assert.equal(data.actualPaid, "0");
  assert.equal(data.applicationDate, "2026-9-7");
  assert.match(data.outOfWarrantyReason, /2023年3月/);
  assert.equal(data.applicationReason, "检测机器检测机器整机过保，用户嫌贵且有投诉倾向，此单为避免舆情，提高用户体验度特为用户免运费寄回");
});

test("freight waiver renderer produces one tightly cropped PNG form", async (t) => {
  t.after(closeFreightWaiverApplicationRenderer);
  const data = buildFreightWaiverApplicationData({
    order: { customerName: "测试客户", rmaNo: "RMA-1", sn: "W2210B33VCN0076505", technicianName: "测试师傅" },
    pricing: { partsFee: 100, fee: 40, oneWayLogisticsFee: 20, quotedTotalFee: 160 },
    now: new Date("2026-09-07T04:00:00.000Z"),
  });
  const html = renderFreightWaiverApplicationHtml(data);
  assert.match(html, /保外付费折扣申请单/);
  assert.match(html, /追觅创新科技（苏州）有限公司/);
  assert.match(html, /免运费/);
  assert.doesNotMatch(html, />100 元</);
  assert.doesNotMatch(html, /undefined/);

  const png = await renderFreightWaiverApplicationPng(data);
  assert.ok(png.length > 10_000);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
});
