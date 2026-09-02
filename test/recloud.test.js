const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  LOGISTICS_INPUT_PLACEHOLDER,
  RECLOUD_URL,
  collectRtxpcFormItemPairs,
  createPhoneResponseListener,
  ensureScanPage,
  enterRmaQuery,
  findRevealedPhone,
  findFeedbackPhoneRevealButton,
  getSelectAllShortcut,
  isRecloudLoginPage,
  isRevealPhoneEnabled,
  parseRmaDateTime,
  parseRepairDetail,
  revealFeedbackPhone,
  readProductLine,
  selectMatchingPhone,
  selectCellByHeaderCoordinate,
  waitForRmaDetail,
} = require("../connectors/recloud");
const {
  RecloudQueryError,
  extractRmaNoFromTitle,
  parseRmaDetailHtml,
  parseRmaFieldPairs,
  extractProductLineFromHtml,
  selectProductLine,
} = require("../connectors/recloud-rma-parser");
const {
  collectSafeFieldTitles,
  isDomDiagnosticsEnabled,
  logSafeFieldTitles,
  sanitizeFieldTitles,
} = require("../connectors/recloud-dom-diagnostics");
const { isCrmQueryUrl } = require("../init-recloud-login");
const {
  createApp,
  isDryRun,
  isRecloudWriteEnabled,
} = require("../server");

function locatorList(elements = []) {
  return {
    count: async () => elements.length,
    nth: (index) => elements[index],
    first: () => elements[0],
    allInnerTexts: async () =>
      Promise.all(elements.map((element) => element.innerText())),
  };
}

function visibleTextElement(text, box = null) {
  return {
    isVisible: async () => true,
    innerText: async () => text,
    boundingBox: async () => box,
    getAttribute: async () => null,
  };
}

const fixturePath = path.join(
  __dirname,
  "fixtures",
  "recloud-rma-detail.html"
);
const formFixturePath = path.join(
  __dirname,
  "fixtures",
  "recloud-rma-form-detail.html"
);
const realUserFieldsFixturePath = path.join(
  __dirname,
  "fixtures",
  "recloud-rma-real-user-fields.html"
);

async function startServer(connector) {
  const server = createApp(connector).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  return {
    server,
    url: `http://127.0.0.1:${server.address().port}`,
  };
}

test("RMA number exposes its encoded Shanghai creation date for pending backfill", () => {
  assert.equal(
    new Date(parseRmaDateTime("JXTH202608311002")).toISOString(),
    "2026-08-30T16:00:00.000Z"
  );
  assert.equal(Number.isNaN(parseRmaDateTime("INVALID")), true);
});

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
    productLine: "",
    readOnly: true,
  });
});

test("parser rejects missing fields as a Recloud schema change", () => {
  let capturedError;
  assert.throws(
    () =>
      parseRmaDetailHtml(
        "<table><tr><th>寄修单号</th><td>RMA-TEST-0002</td></tr></table>",
        "TEST-SCAN-0002"
      ),
    (error) => {
      capturedError = error;
      return (
        error.code === "RECLOUD_SCHEMA_CHANGED" &&
        error.message.includes("reportedFault")
      );
    }
  );

  assert.deepEqual(capturedError.missingFields, [
    "reportedFault",
    "pickupLogisticsNo",
  ]);
  assert.equal(
    JSON.stringify(capturedError.missingFields),
    '["reportedFault","pickupLogisticsNo"]'
  );
});

test("parser extracts JXTH number from RMA page title and accepts 描述", () => {
  const html = `
    <main>
      <h1>RMA | JXTH9000000001</h1>
      <dl>
        <dt>用户姓名</dt><dd>测试用户丙</dd>
        <dt>用户手机号</dt><dd>136****0000</dd>
        <dt>所在地区/地址</dt><dd>测试省测试市测试区</dd>
        <dt>描述</dt><dd>测试设备无法启动</dd>
        <dt>取件物流单号</dt><dd>TEST-PICKUP-TITLE</dd>
      </dl>
    </main>
  `;

  assert.equal(extractRmaNoFromTitle("RMA | JXTH9000000001"), "JXTH9000000001");
  assert.deepEqual(parseRmaDetailHtml(html, "TEST-SCAN-TITLE"), {
    logisticsNo: "TEST-SCAN-TITLE",
    rmaNo: "JXTH9000000001",
    customer: {
      name: "测试用户丙",
      phoneMasked: "136****0000",
      regionAddress: "测试省测试市测试区",
    },
    reportedFault: "测试设备无法启动",
    pickupLogisticsNo: "TEST-PICKUP-TITLE",
    productLine: "",
    readOnly: true,
  });
});

test("parser masks a complete customer phone number before returning it", () => {
  const html = fs
    .readFileSync(fixturePath, "utf8")
    .replace("139****0000", "13900000000");

  const detail = parseRmaDetailHtml(html, "TEST-SCAN-0003");
  assert.equal(detail.customer.phoneMasked, "139****0000");
  assert.doesNotMatch(JSON.stringify(detail), /13900000000/);
});

test("parser preserves an already masked customer phone number", () => {
  const html = fs.readFileSync(fixturePath, "utf8");
  const detail = parseRmaDetailHtml(html, "TEST-SCAN-MASKED");

  assert.equal(detail.customer.phoneMasked, "139****0000");
});

test("empty customer fields remain optional and return empty strings", () => {
  const html = `
    <main>
      <h1>RMA | JXTH9000000031</h1>
      <dl>
        <dt>描述</dt><dd>测试必需描述</dd>
        <dt>取件物流单号</dt><dd>TEST-PICKUP-OPTIONAL</dd>
      </dl>
    </main>
  `;
  const detail = parseRmaDetailHtml(html, "TEST-SCAN-OPTIONAL");

  assert.deepEqual(detail.customer, {
    name: "",
    phoneMasked: "",
    regionAddress: "",
  });
});

test("runtime form reader prefers visible feedback-phone inputValue", async () => {
  let contentRead = false;
  const label = { innerText: async () => "反馈电话" };
  const control = {
    isVisible: async () => true,
    inputValue: async () => "13200000000",
  };
  const content = {
    async innerText() {
      contentRead = true;
      return "不应读取的内容文本";
    },
  };
  const item = {
    async getAttribute(name) {
      return name === "fieldTitle" ? "反馈电话" : null;
    },
    locator(selector) {
      if (selector.includes("form-item__label")) return { first: () => label };
      if (selector === "input:visible, textarea:visible") {
        return { first: () => control };
      }
      if (selector === ".rtxpc-form-item__content") {
        return { first: () => content };
      }
      assert.fail(`unexpected item selector: ${selector}`);
    },
    innerText: async () => "",
  };
  const items = {
    count: async () => 1,
    nth: () => item,
  };
  const page = {
    locator(selector) {
      assert.equal(selector, ".rtxpc-form-item");
      return items;
    },
  };

  const pairs = await collectRtxpcFormItemPairs(page);

  assert.deepEqual(pairs, [["反馈电话", "13200000000"]]);
  assert.equal(contentRead, false);
});

