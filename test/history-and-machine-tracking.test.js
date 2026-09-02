const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { findMachineRepairHistory } = require("../services/repair-history-query");

const root = path.join(__dirname, "..");
async function source(file) { return fs.readFile(path.join(root, file), "utf8"); }

test("an empty stored phone never matches a queried customer", () => {
  const { phoneMatches } = require("../services/repair-history-query");
  assert.equal(phoneMatches("", "13882038666"), false);
  assert.equal(phoneMatches("--", "13882038666"), false);
  assert.equal(phoneMatches("138****3666", "13882033666"), true);
});

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

test("repeat repair requires the same SN within one natural month and still returns older history", () => {
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

test("repeat repair also recognizes the same phone before either order is completed", () => {
  const records = [
    { rmaNo: "JXTH202608281001", phoneMasked: "138****3666", sn: "SN-OLDER", sourceCreatedAt: "2026-08-28T08:00:00.000Z" },
    { rmaNo: "JXTH202608311002", phoneMasked: "138****3666", sn: "SN-NEWER", sourceCreatedAt: "2026-08-31T08:00:00.000Z" },
  ];

  const older = findMachineRepairHistory(records, {
    phone: "13882033666",
    currentRmaNo: "JXTH202608281001",
    now: new Date("2026-09-02T00:00:00.000Z"),
  });
  const newer = findMachineRepairHistory(records, {
    phone: "13882033666",
    currentRmaNo: "JXTH202608311002",
    now: new Date("2026-09-02T00:00:00.000Z"),
  });

  assert.equal(older.isRepeatRepair, false);
  assert.equal(newer.isRepeatRepair, true);
  assert.equal(older.records.length, 0);
  assert.equal(newer.records[0].rmaNo, "JXTH202608281001");
  assert.equal(newer.previousTechnicianName, "");
});

test("repeat repair uses one natural calendar month instead of a fixed day count", () => {
  const records = [
    { rmaNo: "JXTH202601311001", sn: "SN-CALENDAR-MONTH", sourceCreatedAt: "2026-01-31T08:00:00+08:00" },
    { rmaNo: "JXTH202602281002", sn: "SN-CALENDAR-MONTH", sourceCreatedAt: "2026-02-28T08:00:00+08:00" },
  ];
  assert.equal(findMachineRepairHistory(records, {
    sn: "SN-CALENDAR-MONTH",
    currentRmaNo: "JXTH202602281002",
  }).isRepeatRepair, true);

  records[1] = { rmaNo: "JXTH202603011002", sn: "SN-CALENDAR-MONTH", sourceCreatedAt: "2026-03-01T08:00:00+08:00" };
  assert.equal(findMachineRepairHistory(records, {
    sn: "SN-CALENDAR-MONTH",
    currentRmaNo: "JXTH202603011002",
  }).isRepeatRepair, false);
});

test("repair query shows a red repeat-repair label beside multiple results", async () => {
  const repair = await source("frontend/src/pages/Repair.jsx");
  const styles = await source("frontend/src/App.css");
  assert.match(repair, /rma-repeat-label">重复维修/);
  assert.match(repair, /searchMatches\.some\(\(item\) => item\.isRepeatRepair\)/);
  assert.match(styles, /\.rma-repeat-label\{[^}]*color:#d1242f/);
  assert.match(repair, /rma-match-product-line/);
  assert.match(repair, /item\.productLine \|\| "产品线待确认"/);
  assert.match(repair, /item\.previousTechnicianName \|\| "待分配"/);
});
