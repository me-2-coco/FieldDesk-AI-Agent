const test = require("node:test");
const assert = require("node:assert/strict");

const {
  phoneMatches,
  queryRepairHistory,
  queryRepairHistoryByPhone,
  queryMachinesInHand,
} = require("../services/repair-history-query");

const records = [
  {
    rmaNo: "RMA-OLD",
    logisticsNo: "SF100",
    phoneMasked: "138****0000",
    sn: "SN-0000001",
    productLine: "洗地机",
    status: "COMPLETED",
    technicianName: "李师傅",
    repairCompletion: {
      submittedAt: "2026-08-20T10:00:00.000Z",
      faultLevel1: "功能故障",
      repairMeasure: "更换软管",
    },
  },
  {
    rmaNo: "RMA-NEW",
    logisticsNo: "SF200",
    phoneMasked: "138****0000",
    sn: "SN-2",
    productLine: "洗地机",
    status: "REPAIRING",
    technicianName: "张师傅",
    receiptCompletedAt: "2026-08-21T09:00:00.000Z",
    updatedAt: "2026-08-22T09:00:00.000Z",
  },
  {
    rmaNo: "RMA-SHIPPED",
    logisticsNo: "SF300",
    phoneMasked: "139****1111",
    status: "SHIPPED_PENDING_COMPLETION",
    technicianName: "赵师傅",
  },
];

test("masked phone supports full number and last-four lookup", () => {
  assert.equal(phoneMatches("138****0000", "13812340000"), true);
  assert.equal(phoneMatches("138****0000", "0000"), true);
  assert.equal(phoneMatches("138****0000", "000"), false);
});

test("repair history returns completed read-only summary with last technician", () => {
  const result = queryRepairHistoryByPhone(records, "13812340000");
  assert.equal(result.length, 1);
  assert.equal(result[0].technicianName, "李师傅");
  assert.equal(result[0].replacedParts.length, 0);
  assert.equal(result[0].phone, "138****0000");
  assert.equal("repairCompletion" in result[0], false);
});

test("repair history supports exact SN lookup", () => {
  const result = queryRepairHistory(records, "sn-0000001");
  assert.equal(result.length, 1);
  assert.equal(result[0].rmaNo, "RMA-OLD");
  assert.equal(result[0].technicianName, "李师傅");
});

test("machine tracking searches by phone or logistics and excludes shipped machines", () => {
  assert.deepEqual(queryMachinesInHand(records, "0000").map((item) => item.rmaNo), ["RMA-NEW"]);
  assert.deepEqual(queryMachinesInHand(records, "sf200").map((item) => item.technicianName), ["张师傅"]);
  assert.deepEqual(queryMachinesInHand(records, "SF300"), []);
});
