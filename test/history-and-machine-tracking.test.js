const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { findMachineRepairHistory } = require("../services/repair-history-query");

const root = path.join(__dirname, "..");
async function source(file) { return fs.readFile(path.join(root, file), "utf8"); }

test("history is read-only and machine tracking is restricted to information clerk and admin", async () => {
  const server = await source("server.js");
  const history = await source("frontend/src/pages/RepairHistoryLookup.jsx");
  const tracking = await source("frontend/src/pages/MachineTracking.jsx");
  const accounts = await source("frontend/src/pages/AccountManagement.jsx");
  const home = await source("frontend/src/pages/Home.jsx");
  assert.match(server, /USER_ROLES\.TECHNICIAN, USER_ROLES\.INFORMATION_CLERK, USER_ROLES\.ADMIN/);
  assert.match(server, /USER_ROLES\.INFORMATION_CLERK, USER_ROLES\.ADMIN/);
  assert.match(history, /只读，不能修改历史工单/);
  assert.doesNotMatch(history + tracking, /method:\s*["'](?:POST|PUT|PATCH|DELETE)/i);
  assert.match(accounts, /INFORMATION_CLERK/);
  assert.match(home, /isInformationClerk \? "信息员"/);
});

test("repeat repair requires the same SN within 30 days and still returns older history", () => {
  const records = [
    {
      rmaNo: "JXTH-RECENT",
      sn: "SN-SAME-0001",
      technicianName: "李师傅",
      reportedFault: "近期故障",
      repairCompletion: { submittedAt: "2026-08-15T00:00:00.000Z", usedParts: [] },
    },
    {
      rmaNo: "JXTH-OLD",
      sn: "SN-SAME-0001",
      technicianName: "张师傅",
      reportedFault: "历史故障",
      repairCompletion: { submittedAt: "2026-05-01T00:00:00.000Z", usedParts: [] },
    },
    {
      rmaNo: "JXTH-OTHER-SN",
      sn: "SN-OTHER-0002",
      technicianName: "王师傅",
      repairCompletion: { submittedAt: "2026-08-30T00:00:00.000Z", usedParts: [] },
    },
  ];
  const recent = findMachineRepairHistory(records, {
    sn: "sn-same-0001",
    now: new Date("2026-08-31T00:00:00.000Z"),
  });
  assert.equal(recent.isRepeatRepair, true);
  assert.equal(recent.previousTechnicianName, "李师傅");
  assert.deepEqual(recent.records.map((item) => item.rmaNo), ["JXTH-RECENT", "JXTH-OLD"]);

  const expired = findMachineRepairHistory(records, {
    sn: "SN-SAME-0001",
    now: new Date("2026-10-01T00:00:00.000Z"),
  });
  assert.equal(expired.isRepeatRepair, false);
  assert.equal(expired.previousTechnicianName, "李师傅");
  assert.equal(expired.records.length, 2);
});
