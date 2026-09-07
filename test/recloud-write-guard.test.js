const test = require("node:test");
const assert = require("node:assert/strict");
const { createRecloudRmaWriteGuard } = require("../server");

test("temporary RMA allowlist blocks historical backlog but permits new live work", () => {
  const startedAt = Date.parse("2026-09-06T11:30:00.000Z");
  const allowed = createRecloudRmaWriteGuard(["RMA-RECOVERY"], startedAt);

  assert.equal(allowed("RMA-RECOVERY", { createdAt: "2026-09-01T00:00:00.000Z" }), true);
  assert.equal(allowed("RMA-OLD", { updatedAt: "2026-09-06T11:29:59.999Z" }), false);
  assert.equal(allowed("RMA-NEW", { createdAt: "2026-09-06T11:30:00.000Z" }), true);
  assert.equal(allowed("RMA-EDITED", { updatedAt: "2026-09-06T11:30:01.000Z" }), true);
});

test("empty allowlist permits normal operation", () => {
  const allowed = createRecloudRmaWriteGuard([], Date.now());
  assert.equal(allowed("ANY-RMA", {}), true);
});
