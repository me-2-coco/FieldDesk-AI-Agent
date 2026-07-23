const test = require("node:test");
const assert = require("node:assert/strict");
const { parseRepairDetail } = require("../connectors/recloud");
const { createApp, isDryRun } = require("../server");

async function startServer(connector) {
  const server = createApp(connector).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  return {
    server,
    url: `http://127.0.0.1:${server.address().port}`,
  };
}

test("parseRepairDetail extracts CRM receipt data", () => {
  assert.deepEqual(
    parseRepairDetail(
      "寄修单 JXTH20260723001 手机 13800138000 扫地机器人 SN WABC123456789",
      "SF001"
    ),
    {
      logisticsNo: "SF001",
      sn: "WABC123456789",
      rmaNo: "JXTH20260723001",
      crmOrderNo: "JXTH20260723001",
      productType: "扫地机",
      product: "扫地机",
      phone: "13800138000",
    }
  );
});

test("DRY_RUN is enabled unless explicitly disabled", () => {
  assert.equal(isDryRun({}), true);
  assert.equal(isDryRun({ DRY_RUN: "true" }), true);
  assert.equal(isDryRun({ DRY_RUN: "false" }), false);
});

test("receive API queries and fills receipt without confirmation", async (t) => {
  const calls = [];
  const connector = {
    async openRecloud() {
      return {
        page: {},
        browser: { close: async () => calls.push(["close"]) },
      };
    },
    async scanSign(page, logisticsNo) {
      calls.push(["query", logisticsNo]);
    },
    async getRepairDetail(page, logisticsNo) {
      return {
        logisticsNo,
        rmaNo: "JXTH001",
        crmOrderNo: "JXTH001",
        sn: "W12345678901",
        productType: "洗地机",
      };
    },
    async confirmSign(page, sn, productType, remark, options) {
      calls.push(["receive", sn, productType, remark, options]);
      return {
        success: true,
        dryRun: options.dryRun,
        confirmed: false,
        message: "DRY_RUN：未点击确认签收",
        sn,
        remark: productType,
      };
    },
  };
  const { server, url } = await startServer(connector);
  t.after(() => server.close());

  const response = await fetch(`${url}/api/crm/repairs/receive`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ logisticsNo: " SF001 " }),
  });
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.success, true);
  assert.equal(result.data.sn, "W12345678901");
  assert.equal(result.data.receipt.dryRun, true);
  assert.equal(result.data.receipt.confirmed, false);
  assert.deepEqual(calls, [
    ["query", "SF001"],
    ["receive", "W12345678901", "洗地机", "", { dryRun: true }],
    ["close"],
  ]);
});

test("API validates logistics number without opening CRM", async (t) => {
  const connector = {
    async openRecloud() {
      assert.fail("CRM must not open for invalid input");
    },
  };
  const { server, url } = await startServer(connector);
  t.after(() => server.close());

  const response = await fetch(`${url}/api/crm/repairs/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ logisticsNo: " " }),
  });

  assert.equal(response.status, 400);
  assert.equal((await response.json()).success, false);
});
