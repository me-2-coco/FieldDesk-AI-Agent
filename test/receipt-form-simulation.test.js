const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  classifyRecloudRequest,
  sanitizeRecloudRequestPath,
  simulateReceiptForm,
} = require("../connectors/recloud");
const { createApp } = require("../server");

function collection(items) {
  return {
    count: async () => items.length,
    filter() {
      return this;
    },
    first: () => items[0] || missingLocator(),
    last: () => items.at(-1) || missingLocator(),
    nth: (index) => items[index] || missingLocator(),
  };
}

function missingLocator() {
  return {
    count: async () => 0,
    isVisible: async () => false,
    first() {
      return this;
    },
    last() {
      return this;
    },
  };
}

function editableControl(initialValue, role, onFill = async () => {}) {
  let value = initialValue;
  const history = [];
  return {
    count: async () => 1,
    isVisible: async () => true,
    inputValue: async () => value,
    fill: async (nextValue) => {
      value = nextValue;
      history.push(nextValue);
      await onFill(nextValue);
    },
    getAttribute: async () => null,
    evaluate: async () => (role === "remark" ? "textarea" : "input"),
    history,
  };
}

function createSimulationPage(options = {}) {
  let actionClicks = 0;
  let escapePresses = 0;
  let confirmClicks = 0;
  let routeHandler = null;
  let abortedRequests = 0;
  let continuedRequests = 0;
  async function dispatchRequest(definition) {
    if (!routeHandler || !definition) return;
    await routeHandler({
      request: () => ({
        method: () => definition.method,
        resourceType: () => definition.resourceType,
        url: () => definition.url,
      }),
      abort: async () => {
        abortedRequests += 1;
      },
      continue: async () => {
        continuedRequests += 1;
      },
    });
  }
  const sn = editableControl(options.originalSn || "", "sn", async (value) => {
    if (value && options.snFillRequest) {
      await dispatchRequest(options.snFillRequest);
    }
  });
  const remark = editableControl(
    options.originalRemark || "",
    "remark",
    async (value) => {
      if (value && value !== options.originalRemark && options.remarkFillRequest) {
        await dispatchRequest(options.remarkFillRequest);
      }
    }
  );
  const confirm = {
    count: async () => 1,
    isVisible: async () => true,
    click: async () => {
      confirmClicks += 1;
    },
    getAttribute: async () => null,
    evaluate: async () => "button",
  };
  const action = {
    count: async () => 1,
    isVisible: async () => true,
    isEnabled: async () => true,
    boundingBox: async () => ({ x: 10, y: 10, width: 50, height: 20 }),
    scrollIntoViewIfNeeded: async () => {},
    click: async () => {
      actionClicks += 1;
    },
  };
  const row = {
    isVisible: async () => true,
    getByRole: () => action,
    getByText: () => collection([action]),
    locator: () => collection([action]),
  };
  action.locator = () => ({ first: () => row });
  const region = {
    isVisible: async () => true,
    getByText: () => collection([action]),
  };
  const marker = {
    isVisible: async () => true,
    locator: () => ({ first: () => region }),
  };
  const dialog = {
    count: async () => 1,
    isVisible: async () => true,
    getByLabel(pattern) {
      return { first: () => (String(pattern).includes("SN") ? sn : remark) };
    },
    getByRole() {
      return { last: () => confirm };
    },
    getByText() {
      return collection([confirm]);
    },
    locator(selector) {
      if (selector === "input:visible, textarea:visible") {
        return collection([sn, remark]);
      }
      if (selector === "textarea:visible") return { first: () => remark };
      if (
        selector.includes("[contenteditable") ||
        selector.includes("input[placeholder")
      ) {
        return collection([sn, remark]);
      }
      if (selector.includes("SN") || selector.includes("序列号")) {
        return { first: () => sn };
      }
      if (selector.includes("备注") || selector.includes("说明")) {
        return { first: () => remark };
      }
      return collection([]);
    },
  };
  const page = {
    url: () => "https://crm2.recloud.com.cn/rma/detail",
    getByText: () => ({
      filter: () => ({ first: () => marker }),
    }),
    locator: () => collection(actionClicks > 0 ? [dialog] : []),
    waitForTimeout: async () => {},
    route: async (pattern, handler) => {
      assert.equal(pattern, "**/*");
      routeHandler = handler;
    },
    unroute: async (pattern, handler) => {
      assert.equal(pattern, "**/*");
      if (routeHandler === handler) routeHandler = null;
    },
    keyboard: {
      press: async (key) => {
        assert.equal(key, "Escape");
        escapePresses += 1;
      },
    },
  };
  return {
    page,
    sn,
    remark,
    get actionClicks() {
      return actionClicks;
    },
    get escapePresses() {
      return escapePresses;
    },
    get confirmClicks() {
      return confirmClicks;
    },
    get abortedRequests() {
      return abortedRequests;
    },
    get continuedRequests() {
      return continuedRequests;
    },
    get networkGuardActive() {
      return routeHandler !== null;
    },
  };
}

