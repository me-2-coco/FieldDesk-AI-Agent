const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { JsonInventoryStore } = require("../database/inventory-store");

const techA = { userId: "TECH-A", displayName: "甲师傅", role: "TECHNICIAN" };
const techB = { userId: "TECH-B", displayName: "乙师傅", role: "TECHNICIAN" };
const warehouse = { userId: "WH-1", displayName: "库房", role: "WAREHOUSE" };
const roles = { ADMIN: "ADMIN", TECHNICIAN: "TECHNICIAN", WAREHOUSE: "WAREHOUSE" };
const context = { rmaNo: "JXTH-TEST-1", sn: "SN-TEST-1" };

async function storeFor(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fielddesk-inventory-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return new JsonInventoryStore(path.join(directory, "inventory.json"));
}

test("application deducts total stock and accumulates isolated technician stock", async (t) => {
  const store = await storeFor(t);
  await store.apply(context, "00100123", 2, techA);
  await store.apply(context, "00100123", 3, techA);
  await store.apply(context, "00100123", 1, techB);
  const adminView = await store.view({ role: "ADMIN" }, roles);
  assert.equal(adminView.totalStock.find((part) => part.code === "00100123").stock, 44);
  assert.equal(adminView.technicianStock[techA.userId].parts[0].stock, 5);
  assert.equal(adminView.technicianStock[techB.userId].parts[0].stock, 1);
  const techView = await store.view(techA, roles);
  assert.deepEqual(Object.keys(techView.technicianStock), [techA.userId]);
});

test("use prevents negative inventory and records bound transaction", async (t) => {
  const store = await storeFor(t);
  await store.apply(context, "00100234", 2, techA);
  await store.use(context, "00100234", 1, techA);
  await assert.rejects(store.use(context, "00100234", 2, techA), { code: "TECHNICIAN_STOCK_INSUFFICIENT" });
  const view = await store.view(techA, roles);
  const used = view.transactions.find((item) => item.type === "PART_USED");
  assert.equal(used.rmaNo, context.rmaNo);
  assert.equal(used.sn, context.sn);
  assert.equal(used.technicianId, techA.userId);
});

test("return reserves personal stock and warehouse confirmation restores total stock", async (t) => {
  const store = await storeFor(t);
  await store.apply(context, "00100123", 4, techA);
  const request = await store.requestReturn(context, "00100123", 3, techA);
  await assert.rejects(store.requestReturn(context, "00100123", 2, techA), { code: "RETURN_QUANTITY_EXCEEDED" });
  const before = await store.view(warehouse, roles);
  assert.equal(before.totalStock.find((part) => part.code === "00100123").stock, 46);
  await store.confirmReturn(request.id, warehouse);
  const after = await store.view(warehouse, roles);
  assert.equal(after.totalStock.find((part) => part.code === "00100123").stock, 49);
  assert.equal(after.returnRequests[0].status, "RETURN_CONFIRMED");
  assert.deepEqual(after.transactions.map((item) => item.type), ["PART_APPLIED", "RETURN_REQUESTED", "RETURN_CONFIRMED"]);
});

test("zero and excessive total stock applications are rejected", async (t) => {
  const store = await storeFor(t);
  await assert.rejects(store.apply(context, "00100345", 1, techA), { code: "PART_OUT_OF_STOCK" });
  await assert.rejects(store.apply(context, "00100123", 51, techA), { code: "PART_OUT_OF_STOCK" });
});

test("inventory pages expose role views and local-only operations", async () => {
  const inventory = await fs.readFile(path.join(__dirname, "../frontend/src/pages/Inventory.jsx"), "utf8");
  const warehousePage = await fs.readFile(path.join(__dirname, "../frontend/src/pages/Warehouse.jsx"), "utf8");
  assert.match(inventory, /总库库存（只读）/);
  assert.match(inventory, /申请退还/);
  assert.match(inventory, /库存流水/);
  assert.match(warehousePage, /确认退还入总库/);
  assert.match(warehousePage, /全部师傅库存/);
});

test("inventory API enforces technician and warehouse role boundaries", async () => {
  const source = await fs.readFile(
    path.join(__dirname, "../server.js"),
    "utf8"
  );
  assert.match(source, /user\.role !== USER_ROLES\.TECHNICIAN/);
  assert.match(source, /USER_ROLES\.ADMIN, USER_ROLES\.WAREHOUSE/);
  assert.match(source, /INVENTORY_ACTION_FORBIDDEN/);
  assert.doesNotMatch(source, /confirmSign[\s\S]{0,100}api\/inventory/);
});
