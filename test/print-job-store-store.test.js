const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { PrintJobStore, buildTsplLabel } = require("../database/print-job-store");
const { createApp } = require("../server");
const { createRecloudRepairPageAdapter } = require("../connectors/recloud-repair-page-adapter");

async function startApi(t, user, store) {
  const app = createApp({}, { readAll: async () => [] }, {
    getCurrentUser: () => user,
    printJobStore: store,
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test("打印终端密钥只在创建时返回，并可认证", async () => {
  const store = new PrintJobStore({ driver: "memory" });
  const created = await store.saveTerminal({
    name: "维修区一号机",
    printerName: "XP-420B",
    memberUserIds: ["FieldDesk0005"],
  });
  assert.ok(created.terminal.id);
  assert.ok(created.enrollmentToken.length >= 32);
  assert.equal(created.terminal.tokenHash, undefined);
  assert.ok(await store.authenticate(created.terminal.id, created.enrollmentToken));
  assert.equal(await store.authenticate(created.terminal.id, "wrong"), null);
  const updated = await store.saveTerminal({ ...created.terminal, name: "维修区主打印机" });
  assert.equal(updated.enrollmentToken, "");
  assert.equal(updated.terminal.tokenHash, undefined);
});

test("师傅任务只进入被分配的终端，并支持租约、失败和重试", async () => {
  const store = new PrintJobStore({ driver: "memory" });
  const created = await store.saveTerminal({
    name: "一号机",
    printerName: "XP-420B",
    memberUserIds: ["FieldDesk0005"],
  });
  const job = await store.enqueue({
    userId: "FieldDesk0005",
    userName: "测试师傅",
    rmaNo: "JXTH000001",
    sn: "SN000001",
    partCode: "2002010000001",
    partName: "测试配件",
    idempotencyKey: "label:JXTH000001:1",
  });
  assert.equal(job.terminalId, created.terminal.id);
  assert.equal(job.status, "PENDING");

  const duplicate = await store.enqueue({ userId: "FieldDesk0005", idempotencyKey: "label:JXTH000001:1" });
  assert.equal(duplicate.id, job.id);
  const leased = await store.leaseNext(created.terminal.id);
  assert.equal(leased.status, "PRINTING");
  assert.equal(leased.attempts, 1);
  await store.finish(created.terminal.id, leased.id, false, "打印机缺纸");
  let rows = await store.listJobs();
  assert.equal(rows[0].status, "FAILED");
  assert.equal(rows[0].lastError, "打印机缺纸");
  await store.retry(job.id);
  const retried = await store.leaseNext(created.terminal.id);
  assert.equal(retried.attempts, 2);
  await store.finish(created.terminal.id, retried.id, true);
  rows = await store.listJobs();
  assert.equal(rows[0].status, "SUCCESS");
});

test("未分配师傅保留任务，普通账号不能指定别人的终端", async () => {
  const store = new PrintJobStore({ driver: "memory" });
  const created = await store.saveTerminal({
    name: "一号机",
    printerName: "XP-420B",
    memberUserIds: ["FieldDesk0005"],
  });
  const unassigned = await store.enqueue({ userId: "FieldDesk0006", rmaNo: "JXTH000002" });
  assert.equal(unassigned.status, "UNASSIGNED");
  await assert.rejects(
    store.enqueue({ userId: "FieldDesk0006", terminalId: created.terminal.id }),
    (error) => error.code === "PRINT_TERMINAL_FORBIDDEN" && error.status === 403
  );
  const adminJob = await store.enqueue({ userId: "FieldDesk0001", terminalId: created.terminal.id, allowAnyTerminal: true });
  assert.equal(adminJob.status, "PENDING");
});

test("标签生成的是可直接发送给热敏打印机的 TSPL 数据", () => {
  const decoded = Buffer.from(buildTsplLabel({
    rmaNo: "JXTH000003",
    sn: "SN000003",
    partCode: "PART-3",
  }), "base64").toString("utf8");
  assert.match(decoded, /^SIZE 70 mm,50 mm/);
  assert.match(decoded, /RMA: JXTH000003/);
  assert.match(decoded, /BARCODE/);
  assert.match(decoded, /PRINT 1,1/);
});

test("管理员创建测试任务后 Windows 助手可认证、领取并确认", async (t) => {
  const store = new PrintJobStore({ driver: "memory" });
  const baseUrl = await startApi(t, { userId: "FieldDesk0003", displayName: "管理员", role: "ADMIN" }, store);
  const createResponse = await fetch(`${baseUrl}/api/admin/print/terminals`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "测试终端", printerName: "XP-420B", memberUserIds: ["FieldDesk0005"] }),
  });
  assert.equal(createResponse.status, 201);
  const enrollment = (await createResponse.json()).data;
  assert.ok(enrollment.enrollmentToken);

  const queuedResponse = await fetch(`${baseUrl}/api/admin/print/jobs/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ terminalId: enrollment.terminal.id }),
  });
  assert.equal(queuedResponse.status, 201);
  const queued = (await queuedResponse.json()).data;

  const agentHeaders = {
    "X-Print-Terminal-Id": enrollment.terminal.id,
    "X-Print-Terminal-Token": enrollment.enrollmentToken,
  };
  const nextResponse = await fetch(`${baseUrl}/api/print-agent/jobs/next`, { headers: agentHeaders });
  assert.equal(nextResponse.status, 200);
  const leased = (await nextResponse.json()).data;
  assert.equal(leased.id, queued.id);
  assert.equal(leased.status, "PRINTING");

  const doneResponse = await fetch(`${baseUrl}/api/print-agent/jobs/complete`, {
    method: "POST",
    headers: { ...agentHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ jobId: leased.id, success: true }),
  });
  assert.equal(doneResponse.status, 200);
  assert.equal((await doneResponse.json()).data.status, "SUCCESS");
});

test("普通师傅不能进入打印终端管理接口", async (t) => {
  const baseUrl = await startApi(t, { userId: "FieldDesk0005", displayName: "师傅", role: "TECHNICIAN" }, new PrintJobStore({ driver: "memory" }));
  const response = await fetch(`${baseUrl}/api/admin/print/terminals`);
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, "PRINT_ADMIN_REQUIRED");
});

test("瑞云完工适配器把返厂旧件标签按当前师傅自动入队", async () => {
  const store = new PrintJobStore({ driver: "memory" });
  const terminal = await store.saveTerminal({
    name: "维修区终端",
    printerName: "XP-420B",
    memberUserIds: ["FieldDesk0005"],
  });
  const adapter = createRecloudRepairPageAdapter({}, {
    rmaNo: "JXTH000004",
    sn: "SN000004",
    printJobStore: store,
    payload: { technicianId: "FieldDesk0005", technicianName: "测试师傅" },
  });
  const result = await adapter.printOldPartLabels([
    { partCode: "PART-4", partName: "测试返厂件", quantity: 1, returnRequired: true },
  ]);
  assert.equal(result.queued, true);
  const [job] = await store.listJobs();
  assert.equal(job.terminalId, terminal.terminal.id);
  assert.equal(job.rmaNo, "JXTH000004");
  assert.equal(job.status, "PENDING");
});
