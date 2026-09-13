const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { JsonRecloudFaultCatalogStore } = require("../database/recloud-fault-catalog-store");

test("verified duplicate-name codes survive name-only refresh without choosing a default", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fault-codes-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new JsonRecloudFaultCatalogStore(path.join(dir, "catalog.json"));
  const fullPath = "测试质量 / 测试故障 / 测试配件";
  await store.replace([fullPath, "其他 / 其他 / 其他"]);
  await store.syncVerifiedPath(fullPath, [{ code: "TEST-A", parentCode: "P-A" }, { code: "TEST-B", parentCode: "P-B" }]);
  await store.replace([fullPath, "其他 / 其他 / 其他"]);
  const result = await store.search("测试配件");
  assert.equal(result.items.length, 1);
  assert.deepEqual(result.codeMappings.map((entry) => entry.code), ["TEST-A", "TEST-B"]);
  assert.equal(result.preferredCode, undefined);
  assert.equal((await store.search("其他")).codeMappings.length, 0);
  assert.throws(() => store.syncVerifiedPath(fullPath, [{ code: "TEST-C" }]), /不能为空/);
});