test("sanitized receipt fixture contains only synthetic form structure", () => {
  const fixture = fs.readFileSync(
    path.join(__dirname, "fixtures", "recloud-receipt-form-sanitized.html"),
    "utf8"
  );
  assert.match(fixture, /RMA明细/);
  assert.match(fixture, /请输入SN/);
  assert.match(fixture, /请输入备注/);
  assert.doesNotMatch(fixture, /1[3-9]\d{9}|JXTH\d+|SF\d{10,}/);
});

test("sanitized network fixture classifies known reads and mutation paths", () => {
  const fixture = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "fixtures", "recloud-network-requests-sanitized.json"),
      "utf8"
    )
  );
  for (const item of fixture) {
    const result = classifyRecloudRequest({
      method: () => item.method,
      resourceType: () => item.resourceType,
      url: () => item.url,
    });
    assert.equal(result.kind, item.expected, item.name);
    assert.equal(result.descriptor.path.includes("?"), false);
  }
});

test("request paths remove query strings and redact identifier segments", () => {
  const pathName = sanitizeRecloudRequestPath(
    "https://crm2.recloud.com.cn/api/rma/detail/123456789?token=secret"
  );
  assert.equal(pathName, "/api/rma/detail/:redacted");
  assert.equal(pathName.includes("token"), false);
  assert.equal(pathName.includes("123456789"), false);
});

test("simulation fills, verifies, clears SN, restores remark and closes", async () => {
  const fixture = createSimulationPage({ originalRemark: "原测试备注" });
  const logs = [];
  const result = await simulateReceiptForm(
    fixture.page,
    "TEST-SN-001",
    "测试品类",
    {
      dryRun: true,
      writeEnabled: false,
      logger: {
        info: (message) => logs.push(message),
        warn: (message) => logs.push(message),
      },
    }
  );

  assert.deepEqual(result, {
    receiptEntryClicked: true,
    dialogOpened: true,
    snFilled: true,
    remarkFilled: true,
    valuesVerified: true,
    snCleared: true,
    remarkRestored: true,
    dialogClosed: true,
    confirmClicked: false,
    networkGuardEnabled: true,
    mutationRequestDetected: false,
    blockedRequestCount: 0,
    blockedMethods: [],
    readRequestCount: 0,
    blockedRequests: [],
    readRequests: [],
    missingFields: [],
    errorCode: null,
  });
  assert.deepEqual(fixture.sn.history, ["TEST-SN-001", ""]);
  assert.deepEqual(fixture.remark.history, ["测试品类", "原测试备注"]);
  assert.equal(fixture.confirmClicks, 0);
  assert.equal(fixture.escapePresses, 1);
  assert.equal(fixture.networkGuardActive, false);
  assert.equal(logs.some((line) => line.includes("TEST-SN-001")), false);
  assert.equal(logs.some((line) => line.includes("测试品类")), false);
});