function createRevealButton({ visible = true, onClick = () => {} } = {}) {
  return {
    isVisible: async () => visible,
    click: async () => onClick(),
  };
}

function createPhoneRevealItem(button) {
  const invisible = { isVisible: async () => false };
  const emptyCandidates = { count: async () => 0 };
  return {
    locator(selector) {
      if (selector.includes('button[title="显示数据"]')) {
        return { first: () => button || invisible };
      }
      if (selector.includes("button:visible")) {
        return emptyCandidates;
      }
      assert.fail(`unexpected reveal selector: ${selector}`);
    },
  };
}

test("phone reveal switch is disabled by default", async () => {
  let clicked = false;
  const button = createRevealButton({ onClick: () => { clicked = true; } });
  const item = createPhoneRevealItem(button);
  const control = {
    isVisible: async () => true,
    inputValue: async () => "131****0000",
  };

  assert.equal(isRevealPhoneEnabled({}), false);
  assert.equal(
    isRevealPhoneEnabled({ RECLOUD_REVEAL_PHONE_ENABLED: "false" }),
    false
  );
  const value = await revealFeedbackPhone(item, {}, control, {
    enabled: false,
  });

  assert.equal(value, "131****0000");
  assert.equal(clicked, false);
});

test("phone reveal returns the complete number after the scoped button succeeds", async () => {
  let revealed = false;
  const completePhone = ["138", "0000", "0041"].join("");
  const button = createRevealButton({ onClick: () => { revealed = true; } });
  const item = createPhoneRevealItem(button);
  const control = {
    isVisible: async () => true,
    inputValue: async () => revealed ? completePhone : "138****0041",
  };
  const page = { waitForTimeout: async () => {} };
  const logs = [];

  const value = await revealFeedbackPhone(item, page, control, {
    enabled: true,
    timeout: 20,
    pollInterval: 1,
    logger: { info: (message) => logs.push(message) },
  });

  assert.equal(value, completePhone);
  assert.deepEqual(logs, [
    "RECLOUD_PHONE_REVEAL: field_found",
    "RECLOUD_PHONE_REVEAL: control_found",
    "RECLOUD_PHONE_REVEAL: clicked",
    "RECLOUD_PHONE_REVEAL: full_value_ready",
  ]);
  assert.doesNotMatch(logs.join("\n"), /138|0041/);
});

test("phone reveal falls back to masked value when button is absent", async () => {
  const item = createPhoneRevealItem(null);
  const control = {
    isVisible: async () => true,
    inputValue: async () => "137****0042",
  };
  const logs = [];

  const value = await revealFeedbackPhone(item, {}, control, {
    enabled: true,
    logger: { info: (message) => logs.push(message) },
  });

  assert.equal(value, "137****0042");
  assert.match(logs.at(-1), /BUTTON_NOT_FOUND/);
});

test("phone reveal timeout falls back to masked value", async () => {
  let clickCount = 0;
  let responseListener = null;
  let removedListener = null;
  const button = createRevealButton({ onClick: () => { clickCount += 1; } });
  const item = createPhoneRevealItem(button);
  const control = {
    isVisible: async () => true,
    inputValue: async () => "136****0043",
  };
  const page = {
    on(event, listener) {
      assert.equal(event, "response");
      responseListener = listener;
    },
    off(event, listener) {
      assert.equal(event, "response");
      removedListener = listener;
      responseListener = null;
    },
    async waitForTimeout() {
      await new Promise((resolve) => setTimeout(resolve, 10));
    },
  };

  const value = await revealFeedbackPhone(item, page, control, {
    enabled: true,
    timeout: 5,
    pollInterval: 1,
    logger: { info() {} },
  });

  assert.equal(value, "136****0043");
  assert.equal(clickCount, 1);
  assert.equal(responseListener, null);
  assert.equal(typeof removedListener, "function");
});

function createNetworkPage() {
  const listeners = new Set();
  return {
    on(event, listener) {
      assert.equal(event, "response");
      listeners.add(listener);
    },
    off(event, listener) {
      assert.equal(event, "response");
      listeners.delete(listener);
    },
    emitResponse(response) {
      for (const listener of [...listeners]) listener(response);
    },
    listenerCount: () => listeners.size,
  };
}

