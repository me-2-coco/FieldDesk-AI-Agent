const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { assessRecloudRepairPageReadiness } = require("../services/recloud-repair-page-readiness");

function readyInspection(overrides = {}) {
  return {
    repairEntryCandidateCount: 1,
    repairEntryClicked: true,
    serviceReportOpened: true,
    sectionTitles: ["服务单更换件明细", "故障模式及责任判定", "附件"],
    directRepairControls: [
      { key: "highestRepairLevel", labelCount: 1, inputCount: 1, editable: true },
      { key: "customerPaidAmount", labelCount: 1, inputCount: 1, editable: true },
      { key: "logisticsAmount", labelCount: 1, inputCount: 1, editable: true },
    ],
    partsTableSchema: { headers: ["新件编码", "数量"], rowCount: 0 },
    attachmentPanelSchema: { attachmentCount: 0 },
    partAddDialogInspection: { saveButtonCount: 1, dialogClosed: true },
    actionTexts: ["完工"],
    ...overrides,
  };
}

test("repair page readiness accepts only a fully observed complete-ready page", () => {
  const result = assessRecloudRepairPageReadiness(readyInspection());
  assert.equal(result.ready, true);
  assert.equal(result.status, "READY");
  assert.equal(result.observedState, "COMPLETE_READY");
  assert.equal(result.recloudModified, false);
});

test("repair page readiness recognizes the post-complete submit state", () => {
  const result = assessRecloudRepairPageReadiness(readyInspection({ actionTexts: ["提交"] }));
  assert.equal(result.ready, true);
  assert.equal(result.observedState, "SUBMIT_READY");
});

test("repair page readiness fails closed on ambiguous controls and missing remote sections", () => {
  const result = assessRecloudRepairPageReadiness(readyInspection({
    sectionTitles: ["故障模式及责任判定"],
    directRepairControls: [{ key: "logisticsAmount", labelCount: 2, inputCount: 1, editable: true }],
    partsTableSchema: { errorCode: "RECLOUD_REPAIR_PARTS_SCHEMA_CHANGED", missingFields: ["repair.parts.codeColumn"] },
    actionTexts: [],
  }));
  assert.equal(result.ready, false);
  assert.match(result.missingFields.join("|"), /repair\.section\.附件/);
  assert.match(result.missingFields.join("|"), /repair\.control\.logisticsAmount/);
  assert.match(result.missingFields.join("|"), /repair\.parts\.codeColumn/);
  assert.match(result.missingFields.join("|"), /repair\.completeOrSubmitAction/);
});

test("completed read-only inspection accepts locked controls and unavailable add-parts action", () => {
  const result = assessRecloudRepairPageReadiness(readyInspection({
    directRepairControls: [
      { key: "highestRepairLevel", labelCount: 1, inputCount: 1, editable: false },
    ],
    partAddDialogInspection: {
      unavailable: true,
      errorCode: "RECLOUD_REPAIR_PART_ADD_NOT_FOUND",
    },
    actionTexts: [],
  }), { mode: "completed-read-only" });

  assert.equal(result.ready, true);
  assert.equal(result.status, "READY");
  assert.equal(result.observedState, "COMPLETED_LOCKED");
  assert.deepEqual(result.missingFields, []);
  assert.equal(result.recloudModified, false);
});

test("repair form inspection endpoint is restricted to a configured test order and returns readiness", async () => {
  const server = await fs.readFile(path.join(__dirname, "../server.js"), "utf8");
  const start = server.indexOf('app.post("/api/crm/repairs/repair-form/inspect"');
  const block = server.slice(start, server.indexOf('app.get("/api/recloud/fault-catalog"', start));
  assert.match(block, /RECLOUD_REPAIR_TEST_LOGISTICS_NO/);
  assert.match(block, /RECLOUD_REPAIR_TEST_ORDER_REQUIRED/);
  assert.match(block, /inspectPartAddDialog: true/);
  assert.match(block, /assessRecloudRepairPageReadiness/);
});
