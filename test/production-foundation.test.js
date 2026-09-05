const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { MemoryDocumentBackend, createDocumentBackend } = require("../database/storage-backend");
const { AccountStore } = require("../database/account-store");
const { WorkCoordinationStore } = require("../database/work-coordination-store");
const { USER_ROLES, getLocalCurrentUser } = require("../config/local-users");

const admin = { userId: "ADMIN-1", displayName: "管理员", role: USER_ROLES.ADMIN };
const sweep = { userId: "TECH-S", displayName: "扫地机师傅", role: USER_ROLES.TECHNICIAN };
const wash = { userId: "TECH-W", displayName: "洗地机师傅", role: USER_ROLES.TECHNICIAN };

test("local frontend user IDs map to the matching backend development accounts", () => {
  const user = getLocalCurrentUser({}, "USER-004");
  assert.equal(user.userId, "LOCAL-TECH-WASH");
  assert.deepEqual(user.repairSpecialties, ["洗地机"]);
});

test("storage backend switches between memory and sqlite namespaces", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fielddesk-storage-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const memory = createDocumentBackend({ driver: "memory", initialValue: { value: 0 } });
  await memory.update((data) => { data.value += 1; });
  assert.equal((await memory.read()).value, 1);

  const filePath = path.join(directory, "fielddesk.sqlite");
  const orders = createDocumentBackend({ driver: "sqlite", filePath, namespace: "orders", initialValue: [] });
  const inventory = createDocumentBackend({ driver: "sqlite", filePath, namespace: "inventory", initialValue: { stock: 0 } });
  await orders.write([{ id: "ORDER-1" }]);
  await inventory.write({ stock: 3 });
  assert.deepEqual(await orders.read(), [{ id: "ORDER-1" }]);
  assert.deepEqual(await inventory.read(), { stock: 3 });
  orders.close();
  inventory.close();
});

test("administrator configures six account profiles and tokens stay private", async () => {
  const store = new AccountStore({ backend: new MemoryDocumentBackend({ users: [] }) });
  const profiles = [
    ["A", USER_ROLES.ADMIN, ["扫地机", "洗地机"]],
    ["W", USER_ROLES.WAREHOUSE, []],
    ["S", USER_ROLES.TECHNICIAN, ["扫地机"]],
    ["F", USER_ROLES.TECHNICIAN, ["洗地机"]],
    ["D", USER_ROLES.TECHNICIAN, ["扫地机", "洗地机"]],
    ["I", USER_ROLES.INFORMATION_CLERK, []],
  ];
  for (const [userId, role, repairSpecialties] of profiles) {
    await store.upsert({ userId, displayName: userId, role, repairSpecialties, accessToken: `safe-${userId}` }, admin);
  }
  const users = await store.list();
  assert.equal(users.length, 6);
  assert.ok(users.every((user) => !("tokenHash" in user) && !("accessToken" in user)));
  assert.equal(await store.findByToken("safe-D"), null);
  assert.equal((await store.findByCredentials("D", "safe-D")).userId, "D");
  assert.equal(await store.findByCredentials("D", "wrong-password"), null);
  assert.throws(() => store.upsert({ userId: "X" }, sweep), { code: "ACCOUNT_ADMIN_REQUIRED" });
});

test("administrator can preconfigure a new technician to a Recloud fallback assignee", async () => {
  const store = new AccountStore({ backend: new MemoryDocumentBackend({ users: [] }) });
  const user = await store.upsert({
    userId: "NEW-TECH", displayName: "新员工", role: USER_ROLES.TECHNICIAN,
    repairSpecialties: ["扫地机"], password: "safe-password",
    recloudAssignmentMode: "FALLBACK", recloudFallbackAssigneeName: "指定负责人",
  }, admin);
  assert.equal(user.recloudAssignmentMode, "FALLBACK");
  assert.equal(user.recloudFallbackAssigneeName, "指定负责人");
  assert.throws(() => store.upsert({
    userId: "INVALID", displayName: "无兜底", role: USER_ROLES.TECHNICIAN,
    repairSpecialties: ["扫地机"], password: "safe-password", recloudAssignmentMode: "FALLBACK",
  }, admin), { code: "ACCOUNT_RECLOUD_FALLBACK_REQUIRED" });
});

