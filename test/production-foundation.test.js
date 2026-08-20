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

test("administrator configures five account profiles and tokens stay private", async () => {
  const store = new AccountStore({ backend: new MemoryDocumentBackend({ users: [] }) });
  const profiles = [
    ["A", USER_ROLES.ADMIN, ["扫地机", "洗地机"]],
    ["W", USER_ROLES.WAREHOUSE, []],
    ["S", USER_ROLES.TECHNICIAN, ["扫地机"]],
    ["F", USER_ROLES.TECHNICIAN, ["洗地机"]],
    ["D", USER_ROLES.TECHNICIAN, ["扫地机", "洗地机"]],
  ];
  for (const [userId, role, repairSpecialties] of profiles) {
    await store.upsert({ userId, displayName: userId, role, repairSpecialties, accessToken: `safe-${userId}` }, admin);
  }
  const users = await store.list();
  assert.equal(users.length, 5);
  assert.ok(users.every((user) => !("tokenHash" in user) && !("accessToken" in user)));
  assert.equal((await store.findByToken("safe-D")).userId, "D");
  assert.throws(() => store.upsert({ userId: "X" }, sweep), { code: "ACCOUNT_ADMIN_REQUIRED" });
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
  assert.match(login, /正式账号访问令牌/);
  assert.match(accounts, /账号与权限/);
  assert.match(server, /\/api\/admin\/users/);
  assert.match(server, /Idempotency-Key/);
  assert.match(server, /\/api\/orders\/lock/);
});