function createJsonResponse(payload, resourceType = "xhr") {
  return {
    request: () => ({ resourceType: () => resourceType }),
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

test("phone response listener reads a complete number from XHR JSON", async () => {
  const page = createNetworkPage();
  const completePhone = ["138", "2222", "0061"].join("");
  const listener = createPhoneResponseListener(page, "138****0061");

  page.emitResponse(createJsonResponse({ phone: completePhone }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(listener.getPhone(), completePhone);
  assert.equal(page.listenerCount(), 0);
  listener.stop();
});

test("phone response listener searches nested JSON fields", async () => {
  const page = createNetworkPage();
  const completePhone = ["139", "3333", "0062"].join("");
  const listener = createPhoneResponseListener(page, "139****0062");

  page.emitResponse(createJsonResponse({
    result: { customer: { contact: completePhone } },
  }, "fetch"));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(listener.getPhone(), completePhone);
  listener.stop();
});

test("phone response listener filters unrelated mobile numbers", async () => {
  const page = createNetworkPage();
  const expected = ["137", "4444", "0063"].join("");
  const listener = createPhoneResponseListener(page, "137****0063");

  page.emitResponse(createJsonResponse({
    ownerPhone: ["136", "5555", "9999"].join(""),
    customerPhone: expected,
  }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(listener.getPhone(), expected);
  listener.stop();
});

function createPhoneSurface({
  inputValues = [],
  componentValues = [],
  fragments = [],
  innerText = "",
  textContent = "",
  overlays = [],
}) {
  const item = {
    innerText: async () => innerText,
    textContent: async () => textContent,
    locator(selector) {
      if (selector === "input, textarea") {
        return locatorList(inputValues.map((value) => ({
          inputValue: async () => value,
          getAttribute: async () => value,
        })));
      }
      if (selector.includes(".plat-mask-input[value]")) {
        return locatorList(componentValues.map((value) => ({
          getAttribute: async (name) => name === "value" ? value : null,
        })));
      }
      if (selector === "span:visible, div:visible") {
        return locatorList(
          fragments.map((text) => visibleTextElement(text))
        );
      }
      return locatorList([]);
    },
  };
  const page = {
    locator: () =>
      locatorList(overlays.map((entry) =>
        typeof entry === "string"
          ? visibleTextElement(entry)
          : {
              ...visibleTextElement(entry.text, entry.box),
              getAttribute: async (name) =>
                name === "id" ? entry.id || null : null,
            }
      )),
  };
  return { item, page };
}

test("phone reveal combines a complete number split across spans", async () => {
  const completePhone = ["133", "0000", "0051"].join("");
  const { item, page } = createPhoneSurface({
    fragments: ["133", "0000", "0051"],
  });

  assert.equal(
    await findRevealedPhone(item, page, {
      inputValue: async () => "133****0051",
    }, { maskedValue: "133****0051" }),
    completePhone
  );
});

test("phone reveal removes spaces and newlines before matching", async () => {
  const completePhone = ["151", "0000", "0052"].join("");
  const { item, page } = createPhoneSurface({
    innerText: "151 0000\n0052",
  });

  assert.equal(
    await findRevealedPhone(item, page, {
      inputValue: async () => "151****0052",
    }, { maskedValue: "151****0052" }),
    completePhone
  );
});

test("phone reveal reads a complete number from an input value", async () => {
  const completePhone = ["189", "0000", "0053"].join("");
  const { item, page } = createPhoneSurface({
    inputValues: [completePhone],
  });

  assert.equal(
    await findRevealedPhone(item, page, {
      inputValue: async () => "189****0053",
    }, { maskedValue: "189****0053" }),
    completePhone
  );
});

test("phone reveal reads Recloud plat-mask wrapper value", async () => {
  const completePhone = ["186", "1234", "0058"].join("");
  const { item, page } = createPhoneSurface({
    inputValues: ["186****0058"],
    componentValues: [completePhone],
  });

  assert.equal(
    await findRevealedPhone(item, page, {
      inputValue: async () => "186****0058",
    }, { maskedValue: "186****0058" }),
    completePhone
  );
});

test("phone reveal reads a matching number from a newly visible overlay", async () => {
  const completePhone = ["188", "0000", "0054"].join("");
  const { item, page } = createPhoneSurface({
    overlays: [
      "existing unrelated overlay",
      {
        text: `188 0000 ${"0054"}`,
        box: { x: 130, y: 100, width: 150, height: 40 },
      },
    ],
  });

  assert.equal(
    await findRevealedPhone(
      item,
      page,
      { inputValue: async () => "188****0054" },
      {
        maskedValue: "188****0054",
        overlayBaselineCount: 1,
        buttonBox: { x: 100, y: 100, width: 20, height: 20 },
      }
    ),
    completePhone
  );
});

test("dates and logistics numbers outside the masked signature are rejected", () => {
  assert.equal(
    selectMatchingPhone(
      ["2026-07-29", "物流号 13912345678"],
      "133****0055"
    ),
    ""
  );
});

test("multiple phone candidates require masked prefix and suffix agreement", () => {
  const expected = ["137", "1111", "0056"].join("");
  assert.equal(
    selectMatchingPhone(
      [
        ["136", "2222", "0056"].join(" "),
        ["137", "1111", "0056"].join("\n"),
      ],
      "137****0056"
    ),
    expected
  );
});

function createReplacementPhoneItem(phone, source = "property") {
  const label = { innerText: async () => "反馈电话" };
  const control = {
    inputValue: async () => "",
    evaluate: async () => source === "property" ? phone : "",
    getAttribute: async (name) =>
      source === "attribute" && name === "value" ? phone : null,
  };
  return {
    getAttribute: async (name) =>
      name === "fieldTitle" ? "反馈电话" : null,
    innerText: async () => "",
    textContent: async () => "",
    locator(selector) {
      if (selector.includes("form-item__label")) {
        return { first: () => label };
      }
      if (selector === "input, textarea") return locatorList([control]);
      if (selector === "span:visible, div:visible") return locatorList([]);
      return locatorList([]);
    },
  };
}

test("phone DOM reader relocates a React-replaced feedback field", async () => {
  const completePhone = ["135", "6666", "0064"].join("");
  const replacement = createReplacementPhoneItem(completePhone);
  const staleItem = createReplacementPhoneItem("");
  const page = {
    locator(selector) {
      if (selector === ".rtxpc-form-item") {
        return locatorList([replacement]);
      }
      if (selector === "input, textarea") return locatorList([]);
      return locatorList([]);
    },
  };

  assert.equal(
    await findRevealedPhone(
      staleItem,
      page,
      { inputValue: async () => "135****0064" },
      { maskedValue: "135****0064" }
    ),
    completePhone
  );
});

test("phone DOM reader checks value attributes and DOM properties", async () => {
  const propertyPhone = ["150", "7777", "0065"].join("");
  const attributePhone = ["158", "8888", "0066"].join("");
  const emptyPage = { locator: () => locatorList([]) };

  assert.equal(
    await findRevealedPhone(
      createReplacementPhoneItem(propertyPhone, "property"),
      emptyPage,
      { inputValue: async () => "150****0065" },
      { maskedValue: "150****0065" }
    ),
    propertyPhone
  );
  assert.equal(
    await findRevealedPhone(
      createReplacementPhoneItem(attributePhone, "attribute"),
      emptyPage,
      { inputValue: async () => "158****0066" },
      { maskedValue: "158****0066" }
    ),
    attributePhone
  );
});

test("network success removes its listener without exposing response data", async () => {
  const page = createNetworkPage();
  page.locator = () => locatorList([]);
  page.waitForTimeout = async () =>
    new Promise((resolve) => setImmediate(resolve));
  const completePhone = ["187", "9999", "0067"].join("");
  const responseMarker = "PRIVATE_RESPONSE_MARKER";
  const button = createRevealButton({
    onClick: () => page.emitResponse(createJsonResponse({
      marker: responseMarker,
      phone: completePhone,
    })),
  });
  const item = createPhoneRevealItem(button);
  const logs = [];

  const value = await revealFeedbackPhone(
    item,
    page,
    {
      isVisible: async () => true,
      inputValue: async () => "187****0067",
    },
    {
      enabled: true,
      timeout: 100,
      pollInterval: 1,
      logger: { info: (message) => logs.push(message) },
    }
  );

  assert.equal(value, completePhone);
  assert.equal(page.listenerCount(), 0);
  assert.equal(logs.at(-1), "RECLOUD_PHONE_REVEAL: full_value_ready");
  assert.doesNotMatch(logs.join("\n"), /187|0067|PRIVATE_RESPONSE_MARKER/);
});

test("form reader clicks a reveal button only inside the 反馈电话 item", async () => {
  const completePhone = ["139", "0000", "0045"].join("");
  let unrelatedClicks = 0;
  let phoneClicks = 0;

  function formItem(title, initialValue, onClick) {
    const button = createRevealButton({ onClick });
    const row = {
      isVisible: async () => true,
      locator(selector) {
        if (selector.includes('button[title="显示数据"]')) {
          return { first: () => button };
        }
        if (selector === 'button:visible, [role="button"]:visible') {
          return { count: async () => 0 };
        }
        assert.fail(`unexpected row selector: ${selector}`);
      },
    };
    const label = { innerText: async () => title };
    const control = {
      isVisible: async () => true,
      inputValue: async () =>
        title === "反馈电话" && phoneClicks > 0
          ? completePhone
          : initialValue,
    };
    return {
      getAttribute: async (name) => name === "fieldTitle" ? title : null,
      innerText: async () => "",
      locator(selector) {
        if (selector.startsWith("xpath=ancestor::")) {
          return { first: () => row };
        }
        if (selector.includes("form-item__label")) return { first: () => label };
        if (selector === "input:visible, textarea:visible") {
          return { first: () => control };
        }
        if (selector === ".rtxpc-form-item__content") {
          return { first: () => ({ innerText: async () => "" }) };
        }
        assert.fail(`unexpected scoped selector: ${selector}`);
      },
    };
  }

  const itemsList = [
    formItem("其他敏感字段", "其他值", () => { unrelatedClicks += 1; }),
    formItem("反馈电话", "139****0045", () => { phoneClicks += 1; }),
  ];
  const page = {
    locator(selector) {
      assert.equal(selector, ".rtxpc-form-item");
      return {
        count: async () => itemsList.length,
        nth: (index) => itemsList[index],
      };
    },
    waitForTimeout: async () => {},
  };

  const pairs = await collectRtxpcFormItemPairs(page, {
    revealPhoneEnabled: true,
    phoneRevealTimeout: 20,
    phoneRevealPollInterval: 1,
    phoneRevealLogger: { info() {} },
  });

  assert.deepEqual(pairs, [
    ["其他敏感字段", "其他值"],
    ["反馈电话", completePhone],
  ]);
  assert.equal(unrelatedClicks, 0);
  assert.equal(phoneClicks, 1);
});

test("phone reveal identifies the adjacent row icon by its tooltip", async () => {
  let hovered = false;
  let clicked = false;
  const invisible = { isVisible: async () => false };
  const candidate = {
    innerText: async () => "",
    boundingBox: async () => ({ x: 260, y: 10, width: 20, height: 20 }),
    hover: async () => { hovered = true; },
    click: async () => { clicked = true; },
  };
  const candidates = {
    count: async () => 1,
    nth: () => candidate,
  };
  const row = {
    isVisible: async () => true,
    locator(selector) {
      if (selector.includes('button[title="显示数据"]')) {
        return { first: () => invisible };
      }
      return candidates;
    },
  };
  const item = {
    boundingBox: async () => ({ x: 20, y: 10, width: 220, height: 40 }),
    locator(selector) {
      assert.ok(selector.startsWith("xpath=ancestor::"));
      return { first: () => row };
    },
  };
  const tooltip = { isVisible: async () => hovered };
  const page = {
    getByText(text, options) {
      assert.equal(text, "显示数据");
      assert.deepEqual(options, { exact: true });
      return {
        filter(filterOptions) {
          assert.deepEqual(filterOptions, { visible: true });
          return { first: () => tooltip };
        },
      };
    },
  };

  const trigger = await findFeedbackPhoneRevealButton(item, page);
  await trigger.click();

  assert.equal(trigger, candidate);
  assert.equal(clicked, true);
});

test("full phone is returned only when parsing explicitly allows reveal", () => {
  const completePhone = ["135", "0000", "0044"].join("");
  const pairs = [
    ["寄修单号", "JXTH9000000044"],
    ["反馈电话", completePhone],
    ["描述", "测试显示完整电话"],
    ["取件物流单号", "TEST-PICKUP-0044"],
  ];

  const masked = parseRmaFieldPairs(pairs, "TEST-SCAN-0044");
  const revealed = parseRmaFieldPairs(pairs, "TEST-SCAN-0044", {
    allowFullPhone: true,
  });

  assert.equal(masked.customer.phoneMasked, "135****0044");
  assert.equal(revealed.customer.phoneMasked, completePhone);
});

test("RMA detail parsing preserves the current Recloud project code", () => {
  const detail = parseRmaFieldPairs([
    ["寄修单号", "JXTH9000000045"],
    ["描述", "测试项目号读取"],
    ["取件物流单号", "TEST-PICKUP-0045"],
  ], "TEST-SCAN-0045", {
    projectCode: "W2458T",
  });

  assert.equal(detail.projectCode, "W2458T");
});

test("pending-list enrichment keeps the project number in the returned RMA detail", async () => {
  const source = await fs.promises.readFile(
    path.join(__dirname, "../connectors/recloud.js"),
    "utf8"
  );

  assert.match(
    source,
    /projectCode: detail\.projectCode \|\| row\?\.\["项目号"\] \|\| ""/
  );
});

test("product-line parser prefers the row whose operation is 签收", () => {
  const html = `
    <table>
      <thead><tr><th>产品线</th><th>操作</th></tr></thead>
      <tbody>
        <tr><td>测试已处理产品线</td><td>查看</td></tr>
        <tr><td>测试待处理产品线</td><td>签收</td></tr>
      </tbody>
    </table>
  `;

  assert.equal(
    extractProductLineFromHtml(html),
    "测试待处理产品线"
  );
});

test("ambiguous product rows use the first candidate and log no business data", () => {
  const logs = [];
  const productLine = selectProductLine(
    ["产品线", "操作"],
    [
      ["测试第一产品线", "签收"],
      ["测试第二产品线", "签收"],
    ],
    { warn: (message) => logs.push(message) }
  );

  assert.equal(productLine, "测试第一产品线");
  assert.deepEqual(logs, [
    "RECLOUD_PRODUCT_LINE: ambiguous_rows_using_first",
  ]);
  assert.doesNotMatch(logs.join("\n"), /测试第一|测试第二/);
});

test("coordinate matching reads the div-grid cell under 产品线", () => {
  assert.equal(
    selectCellByHeaderCoordinate(
      { x: 200, width: 100 },
      [
        { text: "测试型号", box: { x: 100, width: 90 } },
        { text: "洗地机", box: { x: 200, width: 100 } },
        { text: "签收", box: { x: 310, width: 80 } },
      ]
    ),
    "洗地机"
  );
});

test("product-line reader supports an RMA detail div grid by coordinates", async () => {
  const header = {
    isVisible: async () => true,
    boundingBox: async () => ({ x: 200, width: 100 }),
  };
  const cells = locatorList([
    visibleTextElement("测试型号", { x: 100, width: 90 }),
    visibleTextElement("洗地机", { x: 200, width: 100 }),
    visibleTextElement("签收", { x: 310, width: 80 }),
  ]);
  const row = {
    isVisible: async () => true,
    locator: () => cells,
  };
  const sign = {
    locator: () => ({ first: () => row }),
  };
  const textLocator = (element, count = 1) => ({
    filter: () => ({
      first: () => element,
      count: async () => count,
    }),
  });
  const region = {
    isVisible: async () => true,
    getByText(text) {
      return text === "产品线"
        ? textLocator(header)
        : textLocator(sign);
    },
    locator(selector) {
      if (selector.includes("columnheader")) {
        return { allInnerTexts: async () => [] };
      }
      return locatorList([]);
    },
  };
  const marker = {
    isVisible: async () => true,
    locator: () => ({ first: () => region }),
  };
  const page = {
    getByText: () => textLocator(marker),
  };
  const logs = [];

  const result = await readProductLine(page, {
    info: (message) => logs.push(message),
    warn: (message) => logs.push(message),
  });

  assert.equal(result, "洗地机");
  assert.deepEqual(logs, [
    "RECLOUD_PRODUCT_LINE: header_found",
    "RECLOUD_PRODUCT_LINE: target_row_found",
    "RECLOUD_PRODUCT_LINE: value_ready",
  ]);
  assert.doesNotMatch(logs.join("\n"), /洗地机|测试型号/);
});

test("product-line reader accepts one unique visible supported product when fixed rows are split", async () => {
  const visible = {
    isVisible: async () => true,
    scrollIntoViewIfNeeded: async () => {},
    boundingBox: async () => ({ x: 200, width: 100 }),
  };
  const missingRow = { count: async () => 0 };
  const sign = { locator: () => ({ first: () => missingRow }) };
  const textLocator = (element, count = 1) => ({
    filter: () => ({ first: () => element, count: async () => count }),
  });
  const page = {
    waitForTimeout: async () => {},
    getByText(text) {
      if (text === "RMA明细") {
        return textLocator({
          ...visible,
          locator: () => ({ first: () => ({ isVisible: async () => false }) }),
        });
      }
      if (text === "产品线") return textLocator(visible);
      if (text === "签收") return textLocator(sign);
      if (text === "洗地机") return textLocator(visible);
      return textLocator(visible, 0);
    },
  };
  const logs = [];

  const result = await readProductLine(page, {
    info: (message) => logs.push(message),
    warn: (message) => logs.push(message),
  });

  assert.equal(result, "洗地机");
  assert.ok(logs.includes("RECLOUD_PRODUCT_LINE: unique_visible_value"));
  assert.doesNotMatch(logs.join("\n"), /洗地机/);
});

test("product-line reader accepts one unique supported value from visible RMA region text", async () => {
  const visible = {
    isVisible: async () => true,
    scrollIntoViewIfNeeded: async () => {},
    boundingBox: async () => ({ x: 200, width: 100 }),
  };
  const missingRow = { count: async () => 0 };
  const sign = { locator: () => ({ first: () => missingRow }) };
  const textLocator = (element, count = 1) => ({
    filter: () => ({ first: () => element, count: async () => count }),
  });
  const page = {
    waitForTimeout: async () => {},
    locator: () => ({ innerText: async () => "产品线 洗地机 操作 签收" }),
    getByText(text) {
      if (text === "RMA明细") {
        return textLocator({
          ...visible,
          locator: () => ({ first: () => ({ isVisible: async () => false }) }),
        });
      }
      if (text === "产品线") return textLocator(visible);
      if (text === "签收") return textLocator(sign);
      return textLocator(visible, 0);
    },
  };
  const logs = [];

  const result = await readProductLine(page, {
    info: (message) => logs.push(message),
    warn: (message) => logs.push(message),
  });

  assert.equal(result, "洗地机");
  assert.ok(logs.includes("RECLOUD_PRODUCT_LINE: unique_region_text_value"));
  assert.doesNotMatch(logs.join("\n"), /洗地机/);
});

test("rtxpc form fixture parses aliases, masks phone, and combines address", () => {
  const html = fs.readFileSync(formFixturePath, "utf8");

  assert.deepEqual(parseRmaDetailHtml(html, "TEST-SCAN-FORM"), {
    logisticsNo: "TEST-SCAN-FORM",
    rmaNo: "JXTH9000000030",
    customer: {
      name: "测试联系人甲",
      phoneMasked: "134****0000",
      regionAddress: "测试省测试市测试区 示例路 30 号",
    },
    reportedFault: "测试设备无法完成清洁任务",
    pickupLogisticsNo: "TEST-PICKUP-FORM-0030",
    productLine: "测试产品线",
    readOnly: true,
  });
});

test("real Recloud user titles prioritize 客户 and parse 反馈电话 safely", () => {
  const html = fs.readFileSync(realUserFieldsFixturePath, "utf8");
  const detail = parseRmaDetailHtml(html, "TEST-SCAN-REAL-FIELDS");

  assert.deepEqual(detail, {
    logisticsNo: "TEST-SCAN-REAL-FIELDS",
    rmaNo: "JXTH9000000040",
    customer: {
      name: "测试客户优先",
      phoneMasked: "133****0040",
      regionAddress: "测试省测试市测试区示例路 40 号",
    },
    reportedFault: "测试设备清洁任务中断",
    pickupLogisticsNo: "TEST-PICKUP-REAL-0040",
    productLine: "",
    readOnly: true,
  });
  assert.doesNotMatch(
    JSON.stringify(detail),
    /测试反馈人|测试负责人|测试创建者|13300000040/
  );
});

test("反馈人 is used only when 客户 is empty", () => {
  const html = fs
    .readFileSync(realUserFieldsFixturePath, "utf8")
    .replace("测试客户优先", "");
  const detail = parseRmaDetailHtml(html, "TEST-SCAN-FALLBACK");

  assert.equal(detail.customer.name, "测试反馈人");
  assert.notEqual(detail.customer.name, "测试负责人不可作为客户");
  assert.notEqual(detail.customer.name, "测试创建者不可作为客户");
});

test("read-only query fills the exact scanner input and only presses Enter", async () => {
  const calls = [];
  const stageLogs = [];
  const input = {
    async isVisible() {
      calls.push(["isVisible"]);
      return true;
    },
    async click() {
      calls.push(["click"]);
    },
    async press(key) {
      calls.push(["input-press", key]);
    },
    async pressSequentially(value, options) {
      calls.push(["pressSequentially", value, options]);
    },
    async inputValue() {
      calls.push(["inputValue"]);
      return "TEST-SCAN-0004";
    },
  };
  const page = {
    url: () => "https://crm2.recloud.com.cn/example#/scanSignin/query",
    locator(selector) {
      calls.push(["locator", selector]);
      return { first: () => input };
    },
    async waitForTimeout(delay) {
      calls.push(["waitForTimeout", delay]);
    },
    keyboard: {
      async press(key) {
        calls.push(["keyboard-press", key]);
      },
    },
  };

  await enterRmaQuery(page, " TEST-SCAN-0004 ", {
    logger: {
      info(message) {
        stageLogs.push(message);
      },
    },
    platform: "darwin",
  });

  assert.deepEqual(calls, [
    [
      "locator",
      `input[placeholder*="${LOGISTICS_INPUT_PLACEHOLDER}"]`,
    ],
    ["isVisible"],
    ["click"],
    ["input-press", "Meta+A"],
    ["input-press", "Backspace"],
    ["pressSequentially", "TEST-SCAN-0004", { delay: 30 }],
    ["inputValue"],
    ["waitForTimeout", 300],
    ["keyboard-press", "Enter"],
  ]);
  assert.deepEqual(stageLogs, [
    "RECLOUD_STAGE: scan_page_ready",
    "RECLOUD_STAGE: scanner_input_typed",
    "RECLOUD_STAGE: logistics_filled",
    "RECLOUD_STAGE: enter_pressed",
    "RECLOUD_STAGE: query_submitted",
  ]);
  assert.doesNotMatch(stageLogs.join("\n"), /TEST-SCAN-0004/);
});

test("scanner input uses the platform-specific select-all shortcut", () => {
  assert.equal(getSelectAllShortcut("darwin"), "Meta+A");
  assert.equal(getSelectAllShortcut("linux"), "Control+A");
  assert.equal(getSelectAllShortcut("win32"), "Control+A");
});

test("state machine navigates through visible service menus before querying", async () => {
  const actions = [];
  let currentPage = "home";
  const input = {
    async isVisible() {
      return currentPage === "scan";
    },
    async waitFor(options) {
      if (currentPage !== "scan") {
        actions.push(["input-wait-failed", options.timeout]);
        throw new Error("not visible");
      }
      actions.push(["input-ready"]);
    },
  };
  const menuLocator = (text) => ({
    async waitFor() {
      actions.push(["menu-visible", text]);
    },
    async click() {
      actions.push(["menu-click", text]);
      currentPage = text === "服务管理" ? "service" : "scan";
    },
  });
  const page = {
    url: () => "https://crm2.recloud.com.cn/",
    locator() {
      return { first: () => input };
    },
    getByText(text, options) {
      assert.deepEqual(options, { exact: true });
      return {
        filter(filterOptions) {
          assert.deepEqual(filterOptions, { visible: true });
          return { first: () => menuLocator(text) };
        },
      };
    },
  };
  const stageLogs = [];

  const result = await ensureScanPage(page, {
    logger: { info: (message) => stageLogs.push(message) },
    probeTimeout: 1,
    navigationTimeout: 2,
  });

  assert.equal(result, input);
  assert.deepEqual(actions, [
    ["input-wait-failed", 1],
    ["menu-visible", "服务管理"],
    ["menu-click", "服务管理"],
    ["menu-visible", "扫码签收"],
    ["menu-click", "扫码签收"],
    ["input-ready"],
  ]);
  assert.deepEqual(stageLogs, ["RECLOUD_STAGE: scan_page_ready"]);
});

test("visible scanner left on an RMA detail route is reset to the scan page", async () => {
  const actions = [];
  let currentUrl = "https://crm2.recloud.com.cn/example#/rma/detail";
  const input = {
    async isVisible() {
      return true;
    },
    async waitFor(options) {
      actions.push(["input-ready", options.state]);
    },
  };
  const page = {
    url: () => currentUrl,
    locator: () => ({ first: () => input }),
    async goto(url, options) {
      actions.push(["goto", url, options.waitUntil]);
      currentUrl = url;
    },
  };
  const stageLogs = [];

  const result = await ensureScanPage(page, {
    logger: { info: (message) => stageLogs.push(message) },
    navigationTimeout: 100,
  });

  assert.equal(result, input);
  assert.deepEqual(actions, [
    ["goto", RECLOUD_URL, "domcontentloaded"],
    ["input-ready", "visible"],
  ]);
  assert.deepEqual(stageLogs, [
    "RECLOUD_STAGE: scan_page_reset",
    "RECLOUD_STAGE: scan_page_ready",
  ]);
});

test("state machine never presses Enter when the filled value does not match", async () => {
  let enterPressed = false;
  const input = {
    async isVisible() {
      return true;
    },
    async click() {},
    async press() {},
    async pressSequentially() {},
    async inputValue() {
      return "DIFFERENT-VALUE";
    },
  };
  const page = {
    url: () => "https://crm2.recloud.com.cn/example#/scanSignin/query",
    locator() {
      return { first: () => input };
    },
    keyboard: {
      async press() {
        enterPressed = true;
      },
    },
  };

  await assert.rejects(
    () =>
      enterRmaQuery(page, "TEST-EXPECTED-VALUE", {
        logger: { info() {} },
      }),
    (error) => error.code === "RECLOUD_LOGISTICS_FILL_FAILED"
  );
  assert.equal(enterPressed, false);
});

test("state machine reports scan page unavailable instead of schema changed", async () => {
  const input = {
    async isVisible() {
      return false;
    },
    async waitFor() {
      throw new Error("input missing");
    },
  };
  const missingMenu = {
    async waitFor() {
      throw new Error("menu missing");
    },
  };
  const page = {
    url: () => "https://crm2.recloud.com.cn/",
    locator() {
      return { first: () => input };
    },
    getByText() {
      return {
        filter() {
          return { first: () => missingMenu };
        },
      };
    },
  };

  await assert.rejects(
    () =>
      ensureScanPage(page, {
        logger: { info() {} },
        probeTimeout: 1,
        navigationTimeout: 1,
      }),
    (error) =>
      error.code === "RECLOUD_SCAN_PAGE_UNAVAILABLE" &&
      error.message === "无法进入瑞云扫码签收页面"
  );
});

test("RMA detail readiness requires all visible detail markers", async () => {
  const hiddenInput = { async isVisible() { return false; } };
  const page = {
    url: () => "https://crm2.recloud.com.cn/rma/detail",
    locator(selector) {
      if (selector === "body") {
        return {
          async innerText() {
            return "没有查询输入框，但也没有完整的详情标志";
          },
        };
      }
      return { first: () => hiddenInput };
    },
    async waitForTimeout() {
      await new Promise((resolve) => setTimeout(resolve, 25));
    },
  };

  await assert.rejects(
    () =>
      waitForRmaDetail(page, "TEST-NOT-READY", {
        logger: { info() {} },
        timeout: 20,
      }),
    (error) => error.code === "RECLOUD_QUERY_TIMEOUT"
  );
});

test("transient empty table text is not classified as a missing order", async () => {
  const visibleInput = { async isVisible() { return true; } };
  const page = {
    url: () => "https://crm2.recloud.com.cn/example#/scanSignin/query",
    locator(selector) {
      if (selector === "body") {
        return { innerText: async () => "RMA明细 暂无数据" };
      }
      return { first: () => visibleInput };
    },
    keyboard: { press: async () => {} },
    async waitForTimeout() {
      await new Promise((resolve) => setTimeout(resolve, 2));
    },
  };

  await assert.rejects(
    () =>
      waitForRmaDetail(page, "TEST-TRANSIENT-EMPTY", {
        logger: { info() {} },
        retryDelay: 100,
        pollInterval: 1,
        timeout: 10,
      }),
    (error) => error.code === "RECLOUD_QUERY_TIMEOUT"
  );
});

test("RMA and JXTH in separate DOM text lines mark detail ready", async () => {
  const detailText = [
    "RMA",
    "JXTH9000000020",
    "产品信息",
    "用户姓名",
    "测试用户丁",
    "用户手机号",
    "135****0000",
    "所在地区/地址",
    "测试省测试市",
    "描述",
    "测试描述",
    "取件物流单号",
    "TEST-PICKUP-READY",
  ].join("\n");
  const hiddenInput = { async isVisible() { return false; } };
  const page = {
    url: () => "https://crm2.recloud.com.cn/rma/detail",
    locator(selector) {
      if (selector === "body") return { innerText: async () => detailText };
      return { first: () => hiddenInput };
    },
    async evaluate() {
      return [];
    },
  };
  const stageLogs = [];

  const detail = await waitForRmaDetail(page, "TEST-SCAN-READY", {
    logger: { info: (message) => stageLogs.push(message) },
  });

  assert.equal(detail.rmaNo, "JXTH9000000020");
  assert.deepEqual(stageLogs, ["RECLOUD_STAGE: rma_detail_ready"]);
});

test("detail markers transition to schema changed with complete missingFields", async () => {
  const detailText = [
    "RMA",
    "JXTH9000000021",
    "RMA明细",
  ].join("\n");
  const hiddenInput = { async isVisible() { return false; } };
  const page = {
    url: () => "https://crm2.recloud.com.cn/rma/detail",
    locator(selector) {
      if (selector === "body") return { innerText: async () => detailText };
      return { first: () => hiddenInput };
    },
    async evaluate() {
      return [];
    },
  };
  const stageLogs = [];

  await assert.rejects(
    () =>
      waitForRmaDetail(page, "TEST-SCHEMA", {
        logger: { info: (message) => stageLogs.push(message) },
      }),
    (error) =>
      error.code === "RECLOUD_SCHEMA_CHANGED" &&
      JSON.stringify(error.missingFields) ===
        '["reportedFault","pickupLogisticsNo"]'
  );
  assert.deepEqual(stageLogs, ["RECLOUD_STAGE: rma_detail_ready"]);
});

test("detail wait retries Enter only once after three-second scan-page stall", async () => {
  let enterCount = 0;
  const stageLogs = [];
  const visibleInput = { async isVisible() { return true; } };
  const body = { async innerText() { return "扫码签收"; } };
  const page = {
    url: () => "https://crm2.recloud.com.cn/example#/scanSignin/query",
    locator(selector) {
      if (selector === "body") return body;
      if (selector.includes("placeholder")) {
        return { first: () => visibleInput };
      }
      assert.fail(`unexpected selector: ${selector}`);
    },
    keyboard: {
      async press(key) {
        assert.equal(key, "Enter");
        enterCount += 1;
      },
    },
    async waitForTimeout() {
      await new Promise((resolve) => setTimeout(resolve, 4));
    },
  };

  await assert.rejects(
    () =>
      waitForRmaDetail(page, "TEST-RETRY", {
        logger: { info: (message) => stageLogs.push(message) },
        retryDelay: 2,
        pollInterval: 1,
        timeout: 20,
      }),
    (error) => error.code === "RECLOUD_QUERY_TIMEOUT"
  );

  assert.equal(enterCount, 1);
  assert.deepEqual(stageLogs, ["RECLOUD_STAGE: enter_retried"]);
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

test("DOM diagnostics are disabled by default and require an explicit true", () => {
  assert.equal(isDomDiagnosticsEnabled({}), false);
  assert.equal(
    isDomDiagnosticsEnabled({ RECLOUD_DOM_DIAGNOSTICS: "false" }),
    false
  );
  assert.equal(
    isDomDiagnosticsEnabled({ RECLOUD_DOM_DIAGNOSTICS: "true" }),
    true
  );
});

test("DOM diagnostics return only unique sanitized field titles", async () => {
  const rawTitles = [
    "客户姓名",
    "客户姓名",
    "联系手机",
    "RMA | JXTH9000000099",
    "物流 SF1234567890",
    "https://example.test/?token=secret",
  ];
  const page = {
    async evaluate(callback, fieldTitles) {
      assert.equal(typeof callback, "function");
      assert.ok(fieldTitles.includes("描述"));
      return rawTitles;
    },
  };

  const fieldTitles = await collectSafeFieldTitles(page);
  const serialized = JSON.stringify(fieldTitles);

  assert.deepEqual(fieldTitles, sanitizeFieldTitles(rawTitles));
  assert.equal(fieldTitles.filter((title) => title === "客户姓名").length, 1);
  assert.doesNotMatch(serialized, /JXTH9000000099|SF1234567890|token|https/);
});

test("DOM diagnostic logger emits only the field-title JSON array", () => {
  const calls = [];
  const logger = {
    warn(...args) {
      calls.push(args);
    },
  };

  logSafeFieldTitles(
    ["客户姓名", "联系手机", "客户姓名", "JXTH9000000010"],
    logger
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "RECLOUD_FIELD_TITLES:");
  assert.deepEqual(JSON.parse(calls[0][1]), ["客户姓名", "联系手机"]);
  assert.doesNotMatch(calls[0][1], /JXTH9000000010|value|客户资料/);
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
  ]);
});

test("phone query uses the dedicated read-only connector path", async (t) => {
  const calls = [];
  const connector = {
    async openRecloud() {
      calls.push(["open"]);
      return { page: {} };
    },
    async queryRmaByPhone(_page, phone) {
      calls.push(["phone", phone]);
      return {
        rmaNo: "JXTH-PHONE-0001",
        customer: { phoneMasked: "187****0883" },
        reportedFault: "测试故障",
        pickupLogisticsNo: "",
        queryMatchedBy: "PHONE",
        readOnly: true,
      };
    },
    async queryRmaByLogisticsNo() {
      assert.fail("phone query must not use logistics-only parsing");
    },
  };
  const { server, url } = await startServer(connector);
  t.after(() => server.close());

  const response = await fetch(`${url}/api/crm/repairs/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ queryValue: "18788910883" }),
  });
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.data.queryMatchedBy, "PHONE");
  assert.deepEqual(calls, [["open"], ["phone", "18788910883"]]);
});

test("phone detail parsing does not require a pickup logistics number", () => {
  const detail = parseRmaFieldPairs([
    ["寄修单号", "JXTH-PHONE-0002"],
    ["联系电话", "18788910883"],
    ["报修描述", "测试故障"],
  ], "", {
    allowFullPhone: true,
    requirePickupLogisticsNo: false,
  });

  assert.equal(detail.rmaNo, "JXTH-PHONE-0002");
  assert.equal(detail.customer.phoneMasked, "18788910883");
  assert.equal(detail.pickupLogisticsNo, "");
});

test("phone query matches a masked pending-receipt cache without opening Recloud", async (t) => {
  const connector = {
    async openRecloud() {
      assert.fail("masked pending-receipt match must not open Recloud");
    },
  };
  const pendingReceiptStore = {
    async readAll() {
      return [{
        rmaNo: "JXTH-PENDING-0001",
        logisticsNo: "PENDING-LOGISTICS-0001",
        phone: "138****5681",
        reportedFault: "待签收测试故障",
        productLine: "扫地机",
        source: "RECLOUD_PENDING_RECEIPT",
      }];
    },
  };
  const server = createApp(connector, null, { pendingReceiptStore }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => server.close());

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/crm/repairs/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ queryValue: "13888585681" }),
  });
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.data.rmaNo, "JXTH-PENDING-0001");
  assert.equal(result.data.cached, true);
});

test("phone query marks nearby matching orders as repeat repairs and returns product lines", async (t) => {
  const connector = {
    async openRecloud() {
      assert.fail("multiple complete local matches must not open Recloud");
    },
  };
  const receiptStore = {
    async readAll() { return []; },
    async listOrdersForUser() { return []; },
  };
  const pendingReceiptStore = {
    async readAll() {
      return [
        { rmaNo: "JXTH202608281001", logisticsNo: "SF-OLDER", phone: "138****3666", productLine: "扫地机", productModel: "X50 Pro", source: "RECLOUD_PENDING_RECEIPT" },
        { rmaNo: "JXTH202608311002", logisticsNo: "SF-NEWER", phone: "138****3666", productLine: "洗地机", productModel: "H20", source: "RECLOUD_PENDING_RECEIPT" },
      ];
    },
  };
  const server = createApp(connector, receiptStore, { pendingReceiptStore }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => server.close());

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/crm/repairs/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ queryValue: "13882033666" }),
  });
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(result.data.matches.map((item) => item.productLine), ["扫地机", "洗地机"]);
  assert.deepEqual(Object.fromEntries(result.data.matches.map((item) => [item.rmaNo, item.isRepeatRepair])), {
    JXTH202608281001: false,
    JXTH202608311002: true,
  });
});

test("phone query trusts a matching masked live-query cache and returns the complete queried phone", async (t) => {
  const connector = {
    async openRecloud() {
      assert.fail("complete local live-query cache must not open Recloud");
    },
  };
  const pendingReceiptStore = {
    async readAll() {
      return [{
        rmaNo: "JXTH-LIVE-0001",
        logisticsNo: "SF-LIVE-0001",
        phone: "151****2282",
        reportedFault: "清洁中断",
        productLine: "扫地机",
        phoneVerified: false,
        source: "RECLOUD_LIVE_QUERY_CACHE",
      }];
    },
  };
  const server = createApp(connector, null, { pendingReceiptStore }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => server.close());

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/crm/repairs/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ queryValue: "15196862282" }),
  });
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.data.rmaNo, "JXTH-LIVE-0001");
  assert.equal(result.data.customer.phoneMasked, "15196862282");
  assert.equal(result.data.phoneVerified, true);
  assert.equal(result.data.cached, true);
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

test("enabled receive API uses the verified query path and confirms exactly once", async (t) => {
  let queryCount = 0;
  let confirmCount = 0;
  const connector = {
    openRecloud: async () => ({ loginRequired: false, page: {} }),
    queryRmaByLogisticsNo: async (_page, logisticsNo) => {
      queryCount += 1;
      assert.equal(logisticsNo, "SF-REAL-1");
      return { rmaNo: "JXTH-REAL-1", productType: "洗地机", productLine: "洗地机", sn: "" };
    },
    scanSign: async () => assert.fail("legacy scan path must not be used"),
    getRepairDetail: async () => assert.fail("legacy detail parser must not be used"),
    confirmSign: async (_page, sn, productType, remark, options) => {
      confirmCount += 1;
      assert.equal(sn, "TEST-SN-REAL-1");
      assert.equal(productType, "洗地机");
      assert.equal(remark, "洗地机");
      assert.equal(options.dryRun, false);
      return { success: true, confirmed: true, dryRun: false };
    },
  };
  const server = createApp(connector, null, { env: {
    ...process.env,
    DRY_RUN: "false",
    RECLOUD_WRITE_ENABLED: "true",
  } }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${url}/api/crm/repairs/receive`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ logisticsNo: "SF-REAL-1", sn: "TEST-SN-REAL-1", remark: "洗地机" }),
  });
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.data.receipt.confirmed, true);
  assert.equal(queryCount, 1);
  assert.equal(confirmCount, 1);
});

for (const scenario of [
  ["RECLOUD_LOGIN_REQUIRED", 502, "瑞云登录已失效"],
  ["RECLOUD_SCAN_PAGE_UNAVAILABLE", 502, "无法进入瑞云扫码签收页面"],
  ["RECLOUD_LOGISTICS_FILL_FAILED", 502, "输入校验失败"],
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
