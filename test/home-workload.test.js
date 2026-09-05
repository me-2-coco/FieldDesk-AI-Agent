const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createApp } = require("../server");

test("technician workload totals every unfinished in-hand order and partitions hold reasons", async () => {
  const { categorizeTechnicianWorkflows, technicianWorkloadStatusLabel } = await import(
    pathToFileURL(path.join(__dirname, "../frontend/src/shared/homeWorkload.js"))
  );
  const received = { rmaNo: "ACTIVE", receiptCompletedAt: "2026-09-05", status: "INSPECTION_IN_PROGRESS" };
  const partsPage = { rmaNo: "PARTS", receiptCompletedAt: "2026-09-05", status: "PARTS_REQUESTED" };
  const branchShortage = { rmaNo: "BRANCH", receiptCompletedAt: "2026-09-05", status: "ON_HOLD", hold: { category: "保内", reason: "网点缺件" } };
  const headquartersShortage = { rmaNo: "HQ", receiptCompletedAt: "2026-09-05", status: "ON_HOLD", hold: { category: "保外", reason: "总部缺件" } };
  const outOfWarranty = { rmaNo: "OUT", receiptCompletedAt: "2026-09-05", status: "ON_HOLD", hold: { category: "保外", reason: "待用户付费" } };
  const otherHold = { rmaNo: "OTHER", receiptCompletedAt: "2026-09-05", status: "ON_HOLD", hold: { category: "保内", reason: "用户要求暂放" } };
  const completed = { rmaNo: "DONE", receiptCompletedAt: "2026-09-05", status: "REPAIR_COMPLETED_PENDING_SHIPMENT", repairCompletion: { submittedAt: "2026-09-05" } };
  const notReceived = { rmaNo: "UNSIGNED", status: "WAIT_RECEIPT" };

  const result = categorizeTechnicianWorkflows([
    received, partsPage, branchShortage, headquartersShortage, outOfWarranty, otherHold, completed, notReceived,
  ]);
  assert.deepEqual(result.unfinished.map((item) => item.rmaNo), ["ACTIVE", "PARTS", "BRANCH", "HQ", "OUT", "OTHER"]);
  assert.deepEqual(result.waitingMaterial.map((item) => item.rmaNo), ["BRANCH", "HQ"]);
  assert.deepEqual(result.outOfWarranty.map((item) => item.rmaNo), ["OUT"]);
  assert.deepEqual(result.otherHeld.map((item) => item.rmaNo), ["OTHER"]);
  assert.deepEqual(result.completed.map((item) => item.rmaNo), ["DONE"]);
  assert.equal(technicianWorkloadStatusLabel(headquartersShortage), "待料");
  assert.equal(technicianWorkloadStatusLabel(outOfWarranty), "保外暂存");
});

test("administrator and information clerk directory includes zero-work technicians and order fallbacks", async () => {
  const { buildTechnicianDirectory } = await import(
    pathToFileURL(path.join(__dirname, "../frontend/src/shared/homeWorkload.js"))
  );
  const result = buildTechnicianDirectory(
    [{ userId: "FieldDesk0005", displayName: "李师傅", repairSpecialties: ["扫地机"] }],
    [
      { technicianId: "FieldDesk0005", technicianName: "李师傅", specialty: "扫地机" },
      { technicianId: "LOCAL-TECH-WASH", technicianName: "王师傅", specialty: "洗地机" },
    ]
  );
  assert.deepEqual(result.map((item) => item.userId).sort(), ["FieldDesk0005", "LOCAL-TECH-WASH"].sort());
  assert.equal(result.find((item) => item.userId === "FieldDesk0005").repairSpecialties[0], "扫地机");
  assert.equal(result.find((item) => item.userId === "LOCAL-TECH-WASH").displayName, "王师傅");
});

test("technician workload view is read-only for information clerks and administrators", () => {
  const fs = require("node:fs");
  const server = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
  const home = fs.readFileSync(path.join(__dirname, "../frontend/src/pages/Home.jsx"), "utf8");
  assert.match(server, /\/api\/repairs\/technician-workloads/);
  assert.match(server, /USER_ROLES\.ADMIN, USER_ROLES\.INFORMATION_CLERK/);
  assert.match(server, /orders: orders\.map\(technicianWorkloadOrder\)/);
  assert.doesNotMatch(technicianWorkloadOrderSource(server), /phone:\s*order\.phone/);
  assert.match(home, /返回师傅列表/);
  assert.match(home, /onClick=\{\(\) => isTechnician && item\.status/);
});

function technicianWorkloadOrderSource(server) {
  return server.slice(
    server.indexOf("function technicianWorkloadOrder"),
    server.indexOf("function getAllowedRepairSpecialties")
  );
}

async function startWorkloadServer(t, user) {
  const receiptStore = { readAll: async () => [{
    rmaNo: "JXTH-WORKLOAD-1",
    phone: "13812345678",
    phoneMasked: "138****5678",
    technicianId: "FieldDesk0005",
    technicianName: "李师傅",
    specialty: "扫地机",
    receiptCompletedAt: "2026-09-05T00:00:00.000Z",
    status: "RECEIVED_PENDING_INSPECTION",
  }] };
  const accountStore = { list: async () => [{
    userId: "FieldDesk0005", displayName: "李师傅", role: "TECHNICIAN", active: true, repairSpecialties: ["扫地机"],
  }] };
  const app = createApp({}, receiptStore, { getCurrentUser: () => user, accountStore });
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
    instance.on("error", reject);
  });
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test("workload API allows information clerk and admin, rejects technician and masks customer phone", async (t) => {
  const infoUrl = await startWorkloadServer(t, { userId: "INFO", role: "INFORMATION_CLERK" });
  const infoResponse = await fetch(`${infoUrl}/api/repairs/technician-workloads`);
  assert.equal(infoResponse.status, 200);
  const infoData = (await infoResponse.json()).data;
  assert.equal(infoData.technicians[0].displayName, "李师傅");
  assert.equal(infoData.orders[0].phoneMasked, "138****5678");
  assert.equal("phone" in infoData.orders[0], false);

  const adminUrl = await startWorkloadServer(t, { userId: "ADMIN", role: "ADMIN" });
  assert.equal((await fetch(`${adminUrl}/api/repairs/technician-workloads`)).status, 200);

  const technicianUrl = await startWorkloadServer(t, { userId: "TECH", role: "TECHNICIAN" });
  assert.equal((await fetch(`${technicianUrl}/api/repairs/technician-workloads`)).status, 403);
});
