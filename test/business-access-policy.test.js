const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const {
  isBusinessRuleExempt,
  hasBusinessRole,
  isInformationClerkReadOnlyByDefault,
} = require("../config/business-access-policy");

test("owner and Recloud test account bypass ordinary business role restrictions", () => {
  const owner = { userId: "FieldDesk0001", role: "ADMIN" };
  const recloudTest = { userId: "FieldDesk0004", role: "TECHNICIAN" };
  assert.equal(isBusinessRuleExempt(owner), true);
  assert.equal(isBusinessRuleExempt(recloudTest), true);
  assert.equal(hasBusinessRole(owner, "TECHNICIAN"), true);
  assert.equal(hasBusinessRole(recloudTest, "ADMIN"), true);
  assert.equal(isBusinessRuleExempt({ userId: "FieldDesk0005", role: "TECHNICIAN" }), false);
});

test("information clerk remains read-only by default", () => {
  assert.equal(isInformationClerkReadOnlyByDefault({ userId: "FieldDesk0006", role: "INFORMATION_CLERK" }), true);
  assert.equal(hasBusinessRole({ userId: "FieldDesk0006", role: "INFORMATION_CLERK" }, "ADMIN"), false);
});

test("frontend uses the same two protected business exemptions", async () => {
  const frontendPolicy = await import(pathToFileURL(path.join(__dirname, "../frontend/src/shared/accountAccessPolicy.js")));
  assert.equal(frontendPolicy.isBusinessRuleExempt({ id: "FieldDesk0001" }), true);
  assert.equal(frontendPolicy.isBusinessRuleExempt({ id: "FieldDesk0004" }), true);
  assert.equal(frontendPolicy.isInformationClerkReadOnlyByDefault({ id: "FieldDesk0006", role: "information_clerk" }), true);
});

test("protected account governance remains reserved for the owner", async () => {
  const fs = require("node:fs");
  const userStore = fs.readFileSync(path.join(__dirname, "../frontend/src/shared/userStore.js"), "utf8");
  const accountStore = fs.readFileSync(path.join(__dirname, "../database/account-store.js"), "utf8");
  assert.match(userStore, /isOwnerAccount\(user\).*return true/s);
  assert.match(userStore, /isRecloudTestAccount\(user\).*page !== "accountManagement"/s);
  assert.match(accountStore, /只有负责人可以管理 FieldDesk0004 测试账号/);
  assert.match(accountStore, /负责人账号和权限不能修改/);
});
