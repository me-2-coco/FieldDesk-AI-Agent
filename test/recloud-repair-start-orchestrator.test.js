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

test("explicit keep-current authorization preserves assignee and still adds parts", async () => {
  const adapter = adapterFixture();
  const result = await orchestrateRepairStart({ assignee: "新师傅", usedParts: [{ partCode: "TEST-1", quantity: 1 }] }, adapter,
    { writeEnabled: true, skipAssignment: true, skipAssignmentReason: "User authorized this order only" });
  assert.equal(result.assignee, "旧负责人");
  assert.match(result.assignmentSource, /^USER_AUTHORIZED_KEEP_CURRENT:/);
  assert.equal(result.partsVerified, true);
  assert.equal(adapter.calls.some(call => call.startsWith("assign:")), false);
  assert.ok(adapter.calls.includes("parts:1"));
});

test("skip without authorization reason does not bypass assignment", async () => {
  const adapter = adapterFixture();
  await orchestrateRepairStart({ assignee: "新师傅", usedParts: [] }, adapter, { writeEnabled: true, skipAssignment: true });
  assert.ok(adapter.calls.includes("assign:新师傅"));
});

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

test("repair preparation records explicit Recloud inventory shortage and continues", async () => {
  const adapter = adapterFixture();
  adapter.addParts = async (additions) => {
    adapter.calls.push(`parts:${additions.length}`);
    return { missingParts: additions.map((part) => ({ ...part, reason: "瑞云库存不足" })) };
  };
  const result = await orchestrateRepairStart({
    assignee: "瑞云师傅",
    warrantyConversionRequested: false,
    usedParts: [{ partCode: "P-NO-STOCK", partName: "缺货配件", quantity: 1 }],
  }, adapter, { writeEnabled: true });
  assert.equal(result.status, "PARTS_SHORTAGE");
  assert.equal(result.partsVerified, false);
  assert.equal(result.missingParts[0].partCode, "P-NO-STOCK");
});

test("real repair adapter records any unavailable part instead of stopping the workflow", () => {
  const source = fs.readFileSync(path.join(__dirname, "../connectors/recloud-repair-page-adapter.js"), "utf8");
  assert.match(source, /按网点库存不足规则跳过/);
  assert.doesNotMatch(source, /RECLOUD_REPAIR_PART_NOT_AVAILABLE/);
  assert.match(source, /瑞云点击完工后状态未变化/);
  assert.match(source, /page\.reload\(\{ waitUntil: "domcontentloaded"/);
});

test("preparation recovery resumes a completion task that was left ready after dry run", () => {
  const source = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
  assert.match(source, /\["FAILED", "MANUAL_REVIEW", "READY_DRY_RUN"\]\.includes\(task\.status\)/);
});

test("assignment finishes before any page-switching remote-state read", async () => {
  const adapter = adapterFixture();
  await orchestrateRepairStart({
    assignee: "瑞云师傅", usedParts: [], warrantyConversionRequested: false,
  }, adapter, { writeEnabled: true });
  assert.deepEqual(adapter.calls.slice(0, 4), ["assignee", "assign:瑞云师傅", "assignee", "read"]);
});

test("repair preparation without parts skips the redundant second remote-state read", async () => {
  const adapter = adapterFixture();
  const result = await orchestrateRepairStart({
    assignee: "瑞云师傅", usedParts: [], warrantyConversionRequested: false,
  }, adapter, { writeEnabled: true });
  assert.equal(result.status, "SUCCESS");
  assert.deepEqual(adapter.calls, [
    "assignee", "assign:瑞云师傅", "assignee", "read", "conversion:false",
  ]);
});

test("repair assignment adapter never targets the dispatch action", () => {
  const source = fs.readFileSync(path.join(__dirname, "../connectors/recloud-repair-page-adapter.js"), "utf8");
  assert.doesNotMatch(source, /getByRole\([^\n]+name:\s*exactText\("派单"\)/);
  assert.match(source, /name:\s*exactText\("改派"\)/);
  assert.match(source, /name:\s*exactText\("搜索"\)/);
  assert.match(source, /locator\("\.common-span:visible"\)/);
  assert.match(source, /name:\s*exactText\("确定"\)/);
  assert.doesNotMatch(source, /if \(options\.requested !== true\) return/);
  assert.match(source, /const choice = options\.requested === true \? "是" : "否"/);
  assert.match(source, /filter\(\{ has: serialNumberCell \}\)/);
  assert.match(source, /for \(let attempt = 0; attempt < 3/);
  assert.match(source, /按网点库存不足规则跳过/);
});

test("warranty conversion is explicitly confirmed even when the product row already shows in warranty", () => {
  const source = fs.readFileSync(path.join(__dirname, "../connectors/recloud-repair-page-adapter.js"), "utf8");
  assert.doesNotMatch(source, /alreadyInWarranty:\s*true/);
  assert.match(source, /const button = fixedCount === 1 \? fixedButtons\.first\(\) : rowButtons\.first\(\)/);
  assert.match(source, /fixedCount === 0 && rowCount === 0/);
  assert.match(source, /alreadyExplicitlyConfirmed:\s*true/);
  assert.match(source, /const choice = options\.requested === true \? "是" : "否"/);
});

test("every service-order read path closes blocking model notices before continuing", () => {
  const source = fs.readFileSync(path.join(__dirname, "../connectors/recloud-repair-page-adapter.js"), "utf8");
  assert.match(source, /async function openServiceReport[\s\S]*await dismissBlockingRepairMessageBoxes\(page, \{ settleMs: 0 \}\)/);
  assert.match(source, /维修措施保存校验失败[\s\S]*\.btn-close button:visible/);
  assert.match(source, /async readAssignee\(\) \{\s*await dismissRepairNotices\(\)/);
  assert.match(source, /async readRemoteState\(\) \{\s*await dismissRepairNotices\(\)/);
  assert.match(source, /async readRemoteAttachments\(options = \{\}\) \{\s*await dismissRepairNotices\(\)/);
});
