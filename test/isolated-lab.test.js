const test = require("node:test");
const assert = require("node:assert/strict");
const { allowedFile } = require("../scripts/start-isolated-lab");
test("isolated snapshot includes code but excludes live data and login artifacts", () => {
  for (const file of ["server.js", "services/recloud-sync-service.js", "database/storage-backend.js", "knowledge/fault_mapping.json"]) assert.equal(allowedFile(file), true);
  for (const file of [".env", "database/data/orders.json", "database/uploads/photo.jpg", "connectors/recloud-state.json", "connectors/.recloud-browser-profile/state.json", "logs/backend.log", "runtime/test.json"]) assert.equal(allowedFile(file), false);
});
