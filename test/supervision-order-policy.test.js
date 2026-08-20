const test = require("node:test");
const assert = require("node:assert/strict");
const { analyzeSupervisionOrder } = require("../services/supervision-order-policy");

test("同一督办单可同时识别折扣、催修和联系用户", () => {
  const result = analyzeSupervisionOrder("客户催促尽快维修，请联系用户，并按八折处理");
  assert.deepEqual(result.intents.map((item) => item.type), ["FEE_DISCOUNT", "EXPEDITE_REPAIR", "CONTACT_CUSTOMER"]);
  assert.equal(result.applyFeeAutomatically, false);
  assert.equal(result.requiresManualReview, true);
  assert.equal(result.replyOwner, "INFORMATION_CLERK");
  assert.equal(result.technicianCanReply, false);
  assert.match(result.technicianActions.join("，"), /维修进度/);
});

test("明确数字折扣只提取为建议且不能自动修改费用", () => {
  const result = analyzeSupervisionOrder("客服申请此单按8折处理");
  assert.equal(result.discountRate, 8);
  assert.equal(result.feeAction, "MANUAL_CONFIRMATION_REQUIRED");
  assert.equal(result.applyFeeAutomatically, false);
});

test("运费全免识别为运费调整并要求人工确认", () => {
  const result = analyzeSupervisionOrder("此单来回运费全免，请网点回复处理结果");
  assert.equal(result.intents[0].type, "FREIGHT_ADJUSTMENT");
  assert.equal(result.systemCanReply, false);
  assert.equal(result.requiresManualReview, true);
});

test("无法分类的客服原文保留并转人工", () => {
  const result = analyzeSupervisionOrder("请按最新政策跟进");
  assert.equal(result.originalContent, "请按最新政策跟进");
  assert.equal(result.intents[0].type, "OTHER");
  assert.equal(result.requiresManualReview, true);
});

test("保修范围通知不会被误识别为折扣", () => {
  const result = analyzeSupervisionOrder("核实用户SN整机在保，电池过保", { subtype: "收费问题" });
  assert.deepEqual(result.intents.map((item) => item.type), ["WARRANTY_REVIEW"]);
  assert.equal(result.applyFeeAutomatically, false);
  assert.equal(result.discountRate, null);
  assert.match(result.technicianActions.join("，"), /保修范围/);
});

test("寄回通知要求师傅反馈物流单号", () => {
  const result = analyzeSupervisionOrder("用户要求尽快寄回机器并发送快递单号");
  assert.equal(result.intents[0].type, "RETURN_SHIPPING");
  assert.match(result.technicianActions.join("，"), /物流单号/);
});
