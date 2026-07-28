const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  LOGISTICS_INPUT_PLACEHOLDER,
  enterRmaQuery,
  isRecloudLoginPage,
  parseRepairDetail,
} = require("../connectors/recloud");
const {
  RecloudQueryError,
  parseRmaDetailHtml,
} = require("../connectors/recloud-rma-parser");
const { isCrmQueryUrl } = require("../init-recloud-login");
const {
  createApp,
  isDryRun,
  isRecloudWriteEnabled,
} = require("../server");

const fixturePath = path.join(
  __dirname,
  "fixtures",
  "recloud-rma-detail.html"
);

async function startServer(connector) {
  const server = createApp(connector).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  return {
    server,
    url: `http://127.0.0.1:${server.address().port}`,
  };
}

test("HTML fixture parses only the approved V1 RMA fields", () => {
  const html = fs.readFileSync(fixturePath, "utf8");

  assert.deepEqual(parseRmaDetailHtml(html, "TEST-SCAN-0001"), {
    logisticsNo: "TEST-SCAN-0001",
    rmaNo: "RMA-TEST-0001",
    customer: {
      name: "测试用户甲",
      phoneMasked: "139****0000",
      regionAddress: "测试省测试市测试区示例路 1 号",
    },
    reportedFault: "测试机器启动后停止运行",
    pickupLogisticsNo: "TEST-PICKUP-0001",
    readOnly: true,
  });
});

test("parser rejects missing fields as a Recloud schema change", () => {
  assert.throws(
    () =>
      parseRmaDetailHtml(
        "<table><tr><th>寄修单号</th><td>RMA-TEST-0002</td></tr></table>",
        "TEST-SCAN-0002"
      ),
    (error) =>
      error.code === "RECLOUD_SCHEMA_CHANGED" &&
      error.message.includes("customer.name")
  );
});

test("parser rejects an unmasked customer phone number", () => {
  const html = fs
    .readFileSync(fixturePath, "utf8")
    .replace("139****0000", "13900000000");

  assert.throws(
    () => parseRmaDetailHtml(html, "TEST-SCAN-0003"),
    (error) =>
      error.code === "RECLOUD_SCHEMA_CHANGED" &&
      error.message.includes("脱敏格式")
  );
});

test("read-only query fills the exact scanner input and only presses Enter", async () => {
  const calls = [];
  const input = {
    async waitFor(options) {
      calls.push(["waitFor", options]);
    },
    async fill(value) {
      calls.push(["fill", value]);
    },
    async press(key) {
      calls.push(["press", key]);
    },
  };
  const page = {
    url: () => "https://crm2.recloud.com.cn/example#/scanSignin/query",
    locator(selector) {
      calls.push(["locator", selector]);
      return { first: () => input };
    },
  };

  await enterRmaQuery(page, " TEST-SCAN-0004 ");

  assert.deepEqual(calls, [
    [
      "locator",
      `input[placeholder="${LOGISTICS_INPUT_PLACEHOLDER}"]`,
    ],
    ["waitFor", { state: "visible" }],
    ["fill", "TEST-SCAN-0004"],
    ["press", "Enter"],
  ]);
});

test("legacy text parser remains available only for write-path compatibility", () => {
  assert.equal(
    parseRepairDetail("寄修单 JXTH20260723001", "TEST-SCAN-0005").rmaNo,
    "JXTH20260723001"
  );
});

test("DRY_RUN is enabled unless explicitly disabled", () => {
  assert.equal(isDryRun({}), true);
  assert.equal(isDryRun({ DRY_RUN: "true" }), true);
  assert.equal(isDryRun({ DRY_RUN: "false" }), false);
});

test("Recloud writes are disabled unless explicitly enabled", () => {
  assert.equal(isRecloudWriteEnabled({}), false);
  assert.equal(isRecloudWriteEnabled({ RECLOUD_WRITE_ENABLED: "false" }), false);
  assert.equal(isRecloudWriteEnabled({ RECLOUD_WRITE_ENABLED: "true" }), true);
});

test("recognizes Recloud login and CRM scanner URLs", () => {
  assert.equal(
    isRecloudLoginPage("https://auth4.recloud.com.cn/login?redirect=crm"),
    true
  );
  assert.equal(isRecloudLoginPage("https://crm2.recloud.com.cn/"), false);
  assert.equal(
    isCrmQueryUrl(
      "https://crm2.recloud.com.cn/t/dreame/webapp/dreame/#/scanSignin/query"
    ),
    true
  );
  assert.equal(isCrmQueryUrl("https://auth4.recloud.com.cn/login"), false);
});

test("query API calls only the read-only connector operation", async (t) => {
  const calls = [];
  const connector = {
    async openRecloud() {
      calls.push(["open"]);
      return {
        page: {},
        browser: { close: async () => calls.push(["close"]) },
      };
    },
    async queryRmaByLogisticsNo(page, logisticsNo) {
      calls.push(["query", logisticsNo]);
      return {
        logisticsNo,
        rmaNo: "RMA-TEST-0006",
        customer: {
          name: "测试用户乙",
          phoneMasked: "137****0000",
          regionAddress: "测试省测试市",
        },
        reportedFault: "测试故障描述",
        pickupLogisticsNo: "TEST-PICKUP-0006",
        readOnly: true,
      };
    },
    async confirmSign() {
      assert.fail("read-only query must never call confirmSign");
    },
  };
  const { server, url } = await startServer(connector);
  t.after(() => server.close());

  const response = await fetch(`${url}/api/crm/repairs/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ logisticsNo: " TEST-SCAN-0006 " }),
  });
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.success, true);
  assert.equal(result.data.readOnly, true);
  assert.deepEqual(calls, [
    ["open"],
    ["query", "TEST-SCAN-0006"],
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

test("receive API is blocked before opening Recloud", async (t) => {
  const connector = {
    async openRecloud() {
      assert.fail("write-disabled receive route must not open Recloud");
    },
  };
  const { server, url } = await startServer(connector);
  t.after(() => server.close());

  const response = await fetch(`${url}/api/crm/repairs/receive`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ logisticsNo: "TEST-SCAN-WRITE" }),
  });
  const result = await response.json();

  assert.equal(response.status, 403);
  assert.equal(result.code, "RECLOUD_WRITE_DISABLED");
});

for (const scenario of [
  ["RECLOUD_LOGIN_REQUIRED", 502, "瑞云登录已失效"],
  ["RECLOUD_ORDER_NOT_FOUND", 404, "没有查询到"],
  ["RECLOUD_SCHEMA_CHANGED", 502, "页面结构已变化"],
  ["RECLOUD_QUERY_TIMEOUT", 504, "查询超时"],
]) {
  const [code, status, message] = scenario;

  test(`query API maps ${code} to a distinct response`, async (t) => {
    const connector = {
      async openRecloud() {
        return {
          page: {},
          browser: { close: async () => {} },
        };
      },
      async queryRmaByLogisticsNo() {
        throw new RecloudQueryError(code, "fixture error");
      },
    };
    const { server, url } = await startServer(connector);
    t.after(() => server.close());

    const response = await fetch(`${url}/api/crm/repairs/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ logisticsNo: "TEST-SCAN-ERROR" }),
    });
    const result = await response.json();

    assert.equal(response.status, status);
    assert.equal(result.code, code);
    assert.match(result.message, new RegExp(message));
  });
}
