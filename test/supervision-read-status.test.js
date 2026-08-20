const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { JsonReceiptPreparationStore } = require("../database/receipt-preparation-store");

const TECHNICIAN = { userId: "TECH-SUPERVISION-1", displayName: "测试师傅" };

test("师傅查看督办通知只记录本地已读且不改变瑞云处理状态", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fielddesk-supervision-read-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new JsonReceiptPreparationStore(path.join(directory, "orders.json"));
  await store.prepare({
    logisticsNo: "SF-SYNTHETIC-READ",
    rmaNo: "JXTH-SYNTHETIC-READ",
    sn: "W00000SYNTHETIC",
    operatorId: TECHNICIAN.userId,
    operatorName: TECHNICIAN.displayName,
  });
  const saved = await store.saveSupervisionOrder("JXTH-SYNTHETIC-READ", {
    sourceId: "DB-SYNTHETIC-READ",
    originalContent: "请联系用户确认维修进度",
    analysis: { intents: [] },
  }, TECHNICIAN);

  assert.deepEqual(saved.supervisionOrder.readBy, []);
  assert.equal(saved.supervisionOrder.status, "NOTIFIED_TECHNICIAN");

  const read = await store.markSupervisionOrderRead("JXTH-SYNTHETIC-READ", saved.supervisionOrder.id, TECHNICIAN);
  assert.equal(read.readBy.length, 1);
  assert.equal(read.readBy[0].userId, TECHNICIAN.userId);
  assert.equal(read.status, "NOTIFIED_TECHNICIAN");
  assert.equal(read.replyContent, "");

  const repeated = await store.markSupervisionOrderRead("JXTH-SYNTHETIC-READ", saved.supervisionOrder.id, TECHNICIAN);
  assert.equal(repeated.readBy.length, 1);
});

test("已完成督办单保留历史但标记归档", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fielddesk-supervision-archive-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new JsonReceiptPreparationStore(path.join(directory, "orders.json"));
  await store.prepare({
    logisticsNo: "SF-SYNTHETIC-ARCHIVE", rmaNo: "JXTH-SYNTHETIC-ARCHIVE",
    sn: "W00000ARCHIVE", operatorId: TECHNICIAN.userId, operatorName: TECHNICIAN.displayName,
  });
  await store.saveSupervisionOrder("JXTH-SYNTHETIC-ARCHIVE", {
    sourceId: "DB-SYNTHETIC-ARCHIVE", originalContent: "测试督办", recloudStatus: "处理中",
  }, TECHNICIAN);
  const archived = await store.archiveSupervisionOrder("JXTH-SYNTHETIC-ARCHIVE", "DB-SYNTHETIC-ARCHIVE", TECHNICIAN);
  assert.equal(archived.recloudStatus, "已完成");
  assert.ok(archived.archivedAt);
  const record = (await store.readAll())[0];
  assert.equal(record.supervisionOrders.length, 1);
  assert.equal(record.timeline.at(-1).type, "SUPERVISION_COMPLETED");
});