test("administrator creates managed FieldDesk accounts from 0005 with required roles and permissions", async () => {
  const store = new AccountStore({ backend: new MemoryDocumentBackend({ users: [] }) });
  const first = await store.createManagedAccount({ displayName: "测试甲", phone: "138 0013 8000", role: USER_ROLES.TECHNICIAN, repairSpecialties: ["扫地机"] }, admin);
  const second = await store.createManagedAccount({ displayName: "测试乙", phone: "13900139000", role: USER_ROLES.WAREHOUSE }, admin);
  assert.equal(first.userId, "FieldDesk0005");
  assert.equal(second.userId, "FieldDesk0006");
  assert.equal(first.initialPassword, "000000");
  assert.equal(first.phone, "13800138000");
  assert.equal(first.role, USER_ROLES.TECHNICIAN);
  assert.deepEqual(first.repairSpecialties, ["扫地机"]);
  assert.equal(first.recloudAssigneeName, "测试甲");
  assert.equal((await store.findByCredentials("FieldDesk0005", "000000")).mustChangePassword, true);
  await store.changePassword("FieldDesk0005", "new-safe-password");
  assert.equal(await store.findByCredentials("FieldDesk0005", "000000"), null);
  assert.equal((await store.findByCredentials("FieldDesk0005", "new-safe-password")).mustChangePassword, false);
  const reset = await store.resetPassword("FieldDesk0005", admin);
  assert.equal(reset.initialPassword, "000000");
  assert.equal((await store.findByCredentials("FieldDesk0005", "000000")).mustChangePassword, true);
  assert.throws(() => store.changePassword("FieldDesk0005", "000000"), { code: "ACCOUNT_PASSWORD_UNCHANGED" });
  await assert.rejects(() => store.createManagedAccount({ displayName: "重复", phone: "13800138000", role: USER_ROLES.WAREHOUSE }, admin), { code: "ACCOUNT_PHONE_EXISTS" });
  assert.throws(() => store.createManagedAccount({ displayName: "", phone: "13900139001", role: USER_ROLES.WAREHOUSE }, admin), { code: "ACCOUNT_DISPLAY_NAME_REQUIRED" });
  assert.throws(() => store.createManagedAccount({ displayName: "测试丙", phone: "123", role: USER_ROLES.WAREHOUSE }, admin), { code: "ACCOUNT_PHONE_INVALID" });
  assert.throws(() => store.createManagedAccount({ displayName: "测试丙", phone: "13700137000", role: USER_ROLES.TECHNICIAN }, admin), { code: "ACCOUNT_SPECIALTY_REQUIRED" });
  assert.throws(() => store.createManagedAccount({ displayName: "测试丙", phone: "13700137000", role: USER_ROLES.ADMIN }, admin), { code: "ACCOUNT_ROLE_INVALID" });
  assert.deepEqual(await store.delete(second.userId, admin), { userId: second.userId, displayName: "测试乙" });
  assert.equal(await store.findByCredentials(second.userId, "000000"), null);
  const third = await store.createManagedAccount({ displayName: "测试丙", phone: "13700137000", role: USER_ROLES.INFORMATION_CLERK }, admin);
  assert.equal(third.userId, "FieldDesk0007");
  assert.throws(() => store.delete(admin.userId, admin), { code: "ACCOUNT_SELF_DELETE_FORBIDDEN" });
});

test("production account mode can bootstrap one administrator without exposing token", async () => {
  const store = new AccountStore({ backend: new MemoryDocumentBackend({ users: [] }) });
  assert.equal(await store.ensureBootstrap("bootstrap-secret"), true);
  assert.equal(await store.ensureBootstrap("ignored-second-token"), false);
  const user = await store.findByToken("bootstrap-secret");
  assert.equal(user.role, USER_ROLES.ADMIN);
  assert.doesNotMatch(JSON.stringify(await store.list()), /bootstrap-secret|tokenHash/);
});

test("work locks isolate technicians and expire safely", async () => {
  let now = 1000;
  const store = new WorkCoordinationStore({ backend: new MemoryDocumentBackend({ locks: {}, idempotency: {}, audits: [] }), now: () => now });
  await store.acquire("RMA-1", sweep, 100);
  await assert.rejects(() => store.assertAvailable("RMA-1", wash), { code: "ORDER_LOCKED" });
  await store.assertAvailable("RMA-1", sweep);
  now = 1101;
  await store.assertAvailable("RMA-1", wash);
});

test("idempotency blocks concurrent duplicates and reuses completed response", async () => {
  const store = new WorkCoordinationStore({ backend: new MemoryDocumentBackend({ locks: {}, idempotency: {}, audits: [] }) });
  const first = await store.claimIdempotency("submit-1", sweep);
  await assert.rejects(() => store.claimIdempotency("submit-1", sweep), { code: "DUPLICATE_SUBMISSION_IN_PROGRESS" });
  await store.finishIdempotency(first.scopedKey, { success: true, data: { id: "LOCAL-1" } });
  const duplicate = await store.claimIdempotency("submit-1", sweep);
  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(duplicate.response, { success: true, data: { id: "LOCAL-1" } });
});

test("audit records operator and outcome without credentials", async () => {
  const store = new WorkCoordinationStore({ backend: new MemoryDocumentBackend({ locks: {}, idempotency: {}, audits: [] }) });
  await store.audit({ action: "POST /api/repairs/inspection", resourceId: "RMA-1", user: sweep, outcome: "SUCCESS" });
  const [record] = await store.listAudits();
  assert.equal(record.operatorId, sweep.userId);
  assert.equal(record.outcome, "SUCCESS");
  assert.doesNotMatch(JSON.stringify(record), /token|cookie|password/i);
});

test("production UI keeps access tokens in memory and exposes admin account management", async () => {
  const root = path.join(__dirname, "..");
  const crm = await fs.readFile(path.join(root, "frontend/src/shared/crmService.js"), "utf8");
  const login = await fs.readFile(path.join(root, "frontend/src/pages/Login.jsx"), "utf8");
  const accounts = await fs.readFile(path.join(root, "frontend/src/pages/AccountManagement.jsx"), "utf8");
  const server = await fs.readFile(path.join(root, "server.js"), "utf8");
  assert.match(crm, /Authorization: `Bearer/);
  assert.match(crm, /X-FieldDesk-Local-User/);
  assert.doesNotMatch(crm, /localStorage.*TOKEN|localStorage.*token/);
  assert.match(login, /登录密码/);
  assert.match(accounts, /账号管理/);
  assert.match(accounts, /编辑账号/);
  assert.match(server, /\/api\/auth\/login/);
  assert.match(server, /\/api\/admin\/users/);
  assert.match(server, /Idempotency-Key/);
  assert.match(server, /\/api\/orders\/lock/);
});
