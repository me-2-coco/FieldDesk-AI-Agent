const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../server");

async function startServer(t, connector, env = {}) {
  const server = createApp(connector, null, {
    env: {
      ...process.env,
      DRY_RUN: "true",
      RECLOUD_WRITE_ENABLED: "false",
      RECLOUD_DETECTION_TEST_LOGISTICS_NO: "TEST-DETECTION-ORDER",
      ...env,
    },
  }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test("detection simulation uses only configured test order and restores keyword", async (t) => {
  const calls = [];
  const connector = {
    openRecloud: async () => ({ page: {} }),
    queryRmaByLogisticsNo: async (_page, logisticsNo, options) => {
      calls.push(["query", logisticsNo, options]);
      return { rmaNo: "JXTH-TEST-DETECTION" };
    },
    inspectDetectionForm: async (_page, options) => {
      calls.push(["inspect", options]);
      return {
        dryRun: true,
        faultKeywordFilled: true,
        faultKeywordRestored: true,
        valuesVerified: true,
        confirmClicked: false,
        confirmed: false,
        recloudModified: false,
        fieldControls: [],
      };
    },
    confirmDetection: async () => assert.fail("must never confirm detection"),
  };
  const url = await startServer(t, connector);

  const response = await fetch(`${url}/api/crm/repairs/detection-form/simulate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      logisticsNo: "TEST-DETECTION-ORDER",
      faultKeyword: "水泵",
    }),
  });
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.data.inspection.faultKeywordRestored, true);
  assert.equal(result.data.inspection.confirmClicked, false);
  assert.equal(result.data.inspection.controlMapping.readyToPrefill, false);
  assert.deepEqual(calls, [
    ["query", "TEST-DETECTION-ORDER", { preserveDetailPage: true }],
    ["inspect", { dryRun: true, writeEnabled: false, faultKeyword: "水泵", prefillPlan: null }],
  ]);
});

test("detection simulation builds a complete temporary prefill plan without confirming", async (t) => {
  let receivedPlan = null;
  const connector = {
    openRecloud: async () => ({ page: {} }),
    queryRmaByLogisticsNo: async () => ({ rmaNo: "JXTH-TEST-PREFILL" }),
    inspectDetectionForm: async (_page, options) => {
      receivedPlan = options.prefillPlan;
      return {
        dryRun: true,
        prefill: { valuesVerified: true, valuesRestored: true, confirmClicked: false },
        fieldControls: [],
        confirmClicked: false,
        confirmed: false,
        recloudModified: false,
      };
    },
    confirmDetection: async () => assert.fail("must never confirm detection"),
  };
  const url = await startServer(t, connector);
  const response = await fetch(`${url}/api/crm/repairs/detection-form/simulate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      logisticsNo: "TEST-DETECTION-ORDER",
      faultKeyword: "水泵",
      prefill: true,
      faultCategory: "产品质量 / 不出水 / 水泵不良",
      warrantyStatus: "保内",
      detectionResult: "维修",
    }),
  });
  const result = await response.json();
  const writes = Object.fromEntries(receivedPlan.safeWrites.map((item) => [item.key, item.value]));

  assert.equal(response.status, 200);
  assert.equal(writes.customerReasonConsistent, "是");
  assert.equal(writes.originalConsumables, "是");
  assert.equal(writes.consumableName, undefined);
  assert.ok(receivedPlan.excludedFields.some((item) => item.key === "consumableName"));
  assert.equal(receivedPlan.canAutoConfirm, false);
  assert.equal(result.data.inspection.prefill.confirmClicked, false);
});

test("detection simulation rejects any non-configured order before opening Recloud", async (t) => {
  let opened = false;
  const connector = {
    openRecloud: async () => {
      opened = true;
      return { page: {} };
    },
  };
  const url = await startServer(t, connector);

  const response = await fetch(`${url}/api/crm/repairs/detection-form/simulate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ logisticsNo: "OTHER-ORDER", faultKeyword: "水泵" }),
  });
  const result = await response.json();

  assert.equal(response.status, 403);
  assert.equal(result.code, "RECLOUD_DETECTION_TEST_ORDER_REQUIRED");
  assert.equal(opened, false);
});

test("detection prefill rejects incomplete business fields before opening Recloud", async (t) => {
  let opened = false;
  const connector = {
    openRecloud: async () => {
      opened = true;
      return { page: {} };
    },
  };
  const url = await startServer(t, connector);
  const response = await fetch(`${url}/api/crm/repairs/detection-form/simulate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      logisticsNo: "TEST-DETECTION-ORDER",
      faultKeyword: "水泵",
      prefill: true,
      faultCategory: "产品质量 / 不出水 / 水泵不良",
    }),
  });
  const result = await response.json();

  assert.equal(response.status, 400);
  assert.deepEqual(result.missingFields, ["warrantyStatus", "detectionResult"]);
  assert.equal(opened, false);
});

test("detection simulation is unavailable when Recloud writes are enabled", async (t) => {
  let opened = false;
  const connector = {
    openRecloud: async () => {
      opened = true;
      return { page: {} };
    },
  };
  const url = await startServer(t, connector, {
    RECLOUD_WRITE_ENABLED: "true",
  });

  const response = await fetch(`${url}/api/crm/repairs/detection-form/simulate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      logisticsNo: "TEST-DETECTION-ORDER",
      faultKeyword: "水泵",
    }),
  });
  const result = await response.json();

  assert.equal(response.status, 403);
  assert.equal(result.code, "RECLOUD_DETECTION_SIMULATION_UNSAFE");
  assert.equal(opened, false);
});