test("known POST query remains allowed and is counted as a read request", async () => {
  const fixture = createSimulationPage({
    snFillRequest: {
      method: "POST",
      resourceType: "xhr",
      url: "https://crm2.recloud.com.cn/api/rma/query",
    },
  });
  const result = await simulateReceiptForm(fixture.page, "TEST-SN-READ", "扫地机", {
    dryRun: true,
    writeEnabled: false,
    logger: { info() {}, warn() {} },
  });

  assert.equal(result.mutationRequestDetected, false);
  assert.equal(result.readRequestCount, 1);
  assert.deepEqual(result.readRequests, [
    { method: "POST", path: "/api/rma/query" },
  ]);
  assert.equal(fixture.continuedRequests, 1);
  assert.equal(fixture.abortedRequests, 0);
});

test("unexpected mutation is blocked, cleaned up and returned without secrets", async () => {
  const fixture = createSimulationPage({
    originalRemark: "原测试备注",
    snFillRequest: {
      method: "POST",
      resourceType: "xhr",
      url: "https://crm2.recloud.com.cn/api/rma/receipt/save?sn=SECRET-SN",
    },
  });

  await assert.rejects(
    simulateReceiptForm(fixture.page, "SECRET-SN", "秘密备注", {
      dryRun: true,
      writeEnabled: false,
      logger: { info() {}, warn() {} },
    }),
    (error) => {
      assert.equal(error.code, "RECLOUD_UNEXPECTED_WRITE_REQUEST");
      assert.equal(error.simulation.mutationRequestDetected, true);
      assert.equal(error.simulation.blockedRequestCount, 1);
      assert.deepEqual(error.simulation.blockedRequests, [
        { method: "POST", path: "/api/rma/receipt/save" },
      ]);
      assert.equal(error.simulation.snCleared, true);
      assert.equal(error.simulation.remarkRestored, true);
      assert.equal(error.simulation.dialogClosed, true);
      assert.equal(error.simulation.confirmClicked, false);
      assert.equal(JSON.stringify(error.simulation).includes("SECRET-SN"), false);
      assert.equal(JSON.stringify(error.simulation).includes("秘密备注"), false);
      return true;
    }
  );
  assert.equal(fixture.abortedRequests, 1);
  assert.equal(fixture.continuedRequests, 0);
  assert.equal(fixture.confirmClicks, 0);
  assert.equal(fixture.networkGuardActive, false);
});

test("all non-query mutation methods are aborted before network continuation", async () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const result = classifyRecloudRequest({
      method: () => method,
      resourceType: () => "document",
      url: () => "https://crm2.recloud.com.cn/api/unknown/action",
    });
    assert.equal(result.kind, "mutation", method);
  }
  const getResult = classifyRecloudRequest({
    method: () => "GET",
    resourceType: () => "script",
    url: () => "https://crm2.recloud.com.cn/assets/application.js",
  });
  assert.equal(getResult.kind, "read");
});

test("blocked request handler never invokes the network continuation", async () => {
  const fixture = createSimulationPage({
    snFillRequest: {
      method: "PATCH",
      resourceType: "fetch",
      url: "https://crm2.recloud.com.cn/api/rma/update",
    },
  });

  await assert.rejects(
    simulateReceiptForm(fixture.page, "NETWORK-BARRIER-SN", "测试备注", {
      dryRun: true,
      writeEnabled: false,
      logger: { info() {}, warn() {} },
    }),
    (error) => {
      assert.equal(error.code, "RECLOUD_UNEXPECTED_WRITE_REQUEST");
      assert.deepEqual(error.simulation.blockedMethods, ["PATCH"]);
      assert.equal(error.simulation.confirmClicked, false);
      return true;
    }
  );
  assert.equal(fixture.abortedRequests, 1);
  assert.equal(fixture.continuedRequests, 0);
});

test("simulation restores an originally empty remark", async () => {
  const fixture = createSimulationPage({ originalRemark: "" });
  const result = await simulateReceiptForm(fixture.page, "TEST-SN-002", "洗地机", {
    dryRun: true,
    writeEnabled: false,
    logger: { info() {}, warn() {} },
  });

  assert.equal(result.remarkRestored, true);
  assert.deepEqual(fixture.remark.history, ["洗地机", ""]);
  assert.equal(fixture.confirmClicks, 0);
});

