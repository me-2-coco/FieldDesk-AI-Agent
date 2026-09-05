const test = require("node:test");
const assert = require("node:assert/strict");
const { orchestrateRepairStart } = require("../services/recloud-repair-start-orchestrator");
const { resolveRecloudTechnician } = require("../services/recloud-technician-mapping");
const fs = require("node:fs");
const path = require("node:path");

function adapterFixture() {
  let assignee = "旧负责人";
  let parts = [];
  const calls = [];
  return {
    calls,
    async readAssignee() { calls.push("assignee"); return assignee; },
    async readRemoteState() { calls.push("read"); return { assignee, parts }; },
    async assignResponsible(plan) { calls.push(`assign:${plan.servicePerson}`); assignee = plan.servicePerson; },
    async confirmWarrantyConversion(plan) { calls.push(`conversion:${plan.requested}`); },
    async addParts(additions) { calls.push(`parts:${additions.length}`); parts = additions; },
  };
}

test("FieldDesk account mapping resolves direct and preconfigured fallback names without probing both", () => {
  assert.equal(resolveRecloudTechnician({ userId: "T1", displayName: "新师傅", recloudAssigneeName: "瑞云师傅" }).servicePerson, "瑞云师傅");
  assert.deepEqual(resolveRecloudTechnician({
    userId: "T2", displayName: "新员工", recloudAssignmentMode: "FALLBACK", recloudFallbackAssigneeName: "临时负责人",
  }), {
    fieldDeskUserId: "T2", fieldDeskDisplayName: "新员工", servicePerson: "临时负责人", source: "FALLBACK",
  });
  assert.throws(() => resolveRecloudTechnician({ userId: "T3", recloudAssignmentMode: "FALLBACK" }), {
    code: "RECLOUD_TECHNICIAN_FALLBACK_REQUIRED",
  });
});

test("repair click preparation performs assignment, explicit conversion and parts in order", async () => {
  const adapter = adapterFixture();
  const result = await orchestrateRepairStart({
    assignee: "瑞云师傅",
    assignmentSource: "DIRECT",
    warrantyConversionRequested: false,
    usedParts: [{ partCode: "20020100013703", partName: "售后水泵", quantity: 1 }],
  }, adapter, { writeEnabled: true });
  assert.equal(result.status, "SUCCESS");
  assert.deepEqual(result.completedSteps, ["ASSIGNEE_VERIFIED", "WARRANTY_CONVERSION_CONFIRMED", "PARTS_VERIFIED"]);
  assert.deepEqual(adapter.calls, ["assignee", "assign:瑞云师傅", "assignee", "read", "conversion:false", "read", "parts:1", "read"]);
});

test("repair click preparation dry-run never writes", async () => {
  const adapter = adapterFixture();
  const result = await orchestrateRepairStart({
    assignee: "瑞云师傅", usedParts: [{ partCode: "P1", quantity: 1 }],
  }, adapter, { writeEnabled: false });
  assert.equal(result.status, "READY_DRY_RUN");
  assert.deepEqual(adapter.calls, ["assignee", "read"]);
});

test("assignment finishes before any page-switching remote-state read", async () => {
  const adapter = adapterFixture();
  await orchestrateRepairStart({
    assignee: "瑞云师傅", usedParts: [], warrantyConversionRequested: false,
  }, adapter, { writeEnabled: true });
  assert.deepEqual(adapter.calls.slice(0, 4), ["assignee", "assign:瑞云师傅", "assignee", "read"]);
});

test("repair assignment adapter never targets the dispatch action", () => {
  const source = fs.readFileSync(path.join(__dirname, "../connectors/recloud-repair-page-adapter.js"), "utf8");
  assert.doesNotMatch(source, /getByRole\([^\n]+name:\s*exactText\("派单"\)/);
  assert.match(source, /name:\s*exactText\("改派"\)/);
});
