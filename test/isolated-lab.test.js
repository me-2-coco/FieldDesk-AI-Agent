const test = require("node:test");
const assert = require("node:assert/strict");
const { allowedFile } = require("../scripts/start-isolated-lab");
test("isolated snapshot includes code but excludes live data and login artifacts", () => {
  for (const file of ["server.js", "services/recloud-sync-service.js", "database/storage-backend.js", "knowledge/fault_mapping.json"]) assert.equal(allowedFile(file), true);
  for (const file of [".env", "database/data/orders.json", "database/uploads/photo.jpg", "connectors/recloud-state.json", "connectors/.recloud-browser-profile/state.json", "logs/backend.log", "runtime/test.json"]) assert.equal(allowedFile(file), false);
});

test("running lab renders frontend without weakening API policy", { skip: !process.env.FIELDDESK_LAB_SMOKE }, async () => {
  const origin = "http://127.0.0.1:4174";
  const page = await fetch(origin);
  assert.match(page.headers.get("content-security-policy"), /script-src 'self'/);
  const health = await fetch(`${origin}/api/health`);
  assert.match(health.headers.get("content-security-policy"), /default-src 'none'/);
  assert.equal((await health.json()).dryRun, true);
  const { chromium } = require("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const tab = await browser.newPage();
    const errors = [];
    tab.on("pageerror", error => errors.push(error.message));
    await tab.goto(origin);
    await tab.waitForFunction(() => document.querySelector("#root")?.textContent.length > 30);
    assert.match(await tab.locator("#root").innerText(), /维修/);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