test("simulation refuses unsafe switches before opening Recloud form", async () => {
  const fixture = createSimulationPage();
  await assert.rejects(
    simulateReceiptForm(fixture.page, "TEST-SN-003", "扫地机", {
      dryRun: false,
      writeEnabled: false,
    }),
    (error) => error.code === "RECLOUD_RECEIPT_SIMULATION_UNSAFE"
  );
  assert.equal(fixture.actionClicks, 0);
});

test("simulate API only permits the backend-configured test logistics number", async (t) => {
  const calls = [];
  const connector = {
    openRecloud: async () => ({ page: {} }),
    queryRmaByLogisticsNo: async () => calls.push("query"),
    simulateReceiptForm: async () => calls.push("simulate"),
  };
  const previous = {
    dryRun: process.env.DRY_RUN,
    write: process.env.RECLOUD_WRITE_ENABLED,
    testOrder: process.env.RECLOUD_RECEIPT_TEST_LOGISTICS_NO,
  };
  process.env.DRY_RUN = "true";
  process.env.RECLOUD_WRITE_ENABLED = "false";
  process.env.RECLOUD_RECEIPT_TEST_LOGISTICS_NO = "TEST-ONLY-ORDER";
  t.after(() => {
    for (const [key, value] of Object.entries({
      DRY_RUN: previous.dryRun,
      RECLOUD_WRITE_ENABLED: previous.write,
      RECLOUD_RECEIPT_TEST_LOGISTICS_NO: previous.testOrder,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const server = createApp(connector).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => server.close());

  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/api/crm/repairs/receipt-form/simulate`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        logisticsNo: "NOT-THE-TEST-ORDER",
        sn: "TEST-SN-004",
        remark: "扫地机",
      }),
    }
  );
  const result = await response.json();

  assert.equal(response.status, 403);
  assert.equal(result.code, "RECLOUD_RECEIPT_TEST_ORDER_REQUIRED");
  assert.deepEqual(calls, []);
});

test("simulate API queries then simulates without invoking a Recloud write", async (t) => {
  const calls = [];
  const connector = {
    openRecloud: async () => ({ page: {} }),
    queryRmaByLogisticsNo: async () => calls.push("query"),
    simulateReceiptForm: async (page, sn, remark, options) => {
      calls.push(["simulate", options.dryRun, options.writeEnabled]);
      return {
        receiptEntryClicked: true,
        dialogOpened: true,
        snFilled: true,
        remarkFilled: true,
        valuesVerified: true,
        snCleared: true,
        remarkRestored: true,
        dialogClosed: true,
        confirmClicked: false,
        networkGuardEnabled: true,
        mutationRequestDetected: false,
        blockedRequestCount: 0,
        blockedMethods: [],
        readRequestCount: 0,
        blockedRequests: [],
        readRequests: [],
        missingFields: [],
        errorCode: null,
      };
    },
    confirmSign: async () => assert.fail("must never confirm receipt"),
  };
  const previous = {
    dryRun: process.env.DRY_RUN,
    write: process.env.RECLOUD_WRITE_ENABLED,
    testOrder: process.env.RECLOUD_RECEIPT_TEST_LOGISTICS_NO,
  };
  process.env.DRY_RUN = "true";
  process.env.RECLOUD_WRITE_ENABLED = "false";
  process.env.RECLOUD_RECEIPT_TEST_LOGISTICS_NO = "TEST-ONLY-ORDER";
  t.after(() => {
    for (const [key, value] of Object.entries({
      DRY_RUN: previous.dryRun,
      RECLOUD_WRITE_ENABLED: previous.write,
      RECLOUD_RECEIPT_TEST_LOGISTICS_NO: previous.testOrder,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const server = createApp(connector).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => server.close());

  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/api/crm/repairs/receipt-form/simulate`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        logisticsNo: "TEST-ONLY-ORDER",
        sn: "TEST-SN-005",
        remark: "扫地机",
      }),
    }
  );
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.data.confirmClicked, false);
  assert.deepEqual(calls, [
    "query",
    ["simulate", true, false],
  ]);
});
