const test = require("node:test");
const assert = require("node:assert/strict");

test("app exits return to the originating hub, not a hard-coded hub", async () => {
  const { enterApp, exitApp, APP_ROOTS } = await import("../frontend/src/shared/appNavigation.js");
  for (const hub of ["home", "orders", "profile", "inventory"]) {
    for (const app of APP_ROOTS) {
      assert.deepEqual(exitApp(enterApp([], hub, app), app), { page: hub, trail: [] });
    }
  }
});
test("cross-app drill-down returns to its caller before exiting", async () => {
  const { enterApp, exitApp } = await import("../frontend/src/shared/appNavigation.js");
  let trail = enterApp([], "orders", "exceptionCenter");
  trail = enterApp(trail, "exceptionCenter", "repairReports");
  const back = exitApp(trail, "repairReports");
  assert.equal(back.page, "exceptionCenter");
  assert.equal(exitApp(back.trail, back.page).page, "orders");
});
test("workflow steps preserve the app origin; explicit tab switches reset it", async () => {
  const { enterApp, exitApp } = await import("../frontend/src/shared/appNavigation.js");
  const trail = enterApp([], "orders", "repair");
  assert.deepEqual(enterApp(trail, "repair", "repairWarranty"), trail);
  assert.deepEqual(enterApp(trail, "repairWarranty", "repair"), trail);
  assert.equal(exitApp(trail, "repair").page, "orders");
  assert.deepEqual(enterApp(trail, "repair", "profile"), []);
});
