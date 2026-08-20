const test = require("node:test");
const assert = require("node:assert/strict");
const {
  activateReceiptDetailTabs,
  collectReceiptTableContainers,
  diagnoseReceiptOperation,
  diagnoseReceiptByCoordinates,
  diagnoseReceiptTableStructure,
  diagnoseFixedReceiptOperation,
  diagnoseReceiptControlAfterHover,
  diagnoseReceiptControlAfterRowHover,
  summarizeReceiptHoverSnapshots,
  classifyReceiptRowHoverDiagnostics,
  diagnoseReceiptControlLayout,
  classifyReceiptLayoutDiagnostics,
  diagnoseReceiptVueState,
  classifyReceiptVueState,
  diagnoseReceiptOperationSource,
  classifyReceiptOperationSource,
  createReceiptActionResponseObserver,
  diagnoseReceiptRendererConfig,
  classifyReceiptRendererConfig,
  findMappedReceiptControl,
  inspectReceiptForm,
  prepareRmaDetailRegion,
  selectReceiptCandidate,
} = require("../connectors/recloud");
const { createApp } = require("../server");

function collection(items) {
  return {
    count: async () => items.length,
    filter() {
      return this;
    },
    first: () => items[0],
    last: () => items.at(-1),
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

function createBoundedTableDiagnosticPage(options = {}) {
  let tabClicks = 0;
  const makeElement = (structure, box) => ({
    isVisible: async () => true,
    boundingBox: async () => box,
    evaluate: async (_callback, argument) => {
      if (argument?.headerNames) {
        return (
          options.snapshot || {
            root: {
              tag: "div",
              role: "grid",
              class: "rtxpc-table el-table",
              bounds: { x: 10, y: 290, width: 800, height: 300 },
            },
            containerCounts: { body: 1, fixedLeft: 0, fixedRight: 1 },
            rowCounts: { body: 1, fixedLeft: 0, fixedRight: 1 },
            rows: [
              {
                category: "body",
                rowKey: "synthetic-row",
                rowIndex: "1",
                y: 360,
                logisticsMatched: true,
                productLineMatched: true,
                pendingReceipt: true,
                operationCellExists: false,
              },
              {
                category: "fixedRight",
                rowKey: "synthetic-row",
                rowIndex: "1",
                y: 360,
                logisticsMatched: false,
                productLineMatched: false,
                pendingReceipt: true,
                operationCellExists: true,
              },
            ],
            canScrollVertically: false,
            canScrollHorizontally: false,
          }
        );
      }
      return structure;
    },
    scrollIntoViewIfNeeded: async () => {},
    click: async () => {
      tabClicks += 1;
    },
    locator() {
      return { first: () => this };
    },
  });
  const tabs = (options.tabs || [
    {
      tag: "div",
      role: "tab",
      class: "el-tabs__item is-active",
      ariaSelected: "true",
      visible: true,
      active: true,
    },
  ]).map((structure, index) =>
    makeElement(structure, {
      x: 10 + index * 120,
      y: 100,
      width: 100,
      height: 32,
    })
  );
  const marker = makeElement({}, { x: 10, y: 260, width: 80, height: 24 });
  const header = makeElement({}, { x: 10, y: 300, width: 80, height: 30 });
  const row = makeElement({}, { x: 10, y: 340, width: 800, height: 40 });
  const table = {
    isVisible: async () => true,
    boundingBox: async () => ({ x: 10, y: 290, width: 800, height: 300 }),
    getByText: () => collection([header]),
    locator: () => collection([row]),
  };
  const page = {
    url: () => "https://crm2.recloud.com.cn/rma/detail",
    frames: () => [],
    mainFrame: () => page,
    getByText(name) {
      if (name === "产品信息") return collection(tabs);
      if (name === "RMA明细") return collection([marker]);
      if (["产品序列号", "项目号", "产品线", "操作"].includes(name)) {
        return collection([header]);
      }
      return collection([]);
    },
    locator(selector) {
      if (selector.includes("table:visible")) return collection([table]);
      return {
        ...collection([]),
        first: () => ({ isVisible: async () => false }),
      };
    },
    waitForTimeout: async () => {},
    mouse: { wheel: async () => {} },
  };
  return {
    page,
    get tabClicks() {
      return tabClicks;
    },
  };
}

function createMappedReceiptControlPage(options = {}) {
  const makeControl = (x) => ({
    isVisible: async () => true,
    isEnabled: async () => true,
    boundingBox: async () => ({ x, y: 450, width: 44, height: 24 }),
    evaluate: async () => ({
      tagName: "span",
      role: "button",
      title: "",
      ariaLabel: "",
      textEqualsReceipt: true,
    }),
  });
  const controls = options.ambiguous
    ? [makeControl(850), makeControl(910)]
    : [makeControl(850)];
  const cell = {
    boundingBox: async () => ({ x: 830, y: 442, width: 140, height: 40 }),
    locator: () => collection(controls),
  };
  const receiptText = {
    ...controls[0],
    locator: () => ({ first: () => cell }),
  };
  const row = {
    isVisible: async () => true,
    evaluate: async () => ({
      domIndex: 1,
      rowKey: "",
      ariaRowIndex: "",
      y: 462,
      logisticsMatched: false,
      productLineMatched: false,
      pendingReceipt: true,
    }),
  };
  const tableRoot = {
    isVisible: async () => true,
    evaluate: async (_callback, argument) =>
      argument?.marker ? options.mapping : undefined,
    locator: () => collection([row]),
    getByText: () => collection([receiptText]),
  };
  const header = {
    isVisible: async () => true,
    locator: () => ({ first: () => tableRoot }),
  };
  const page = {
    frames: () => [],
    mainFrame: () => page,
    getByText: () => collection([header]),
    locator: () => ({ first: () => controls[0] }),
    waitForTimeout: async () => {},
  };
  return { page };
}

function createFixedOperationDiagnosticPage(result) {
  const root = {
    isVisible: async () => true,
    evaluate: async () => result,
  };
  const header = {
    isVisible: async () => true,
    locator: () => ({ first: () => root }),
  };
  const page = {
    url: () => "https://crm2.recloud.com.cn/rma/detail",
    frames: () => [],
    mainFrame: () => page,
    getByText: () => collection([header]),
  };
  return page;
}

function control(role, attributes = {}) {
  return {
    count: async () => 1,
    isVisible: async () => true,
    fill: async () => assert.fail(`${role} must never be filled`),
    click: async () => assert.fail(`${role} must never be clicked`),
    evaluate: async () => (role === "confirm" ? "button" : "input"),
    getAttribute: async (name) => attributes[name] || null,
  };
}

function createInspectionPage(options = {}) {
  let actionClicks = 0;
  let escapePresses = 0;
  let scrollCalls = 0;
  const sn = options.missingSn
    ? missingLocator()
    : control("sn", { name: "serialNumber", placeholder: "请输入SN" });
  const remark = options.missingRemark
    ? missingLocator()
    : control("remark", { name: "remark", placeholder: "请输入备注" });
  const confirm = options.missingConfirm
    ? missingLocator()
    : control("confirm", { "aria-label": "确认" });
  const action = {
    count: async () => 1,
    isVisible: async () => true,
    isEnabled: async () => !options.entryDisabled,
    boundingBox: async () => ({ x: 10, y: 10, width: 40, height: 20 }),
    scrollIntoViewIfNeeded: async () => {
      scrollCalls += 1;
    },
    click: async (clickOptions = {}) => {
      if (
        options.clickAlwaysFails ||
        (options.firstClickFails && !clickOptions.position)
      ) {
        throw new Error("synthetic click failure");
      }
      actionClicks += 1;
    },
    evaluate: async () => {
      if (options.clickAlwaysFails) throw new Error("synthetic DOM click failure");
      actionClicks += 1;
    },
  };
  const dialog = {
    count: async () => 1,
    isVisible: async () => true,
    getByLabel(pattern) {
      return {
        first: () =>
          String(pattern).includes("SN") ? sn : remark,
      };
    },
    getByRole() {
      return { last: () => confirm };
    },
    getByText() {
      return collection([confirm]);
    },
    locator(selector) {
      if (
        selector.includes("[contenteditable") ||
        selector.includes("input[placeholder")
      ) {
        return collection([sn, remark]);
      }
      if (selector === "input:visible, textarea:visible") {
        return collection([sn, remark]);
      }
      if (selector === "textarea:visible") {
        return { first: () => remark };
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
  const page = {
    url: () => "https://crm2.recloud.com.cn/rma/detail",
    getByText: () => ({
      filter: () => ({ first: () => marker }),
    }),
    locator: () =>
      collection(actionClicks > 0 && !options.dialogNeverOpens ? [dialog] : []),
    waitForTimeout: async () => {},
    keyboard: {
      press: async (key) => {
        assert.equal(key, "Escape");
        escapePresses += 1;
      },
    },
  };
  return {
    page,
    get actionClicks() {
      return actionClicks;
    },
    get escapePresses() {
      return escapePresses;
    },
    get scrollCalls() {
      return scrollCalls;
    },
  };
}

test("DRY_RUN inspection locates fields without filling or final confirmation", async () => {
  const fixture = createInspectionPage();
  const logs = [];

  const result = await inspectReceiptForm(fixture.page, {
    dryRun: true,
    writeEnabled: false,
    logger: {
      info: (message) => logs.push(message),
      warn: (message) => logs.push(message),
    },
  });

  assert.equal(fixture.actionClicks, 1);
  assert.equal(fixture.scrollCalls, 1);
  assert.equal(fixture.escapePresses, 1);
  assert.equal(result.confirmed, false);
  assert.equal(result.recloudModified, false);
  assert.equal(result.fields.sn.name, "serialNumber");
  assert.equal(result.fields.remark.name, "remark");
  assert.deepEqual(logs, [
    "RECLOUD_RECEIPT_INSPECTION: receiptEntryFound",
    "RECLOUD_RECEIPT_INSPECTION: receiptEntryVisible",
    "RECLOUD_RECEIPT_INSPECTION: receiptEntryEnabled",
    "RECLOUD_RECEIPT_INSPECTION: receiptEntryClicked",
    "RECLOUD_RECEIPT_INSPECTION: dialogOpened",
    "RECLOUD_RECEIPT_INSPECTION: snInputFound",
    "RECLOUD_RECEIPT_INSPECTION: remarkInputFound",
    "RECLOUD_RECEIPT_INSPECTION: confirmButtonFound",
    "RECLOUD_RECEIPT_INSPECTION: dialog_closed_without_changes",
  ]);
});

test("receipt entry retries with a center-position click after a safe click failure", async () => {
  const fixture = createInspectionPage({ firstClickFails: true });

  const result = await inspectReceiptForm(fixture.page, {
    dryRun: true,
    writeEnabled: false,
    logger: { info() {}, warn() {} },
  });

  assert.equal(fixture.actionClicks, 1);
  assert.equal(result.receiptEntryClicked, true);
  assert.equal(result.dialogOpened, true);
});

test("click failure has a dedicated safe error and dialog missing field", async () => {
  const fixture = createInspectionPage({ clickAlwaysFails: true });

  await assert.rejects(
    inspectReceiptForm(fixture.page, {
      dryRun: true,
      writeEnabled: false,
      logger: { info() {}, warn() {} },
    }),
    (error) => {
      assert.equal(error.code, "RECLOUD_RECEIPT_ENTRY_CLICK_FAILED");
      assert.deepEqual(error.missingFields, ["receiptForm.dialog"]);
      assert.equal(error.inspection.receiptEntryFound, true);
      assert.equal(error.inspection.receiptEntryClicked, false);
      return true;
    }
  );
});

test("missing form after a successful entry click is classified explicitly", async () => {
  const fixture = createInspectionPage({ dialogNeverOpens: true });

  await assert.rejects(
    inspectReceiptForm(fixture.page, {
      dryRun: true,
      writeEnabled: false,
      dialogTimeout: 0,
      logger: { info() {}, warn() {} },
    }),
    (error) => {
      assert.equal(error.code, "RECLOUD_RECEIPT_FORM_NOT_OPENED");
      assert.deepEqual(error.missingFields, ["receiptForm.dialog"]);
      assert.equal(error.inspection.receiptEntryClicked, true);
      assert.equal(error.inspection.dialogOpened, false);
      return true;
    }
  );
});

test("receipt inspection is refused outside strict dry-run mode", async () => {
  const fixture = createInspectionPage();

  await assert.rejects(
    inspectReceiptForm(fixture.page, {
      dryRun: false,
      writeEnabled: false,
    }),
    (error) => error.code === "RECLOUD_RECEIPT_INSPECTION_UNSAFE"
  );
  await assert.rejects(
    inspectReceiptForm(fixture.page, {
      dryRun: true,
      writeEnabled: true,
    }),
    (error) => error.code === "RECLOUD_RECEIPT_INSPECTION_UNSAFE"
  );
  assert.equal(fixture.actionClicks, 0);
});

test("RMA detail preparation scrolls the marker and horizontal table region", async () => {
  let markerScrolled = 0;
  let regionScrolled = 0;
  let horizontalPreparation = 0;
  const region = {
    isVisible: async () => true,
    scrollIntoViewIfNeeded: async () => {
      regionScrolled += 1;
    },
    evaluate: async () => {
      horizontalPreparation += 1;
    },
  };
  const marker = {
    isVisible: async () => true,
    scrollIntoViewIfNeeded: async () => {
      markerScrolled += 1;
    },
    locator: () => ({ first: () => region }),
  };
  const scope = {
    getByText: () => ({
      filter: () => ({ first: () => marker }),
    }),
  };
  const page = { waitForTimeout: async () => {} };

  const result = await prepareRmaDetailRegion(scope, page);

  assert.equal(result, region);
  assert.equal(markerScrolled, 1);
  assert.equal(regionScrolled, 1);
  assert.equal(horizontalPreparation, 1);
});

test("receipt locator activates 产品信息 without clicking the RMA明细 heading", async () => {
  const clicks = [];
  const makeTab = (name) => ({
    count: async () => 1,
    isVisible: async () => true,
    getAttribute: async () => "false",
    scrollIntoViewIfNeeded: async () => {},
    click: async () => clicks.push(name),
    filter() {
      return this;
    },
    first() {
      return this;
    },
    locator() {
      return { first: () => this };
    },
  });
  const tabs = {
    产品信息: makeTab("产品信息"),
    RMA明细: makeTab("RMA明细"),
  };
  const scope = {
    getByRole: (role, options) => tabs[options.name],
    getByText: (name) => tabs[name],
  };

  await activateReceiptDetailTabs(scope, { waitForTimeout: async () => {} }, {
    info() {},
  });

  assert.deepEqual(clicks, ["产品信息"]);
});

test("bounded table diagnosis recognizes an already active 产品信息 tab without clicking", async () => {
  const fixture = createBoundedTableDiagnosticPage();

  const result = await diagnoseReceiptTableStructure(fixture.page, {
    dryRun: true,
    writeEnabled: false,
    tableTimeout: 1000,
    operationTimeout: 100,
  });

  assert.equal(fixture.tabClicks, 0);
  assert.equal(result.productTabActivated, true);
  assert.equal(result.rmaSectionFound, true);
  assert.equal(result.tableContainerCount, 2);
  assert.equal(result.visibleDataRowCount, 1);
  assert.equal(result.tableRootFound, true);
  assert.equal(result.tableRootRole, "grid");
  assert.equal(result.bodyContainerCount, 1);
  assert.equal(result.fixedRightContainerCount, 1);
  assert.equal(result.targetRowCandidateCount, 1);
  assert.equal(result.operationCellFound, true);
  assert.deepEqual(result.targetRowMatchedBy, [
    "logisticsNo",
    "pendingReceipt",
    "productLine",
  ]);
  assert.deepEqual(result.visibleHeaderTitles, [
    "产品序列号",
    "项目号",
    "产品线",
    "操作",
  ]);
  assert.equal(result.diagnosticsStage, "complete");
});

test("bounded table diagnosis clicks the sole visible inactive 产品信息 tab", async () => {
  const fixture = createBoundedTableDiagnosticPage({
    tabs: [
      {
        tag: "span",
        role: "tab",
        class: "rtxpc-tab",
        ariaSelected: "false",
        visible: true,
        active: false,
      },
    ],
  });

  const result = await diagnoseReceiptTableStructure(fixture.page, {
    dryRun: true,
    writeEnabled: false,
    tableTimeout: 1000,
    operationTimeout: 100,
  });

  assert.equal(fixture.tabClicks, 1);
  assert.equal(result.productTabActivated, true);
  assert.equal(result.errorCode, null);
});

test("bounded table diagnosis refuses ambiguous 产品信息 tab candidates", async () => {
  const fixture = createBoundedTableDiagnosticPage({
    tabs: [
      {
        tag: "div",
        role: "tab",
        class: "el-tabs__item",
        ariaSelected: "false",
        visible: true,
        active: false,
      },
      {
        tag: "div",
        role: "tab",
        class: "rtxpc-tab",
        ariaSelected: "false",
        visible: true,
        active: false,
      },
    ],
  });

  const result = await diagnoseReceiptTableStructure(fixture.page, {
    dryRun: true,
    writeEnabled: false,
    tableTimeout: 1000,
    operationTimeout: 100,
  });

  assert.equal(fixture.tabClicks, 0);
  assert.equal(result.tabCandidateCount, 2);
  assert.equal(result.productTabActivated, false);
  assert.equal(result.diagnosticsStage, "product_tab_ambiguous");
  assert.deepEqual(result.missingFields, ["receiptForm.productTab"]);
});

test("table diagnosis never defaults to the first equally matched virtual row", async () => {
  const baseRow = {
    category: "body",
    rowKey: "",
    logisticsMatched: false,
    productLineMatched: true,
    pendingReceipt: true,
    operationCellExists: true,
  };
  const fixture = createBoundedTableDiagnosticPage({
    snapshot: {
      root: {
        tag: "div",
        role: "grid",
        class: "rtxpc-table virtual-list",
        bounds: { x: 10, y: 290, width: 900, height: 400 },
      },
      containerCounts: { body: 1, fixedLeft: 1, fixedRight: 1 },
      rowCounts: { body: 2, fixedLeft: 2, fixedRight: 2 },
      rows: [
        { ...baseRow, rowIndex: "1", y: 360 },
        { ...baseRow, rowIndex: "2", y: 410 },
      ],
      canScrollVertically: false,
      canScrollHorizontally: false,
    },
  });

  const result = await diagnoseReceiptTableStructure(fixture.page, {
    dryRun: true,
    writeEnabled: false,
    productLine: "洗地机",
    tableTimeout: 1000,
    operationTimeout: 100,
  });

  assert.equal(result.targetRowCandidateCount, 2);
  assert.equal(result.operationCellFound, false);
  assert.deepEqual(result.targetRowMatchedBy, []);
  assert.deepEqual(result.missingFields, ["receiptForm.targetRow"]);
  assert.equal(result.errorCode, "RECLOUD_RECEIPT_ACTION_NOT_FOUND");
});

test("mapped receipt locator returns the sole explicit control in rowIndex 1", async () => {
  const fixture = createMappedReceiptControlPage();

  const result = await findMappedReceiptControl(fixture.page, {
    rowIndex: 1,
    actionTimeout: 1000,
    operationTimeout: 100,
  });

  assert.ok(result.entry);
  assert.equal(result.receiptLocator.targetRowCandidateCount, 1);
  assert.deepEqual(result.receiptLocator.targetRowMatchedBy, [
    "pendingReceipt",
  ]);
  assert.equal(result.receiptLocator.operationControlCandidateCount, 1);
  assert.equal(result.operationDiagnostics.length, 1);
});

test("mapped receipt locator stops when the operation cell has multiple explicit controls", async () => {
  const fixture = createMappedReceiptControlPage({ ambiguous: true });

  await assert.rejects(
    findMappedReceiptControl(fixture.page, {
      rowIndex: 1,
      actionTimeout: 1000,
      operationTimeout: 100,
    }),
    (error) => {
      assert.equal(error.code, "RECLOUD_RECEIPT_CONTROL_AMBIGUOUS");
      assert.deepEqual(error.missingFields, ["receiptForm.entry"]);
      assert.equal(error.operationControlCandidates.length, 2);
      return true;
    }
  );
});

test("mapped locator uses the uniquely matched fixed-right row control", async () => {
  const fixture = createMappedReceiptControlPage({
    mapping: {
      status: "found",
      targetRowCandidateCount: 1,
      targetRowMatchedBy: ["pendingReceipt"],
      fixedRightContainerFound: true,
      fixedRightRowCandidateCount: 1,
      fixedRightRowMatchedBy: "rowIndex",
      diagnostics: [
        {
          tag: "span",
          role: "button",
          className: "operation-link",
          title: "",
          ariaLabel: "",
          dataTestId: "receipt",
          textEqualsReceipt: true,
          visible: true,
          enabled: true,
          boundingBox: { x: 850, y: 450, width: 44, height: 24 },
        },
      ],
    },
  });

  const result = await findMappedReceiptControl(fixture.page, {
    rowIndex: 1,
    actionTimeout: 1000,
    operationTimeout: 100,
  });

  assert.equal(result.receiptLocator.fixedRightContainerFound, true);
  assert.equal(result.receiptLocator.fixedRightRowCandidateCount, 1);
  assert.equal(result.receiptLocator.fixedRightRowMatched, true);
  assert.equal(result.receiptLocator.fixedRightRowMatchedBy, "rowIndex");
  assert.equal(result.receiptLocator.operationCellFound, true);
});

test("mapped locator classifies missing fixed-right container", async () => {
  const fixture = createMappedReceiptControlPage({
    mapping: {
      status: "fixed_right_not_found",
      fixedRightContainerFound: false,
      fixedRightRowCandidateCount: 0,
      diagnostics: [],
    },
  });

  await assert.rejects(
    findMappedReceiptControl(fixture.page, {
      rowIndex: 1,
      actionTimeout: 1000,
      operationTimeout: 100,
    }),
    (error) => {
      assert.equal(error.code, "RECLOUD_RECEIPT_FIXED_RIGHT_NOT_FOUND");
      assert.equal(error.inspection.fixedRightContainerFound, false);
      return true;
    }
  );
});

test("mapped locator refuses multiple fixed-right row matches", async () => {
  const fixture = createMappedReceiptControlPage({
    mapping: {
      status: "fixed_row_ambiguous",
      fixedRightContainerFound: true,
      fixedRightRowCandidateCount: 2,
      diagnostics: [],
    },
  });

  await assert.rejects(
    findMappedReceiptControl(fixture.page, {
      rowIndex: 1,
      actionTimeout: 1000,
      operationTimeout: 100,
    }),
    (error) => {
      assert.equal(error.code, "RECLOUD_RECEIPT_FIXED_ROW_AMBIGUOUS");
      assert.equal(error.inspection.fixedRightRowCandidateCount, 2);
      assert.equal(error.inspection.fixedRightRowMatched, false);
      return true;
    }
  );
});

test("mapped locator classifies a fixed row without a receipt control", async () => {
  const fixture = createMappedReceiptControlPage({
    mapping: {
      status: "control_not_found",
      fixedRightContainerFound: true,
      fixedRightRowCandidateCount: 1,
      fixedRightRowMatchedBy: "verticalOverlap",
      diagnostics: [],
    },
  });

  await assert.rejects(
    findMappedReceiptControl(fixture.page, {
      rowIndex: 1,
      actionTimeout: 1000,
      operationTimeout: 100,
    }),
    (error) => {
      assert.equal(error.code, "RECLOUD_RECEIPT_CONTROL_NOT_FOUND");
      assert.equal(error.inspection.fixedRightRowMatched, true);
      assert.equal(error.inspection.operationControlCandidateCount, 0);
      return true;
    }
  );
});

test("fixed operation diagnosis supports a div-grid mapped by vertical geometry", async () => {
  const page = createFixedOperationDiagnosticPage({
    targetMainRowIndex: 1,
    targetMainRowTop: 440,
    targetMainRowBottom: 480,
    targetMainRowHeight: 40,
    targetMainRowCenterY: 460,
    fixedRightContainerFound: true,
    fixedRightContainerTag: "div",
    fixedRightContainerClass: "el-table__fixed-right",
    fixedStructureType: "div-grid-or-absolute",
    fixedVisibleCandidateCount: 3,
    fixedIntersectingCandidateCount: 1,
    fixedRightRowCandidateCount: 1,
    fixedRightRowMatched: true,
    fixedRightRowMatchedBy: "verticalGeometry",
    fixedRightRowCenterDelta: 0,
    operationCellFound: true,
    operationControlCandidateCount: 1,
    operationControlCandidates: [
      {
        tag: "span",
        role: "button",
        class: "operation",
        titlePresent: false,
        ariaLabelPresent: false,
        enabled: true,
        visible: true,
        bounds: { x: 900, y: 448, width: 40, height: 24 },
      },
    ],
    errorCode: null,
  });

  const result = await diagnoseFixedReceiptOperation(page, {
    dryRun: true,
    writeEnabled: false,
  });

  assert.equal(result.fixedStructureType, "div-grid-or-absolute");
  assert.equal(result.fixedRightRowMatchedBy, "verticalGeometry");
  assert.equal(result.operationControlCandidateCount, 1);
  assert.equal(result.clicked, false);
});

test("fixed operation diagnosis supports an absolute virtual fixed column", async () => {
  const page = createFixedOperationDiagnosticPage({
    fixedRightContainerFound: true,
    fixedStructureType: "div-grid-or-absolute",
    fixedVisibleCandidateCount: 4,
    fixedIntersectingCandidateCount: 1,
    fixedRightRowCandidateCount: 1,
    fixedRightRowMatched: true,
    fixedRightRowMatchedBy: "uniqueInteractiveGeometry",
    fixedRightRowCenterDelta: 1,
    operationCellFound: true,
    operationControlCandidateCount: 1,
    operationControlCandidates: [],
    errorCode: null,
  });

  const result = await diagnoseFixedReceiptOperation(page, {
    dryRun: true,
    writeEnabled: false,
  });

  assert.equal(result.fixedRightRowMatched, true);
  assert.equal(result.fixedRightRowMatchedBy, "uniqueInteractiveGeometry");
  assert.equal(result.dialogOpened, false);
  assert.equal(result.confirmClicked, false);
});

test("fixed operation diagnosis rejects multiple equally overlapping nodes", async () => {
  const page = createFixedOperationDiagnosticPage({
    fixedRightContainerFound: true,
    fixedStructureType: "div-grid-or-absolute",
    fixedVisibleCandidateCount: 5,
    fixedIntersectingCandidateCount: 2,
    fixedRightRowCandidateCount: 2,
    fixedRightRowMatched: false,
    operationCellFound: false,
    operationControlCandidateCount: 0,
    operationControlCandidates: [],
    errorCode: "RECLOUD_RECEIPT_FIXED_ROW_AMBIGUOUS",
  });

  const result = await diagnoseFixedReceiptOperation(page, {
    dryRun: true,
    writeEnabled: false,
  });

  assert.equal(result.fixedRightRowCandidateCount, 2);
  assert.equal(result.fixedRightRowMatched, false);
  assert.deepEqual(result.missingFields, ["receiptForm.fixedRightRow"]);
  assert.equal(result.errorCode, "RECLOUD_RECEIPT_FIXED_ROW_AMBIGUOUS");
});

for (const fixture of [
  { name: "span text", matchedBy: "exactVisibleText", tag: "span" },
  { name: "div role button", matchedBy: "accessibleName", tag: "div" },
  { name: "delegated td", matchedBy: "delegatedCell", tag: "td" },
  { name: "pointer node", matchedBy: "pointerCursor", tag: "span" },
  { name: "pseudo receipt", matchedBy: "pseudoContent", tag: "div" },
]) {
  test(`operation-cell diagnostic recognizes ${fixture.name} without clicking`, async () => {
    const page = createFixedOperationDiagnosticPage({
      fixedRightContainerFound: true,
      fixedRightRowCandidateCount: 1,
      fixedRightRowMatched: true,
      operationCellFound: true,
      uniqueReceiptControlFound: true,
      uniqueReceiptControlMatchedBy: fixture.matchedBy,
      uniqueReceiptControlNodeIndex: 1,
      uniqueReceiptControlBounds: {
        x: 900,
        y: 452,
        width: 32,
        height: 20,
      },
      operationControlCandidates: [
        {
          tag: fixture.tag,
          role: "",
          class: "synthetic-control",
          titlePresent: false,
          ariaLabelPresent: false,
          enabled: true,
          visible: true,
          bounds: { x: 900, y: 452, width: 32, height: 20 },
        },
      ],
      clicked: false,
      dialogOpened: false,
      blockedRequestCount: 0,
      confirmClicked: false,
      errorCode: null,
    });

    const result = await diagnoseFixedReceiptOperation(page, {
      dryRun: true,
      writeEnabled: false,
    });

    assert.equal(result.uniqueReceiptControlFound, true);
    assert.equal(
      result.uniqueReceiptControlMatchedBy,
      fixture.matchedBy
    );
    assert.equal(result.clicked, false);
    assert.equal(result.dialogOpened, false);
    assert.equal(result.blockedRequestCount, 0);
  });
}

test("operation-cell diagnostic reports a transparent overlay without clicking", async () => {
  const page = createFixedOperationDiagnosticPage({
    fixedRightContainerFound: true,
    fixedRightRowCandidateCount: 1,
    fixedRightRowMatched: true,
    operationCellFound: true,
    overlayDetected: true,
    uniqueReceiptControlFound: false,
    clicked: false,
    dialogOpened: false,
    errorCode: "RECLOUD_RECEIPT_CONTROL_OCCLUDED",
  });

  const result = await diagnoseFixedReceiptOperation(page, {
    dryRun: true,
    writeEnabled: false,
  });

  assert.equal(result.overlayDetected, true);
  assert.equal(result.clicked, false);
  assert.equal(result.errorCode, "RECLOUD_RECEIPT_CONTROL_OCCLUDED");
});

test("operation-cell diagnostic refuses multiple controls and never chooses another row", async () => {
  const page = createFixedOperationDiagnosticPage({
    targetMainRowIndex: 1,
    fixedRightRowCandidateCount: 1,
    fixedRightRowMatched: true,
    operationCellFound: true,
    operationControlCandidateCount: 2,
    uniqueReceiptControlFound: false,
    clicked: false,
    dialogOpened: false,
    errorCode: "RECLOUD_RECEIPT_CONTROL_AMBIGUOUS",
  });

  const result = await diagnoseFixedReceiptOperation(page, {
    dryRun: true,
    writeEnabled: false,
    rowIndex: 1,
  });

  assert.equal(result.targetMainRowIndex, 1);
  assert.equal(result.uniqueReceiptControlFound, false);
  assert.equal(result.clicked, false);
  assert.equal(result.errorCode, "RECLOUD_RECEIPT_CONTROL_AMBIGUOUS");
});

test("hover summary accepts one visible unoccluded receipt control", () => {
  const result = summarizeReceiptHoverSnapshots([
    {
      descendantsExpandedAfterHover: true,
      hoverPopupCount: 0,
      receiptTextAppearedAfterHover: true,
      receiptControlCandidateCount: 1,
      receiptControlVisible: true,
      receiptControlOccluded: false,
      hoverSourceUnique: true,
      uniqueReceiptControlMatchedBy: "hoveredCell",
      receiptControlBounds: { x: 10, y: 10, width: 20, height: 20 },
    },
  ]);

  assert.equal(result.uniqueReceiptControlFound, true);
  assert.equal(result.uniqueReceiptControlMatchedBy, "hoveredCell");
  assert.equal(result.errorCode, null);
});

test("hover summary accepts one uniquely triggered popup control", () => {
  const result = summarizeReceiptHoverSnapshots([
    {
      descendantsExpandedAfterHover: false,
      hoverPopupCount: 1,
      receiptTextAppearedAfterHover: true,
      receiptControlCandidateCount: 1,
      receiptControlVisible: true,
      receiptControlOccluded: false,
      hoverSourceUnique: true,
      uniqueReceiptControlMatchedBy: "hoverPopup",
    },
  ]);

  assert.equal(result.popupAppearedAfterHover, true);
  assert.equal(result.uniqueReceiptControlFound, true);
  assert.equal(result.uniqueReceiptControlMatchedBy, "hoverPopup");
});

test("hover summary rejects multiple controls", () => {
  const result = summarizeReceiptHoverSnapshots([
    {
      descendantsExpandedAfterHover: true,
      hoverPopupCount: 0,
      receiptControlCandidateCount: 2,
      hoverSourceUnique: true,
    },
  ]);

  assert.equal(result.uniqueReceiptControlFound, false);
  assert.equal(result.errorCode, "RECLOUD_RECEIPT_CONTROL_AMBIGUOUS");
});

test("hover summary rejects an occluded control", () => {
  const result = summarizeReceiptHoverSnapshots([
    {
      descendantsExpandedAfterHover: true,
      hoverPopupCount: 0,
      receiptControlCandidateCount: 1,
      receiptControlVisible: true,
      receiptControlOccluded: true,
      hoverSourceUnique: true,
    },
  ]);

  assert.equal(result.uniqueReceiptControlFound, false);
  assert.equal(result.errorCode, "RECLOUD_RECEIPT_CONTROL_OCCLUDED");
});

test("hover summary reports no expansion and no candidate", () => {
  const result = summarizeReceiptHoverSnapshots([
    {
      descendantsExpandedAfterHover: false,
      hoverPopupCount: 0,
      receiptControlCandidateCount: 0,
      hoverSourceUnique: true,
    },
  ]);

  assert.equal(result.uniqueReceiptControlFound, false);
  assert.equal(result.errorCode, "RECLOUD_RECEIPT_HOVER_NOT_EXPANDED");
});

test("hover summary refuses multiple popups", () => {
  const result = summarizeReceiptHoverSnapshots([
    {
      descendantsExpandedAfterHover: true,
      hoverPopupCount: 2,
      receiptControlCandidateCount: 1,
      hoverSourceUnique: true,
    },
  ]);

  assert.equal(result.uniqueReceiptControlFound, false);
  assert.equal(
    result.errorCode,
    "RECLOUD_RECEIPT_HOVER_POPUP_AMBIGUOUS"
  );
});

test("hover diagnostic implementation contains no click or field-fill action", () => {
  const source = diagnoseReceiptControlAfterHover.toString();

  assert.equal(/\.click\s*\(/.test(source), false);
  assert.equal(/\.fill\s*\(/.test(source), false);
  assert.equal(/dispatchEvent\s*\(\s*["']click/.test(source), false);
  assert.equal(source.includes("createReceiptNetworkGuard"), true);
});

test("row-hover diagnosis classifies a unique unoccluded receipt control", () => {
  const errorCode = classifyReceiptRowHoverDiagnostics({
    mainRowHovered: true,
    uniqueReceiptControlFound: true,
    receiptControlCandidateCount: 1,
  });

  assert.equal(errorCode, null);
});

test("row-hover diagnosis reports clipping before missing portal", () => {
  const errorCode = classifyReceiptRowHoverDiagnostics({
    mainRowHovered: true,
    clippingDetected: true,
    portalCandidateCount: 0,
    receiptControlCandidateCount: 0,
  });

  assert.equal(errorCode, "RECLOUD_RECEIPT_CONTENT_CLIPPED");
});

test("row-hover diagnosis reports parent delegation safely", () => {
  const errorCode = classifyReceiptRowHoverDiagnostics({
    mainRowHovered: true,
    delegatedHoverDetected: true,
    portalCandidateCount: 0,
    receiptControlCandidateCount: 0,
  });

  assert.equal(errorCode, "RECLOUD_RECEIPT_PARENT_EVENT_DELEGATION");
});

test("row-hover diagnosis distinguishes no expansion and ambiguity", () => {
  assert.equal(
    classifyReceiptRowHoverDiagnostics({
      mainRowHovered: true,
      descendantsExpandedAfterHover: false,
      portalCandidateCount: 0,
      receiptControlCandidateCount: 0,
    }),
    "RECLOUD_RECEIPT_ROW_HOVER_NOT_EXPANDED"
  );
  assert.equal(
    classifyReceiptRowHoverDiagnostics({
      mainRowHovered: true,
      receiptControlCandidateCount: 2,
    }),
    "RECLOUD_RECEIPT_CONTROL_AMBIGUOUS"
  );
});

test("row-hover implementation cannot click, fill or dispatch pointer actions", () => {
  const source = diagnoseReceiptControlAfterRowHover.toString();

  assert.equal(/\.click\s*\(/.test(source), false);
  assert.equal(/\.dblclick\s*\(/.test(source), false);
  assert.equal(/\.tap\s*\(/.test(source), false);
  assert.equal(/\.fill\s*\(/.test(source), false);
  assert.equal(
    /dispatchEvent\s*\(\s*["'](?:click|mousedown|mouseup|pointerdown|pointerup)/.test(
      source
    ),
    false
  );
  assert.equal(source.includes("createReceiptNetworkGuard"), true);
  assert.equal(source.includes("MutationObserver"), true);
  assert.equal(source.includes("elementsFromPoint"), true);
});

test("layout diagnosis classifies controls revealed only by horizontal scroll", () => {
  assert.equal(
    classifyReceiptLayoutDiagnostics({
      uniqueReceiptControlFound: true,
      revealedByScroll: true,
    }),
    "RECLOUD_RECEIPT_CONTROL_REVEALED_BY_SCROLL"
  );
});

test("layout diagnosis distinguishes clipping, offscreen and fixed coverage", () => {
  assert.equal(
    classifyReceiptLayoutDiagnostics({
      coveredByFixedColumn: true,
      clippingDetected: true,
    }),
    "RECLOUD_RECEIPT_CONTROL_COVERED_BY_FIXED_COLUMN"
  );
  assert.equal(
    classifyReceiptLayoutDiagnostics({
      positionedOffscreen: true,
      clippingDetected: true,
    }),
    "RECLOUD_RECEIPT_CONTROL_POSITIONED_OFFSCREEN"
  );
  assert.equal(
    classifyReceiptLayoutDiagnostics({ clippingDetected: true }),
    "RECLOUD_RECEIPT_CONTENT_CLIPPED"
  );
  assert.equal(
    classifyReceiptLayoutDiagnostics({}),
    "RECLOUD_RECEIPT_CONTROL_NOT_RENDERED"
  );
});

test("layout diagnostic only hovers and restores its horizontal scroll", () => {
  const source = diagnoseReceiptControlLayout.toString();

  assert.equal(/\.click\s*\(/.test(source), false);
  assert.equal(/\.dblclick\s*\(/.test(source), false);
  assert.equal(/\.tap\s*\(/.test(source), false);
  assert.equal(/\.fill\s*\(/.test(source), false);
  assert.equal(/dispatchEvent\s*\(/.test(source), false);
  assert.equal(source.includes("scroll.scrollLeft = originalScrollLeft"), true);
  assert.equal(source.includes("createReceiptNetworkGuard"), true);
  assert.equal(source.includes("MutationObserver"), true);
});

test("Vue state diagnosis prioritizes permission, status and missing fields", () => {
  assert.equal(
    classifyReceiptVueState({
      vueStateAvailable: true,
      permissionDenied: true,
    }),
    "RECLOUD_RECEIPT_HIDDEN_BY_PERMISSION"
  );
  assert.equal(
    classifyReceiptVueState({
      vueStateAvailable: true,
      statusAllowsReceipt: false,
    }),
    "RECLOUD_RECEIPT_HIDDEN_BY_STATUS"
  );
  assert.equal(
    classifyReceiptVueState({
      vueStateAvailable: true,
      requiredMissingFieldNames: ["productId"],
    }),
    "RECLOUD_RECEIPT_REQUIRED_ROW_FIELD_MISSING"
  );
});

test("Vue state diagnosis distinguishes unloaded and empty operation data", () => {
  assert.equal(
    classifyReceiptVueState({
      vueStateAvailable: true,
      operationDataLoaded: false,
    }),
    "RECLOUD_RECEIPT_OPERATION_DATA_NOT_LOADED"
  );
  assert.equal(
    classifyReceiptVueState({
      vueStateAvailable: true,
      operationDataLoaded: true,
      operationDefinitionExists: false,
    }),
    "RECLOUD_RECEIPT_OPERATION_LIST_EMPTY"
  );
  assert.equal(
    classifyReceiptVueState({
      vueStateAvailable: true,
      operationDataLoaded: true,
      operationDefinitionExists: true,
      operationListFound: true,
      filteredOperationCount: 0,
    }),
    "RECLOUD_RECEIPT_OPERATION_LIST_EMPTY"
  );
  assert.equal(
    classifyReceiptVueState({ vueStateAvailable: false }),
    "RECLOUD_RECEIPT_VUE_STATE_UNAVAILABLE"
  );
});

test("Vue state diagnostic is read-only and installs the network guard", () => {
  const source = diagnoseReceiptVueState.toString();

  assert.equal(/\.click\s*\(/.test(source), false);
  assert.equal(/\.hover\s*\(/.test(source), false);
  assert.equal(/\.fill\s*\(/.test(source), false);
  assert.equal(/dispatchEvent\s*\(/.test(source), false);
  assert.equal(/setAttribute\s*\(/.test(source), false);
  assert.equal(source.includes("createReceiptNetworkGuard"), true);
  assert.equal(source.includes("operationItems"), true);
});

test("operation source diagnosis classifies filtering and missing sources", () => {
  assert.equal(
    classifyReceiptOperationSource({
      receiptActionPresentBeforeFilter: true,
      receiptActionPresentAfterFilter: false,
    }),
    "RECLOUD_RECEIPT_ACTION_FILTERED_BY_CONDITION"
  );
  assert.equal(
    classifyReceiptOperationSource({
      operationSourceType: "rowData",
      receiptActionPresentBeforeFilter: false,
    }),
    "RECLOUD_RECEIPT_ACTION_MISSING_FROM_ROW_DATA"
  );
  assert.equal(
    classifyReceiptOperationSource({
      operationSourceType: "apiResponse",
      receiptActionPresentBeforeFilter: false,
    }),
    "RECLOUD_RECEIPT_ACTION_MISSING_FROM_API"
  );
  assert.equal(
    classifyReceiptOperationSource({
      operationSourceType: "columnSchema",
      operationColumnFound: true,
      receiptActionPresentBeforeFilter: false,
    }),
    "RECLOUD_RECEIPT_ACTION_MISSING_FROM_SCHEMA"
  );
});

test("operation source diagnostic never invokes UI or Vue mutations", () => {
  const source = diagnoseReceiptOperationSource.toString();

  assert.equal(/\.click\s*\(/.test(source), false);
  assert.equal(/\.hover\s*\(/.test(source), false);
  assert.equal(/\.fill\s*\(/.test(source), false);
  assert.equal(/dispatchEvent\s*\(/.test(source), false);
  assert.equal(/setAttribute\s*\(/.test(source), false);
  assert.equal(source.includes("createReceiptNetworkGuard"), true);
  assert.equal(source.includes("$scopedSlots"), true);
  assert.equal(source.includes("$slots"), true);
});

test("action response observer exposes no body, URL query or request payload", () => {
  const source = createReceiptActionResponseObserver.toString();

  assert.equal(source.includes("sanitizeRecloudRequestPath"), true);
  assert.equal(source.includes("postData"), false);
  assert.equal(source.includes("request.body"), false);
  assert.equal(source.includes("Cookie"), false);
  assert.equal(source.includes("token"), false);
  assert.equal(source.includes("topLevelFieldNames"), true);
});

test("renderer diagnosis classifies clone loss, missing keys and registration", () => {
  assert.equal(
    classifyReceiptRendererConfig({
      mainOperationColumnFound: true,
      fixedOperationColumnFound: true,
      configLostInFixedClone: true,
    }),
    "RECLOUD_RECEIPT_RENDERER_LOST_IN_FIXED_CLONE"
  );
  assert.equal(
    classifyReceiptRendererConfig({
      mainOperationColumnFound: true,
      fixedOperationColumnFound: true,
      mainRendererKeyPresent: false,
    }),
    "RECLOUD_RECEIPT_RENDERER_KEY_MISSING"
  );
  assert.equal(
    classifyReceiptRendererConfig({
      mainOperationColumnFound: true,
      fixedOperationColumnFound: true,
      mainRendererKeyPresent: true,
      rendererRegistered: false,
    }),
    "RECLOUD_RECEIPT_RENDERER_NOT_REGISTERED"
  );
});

test("renderer diagnosis distinguishes missing page actions and empty config", () => {
  assert.equal(
    classifyReceiptRendererConfig({
      mainOperationColumnFound: true,
      fixedOperationColumnFound: true,
      mainRendererKeyPresent: true,
      rendererRegistered: true,
      pageActionSourceKeyPresent: true,
      pageActionConfigPresent: false,
    }),
    "RECLOUD_RECEIPT_PAGE_ACTION_CONFIG_MISSING"
  );
  assert.equal(
    classifyReceiptRendererConfig({
      mainOperationColumnFound: true,
      fixedOperationColumnFound: true,
      mainRendererKeyPresent: true,
      rendererRegistered: true,
    }),
    "RECLOUD_RECEIPT_RENDERER_CONFIG_EMPTY"
  );
});

test("renderer config diagnostic cannot execute renderers or mutate the page", () => {
  const source = diagnoseReceiptRendererConfig.toString();

  assert.equal(/\.click\s*\(/.test(source), false);
  assert.equal(/\.hover\s*\(/.test(source), false);
  assert.equal(/\.fill\s*\(/.test(source), false);
  assert.equal(/dispatchEvent\s*\(/.test(source), false);
  assert.equal(/setAttribute\s*\(/.test(source), false);
  assert.equal(/\.render(?:Cell|er)?\s*\(/.test(source), false);
  assert.equal(source.includes("createReceiptNetworkGuard"), true);
});

test("receipt candidate prefers the row matching the configured logistics number", async () => {
  const makeCandidate = (text, y) => ({
    row: { innerText: async () => text },
    entry: {
      isEnabled: async () => true,
      boundingBox: async () => ({ x: 100, y, width: 40, height: 20 }),
    },
  });
  const unrelated = makeCandidate("待签收 其他测试行", 100);
  const expected = makeCandidate("待签收 TEST-LOGISTICS-TARGET", 140);

  const selected = await selectReceiptCandidate([unrelated, expected], {
    logisticsNo: "TEST-LOGISTICS-TARGET",
  });

  assert.equal(selected.entry, expected.entry);
});

test("receipt candidate rejects different rows that cannot be disambiguated", async () => {
  const makeCandidate = (y) => ({
    row: { innerText: async () => "待签收" },
    entry: {
      isEnabled: async () => true,
      boundingBox: async () => ({ x: 100, y, width: 40, height: 20 }),
    },
  });

  await assert.rejects(
    selectReceiptCandidate([makeCandidate(100), makeCandidate(180)]),
    (error) => {
      assert.equal(error.code, "RECLOUD_RECEIPT_ACTION_AMBIGUOUS");
      assert.deepEqual(error.missingFields, ["receiptForm.targetRow"]);
      return true;
    }
  );
});

test("operation diagnosis maps the target row to a fixed icon labeled 签收", async () => {
  const targetRow = {
    innerText: async () => "洗地机 待签收 TEST-TARGET",
    getAttribute: async () => "",
    boundingBox: async () => ({ x: 0, y: 120, width: 700, height: 40 }),
    locator: () => collection([]),
  };
  const receiptIcon = {
    isVisible: async () => true,
    isEnabled: async () => true,
    boundingBox: async () => ({ x: 900, y: 128, width: 24, height: 24 }),
    evaluate: async () => ({
      tagName: "span",
      role: "button",
      className: "operation-icon cursor-pointer",
      title: "签收",
      ariaLabel: "",
      dataTestId: "receipt-action",
      text: "",
    }),
  };
  const fixedRow = {
    boundingBox: async () => ({ x: 850, y: 120, width: 100, height: 40 }),
    locator: () => collection([receiptIcon]),
  };
  const region = {
    isVisible: async () => true,
    locator(selector) {
      if (selector.startsWith("xpath=ancestor-or-self")) {
        return { first: () => this };
      }
      if (selector.includes("fixed-right")) return collection([fixedRow]);
      if (selector.startsWith("tr,")) return collection([targetRow]);
      return collection([]);
    },
  };
  const page = {
    locator: () => ({ last: () => missingLocator() }),
  };

  const result = await diagnoseReceiptOperation(region, {
    logisticsNo: "TEST-TARGET",
    productLine: "洗地机",
    page,
  });

  assert.equal(result.targetFound, true);
  assert.equal(result.entry, receiptIcon);
  assert.deepEqual(result.diagnostics, [
    {
      tagName: "span",
      role: "button",
      className: "operation-icon cursor-pointer",
      title: "签收",
      ariaLabel: "",
      dataTestId: "receipt-action",
      visible: true,
      enabled: true,
      text: "",
      tooltip: "",
    },
  ]);
});

test("operation diagnosis removes non-operation text and sensitive attributes", async () => {
  const targetRow = {
    innerText: async () => "洗地机 待签收",
    getAttribute: async () => "",
    boundingBox: async () => ({ x: 0, y: 120, width: 700, height: 40 }),
    locator: () => collection([]),
  };
  const unrelatedButton = {
    isVisible: async () => true,
    isEnabled: async () => true,
    boundingBox: async () => ({ x: 900, y: 128, width: 24, height: 24 }),
    hover: async () => {},
    evaluate: async () => ({
      tagName: "button",
      role: "button",
      className: "operation-button",
      title: "客户敏感内容",
      ariaLabel: "内部编号",
      dataTestId: "safe-test-id",
      text: "非固定操作文本",
    }),
  };
  const fixedRow = {
    boundingBox: async () => ({ x: 850, y: 120, width: 100, height: 40 }),
    locator: () => collection([unrelatedButton]),
  };
  const region = {
    isVisible: async () => true,
    locator(selector) {
      if (selector.startsWith("xpath=ancestor-or-self")) {
        return { first: () => this };
      }
      if (selector.includes("fixed-right")) return collection([fixedRow]);
      if (selector.startsWith("tr,")) return collection([targetRow]);
      return collection([]);
    },
  };
  const page = {
    locator: () => ({ last: () => missingLocator() }),
  };

  const result = await diagnoseReceiptOperation(region, { page });

  assert.equal(result.entry, null);
  assert.equal(result.diagnostics[0].title, "");
  assert.equal(result.diagnostics[0].ariaLabel, "");
  assert.equal(result.diagnostics[0].text, "");
  assert.equal(
    JSON.stringify(result.diagnostics).includes("客户敏感内容"),
    false
  );
});

function createCoordinateRegion(rowDefinitions) {
  const headerBoxes = {
    产品序列号: { x: 80, y: 40, width: 80, height: 20 },
    项目号: { x: 180, y: 40, width: 80, height: 20 },
    产品线: { x: 280, y: 40, width: 80, height: 20 },
    操作: { x: 380, y: 40, width: 80, height: 20 },
  };
  const cells = [];
  for (const [rowIndex, definition] of rowDefinitions.entries()) {
    const y = 90 + rowIndex * 50;
    const texts = [
      definition.serial || "TEST-SERIAL",
      definition.project || "TEST-PROJECT",
      definition.productLine,
      definition.status,
    ];
    for (let column = 0; column < 4; column += 1) {
      const operationElements =
        column === 3 && definition.operation ? [definition.operation] : [];
      cells.push({
        boundingBox: async () => ({
          x: 40 + column * 100,
          y,
          width: 80,
          height: 30,
        }),
        innerText: async () => texts[column],
        locator: () => collection(operationElements),
      });
    }
  }
  return {
    getByText(name) {
      return {
        filter() {
          return this;
        },
        first() {
          return this;
        },
        boundingBox: async () => headerBoxes[name] || null,
      };
    },
    locator: () => collection(cells),
  };
}

test("coordinate model identifies one virtual row and its fixed operation cell", async () => {
  const receiptButton = {
    isVisible: async () => true,
    isEnabled: async () => true,
    evaluate: async () => ({
      tagName: "button",
      role: "button",
      className: "fixed-operation",
      title: "",
      ariaLabel: "签收",
      dataTestId: "receipt",
      text: "",
      cursorPointer: true,
    }),
  };
  const region = createCoordinateRegion([
    {
      productLine: "洗地机",
      status: "待签收",
      operation: receiptButton,
    },
  ]);
  const page = {
    locator: () => ({
      last: () => ({ innerText: async () => "" }),
    }),
  };

  const result = await diagnoseReceiptByCoordinates(region, {
    allowedProductLines: ["洗地机"],
    page,
  });

  assert.equal(result.targetRowCandidateCount, 1);
  assert.deepEqual(result.targetRowMatchedBy, [
    "productLine",
    "pendingStatus",
    "verticalCoordinate",
  ]);
  assert.equal(result.fixedOperationRowMatched, true);
  assert.equal(result.entry, receiptButton);
  assert.equal(result.operationDiagnostics[0].ariaLabel, "签收");
});

test("coordinate model stops when multiple virtual rows have equal priority", async () => {
  const operation = {
    isVisible: async () => true,
    isEnabled: async () => true,
  };
  const region = createCoordinateRegion([
    { productLine: "洗地机", status: "待签收", operation },
    { productLine: "洗地机", status: "待签收", operation },
  ]);

  const result = await diagnoseReceiptByCoordinates(region, {
    allowedProductLines: ["洗地机"],
    page: { locator: () => ({ last: () => missingLocator() }) },
  });

  assert.equal(result.targetRowCandidateCount, 2);
  assert.deepEqual(result.targetRowMatchedBy, []);
  assert.equal(result.fixedOperationRowMatched, false);
  assert.equal(result.entry, null);
});

test("table structure collector returns only headers, row structure and bounds", async () => {
  const rawTables = [
    {
      tagName: "div",
      role: "grid",
      className: "rtxpc-table body-table",
      fixedOperationContainer: false,
      bounds: { x: 10, y: 100, width: 900, height: 300 },
      headers: ["产品序列号", "项目号", "产品线", "客户手机号13800000000"],
      rows: [
        {
          tagName: "div",
          role: "row",
          className: "virtual-row",
          rowKeyPresent: true,
          y: 180,
          height: 40,
        },
      ],
    },
  ];
  const scope = {
    locator: () => ({
      evaluateAll: async () => rawTables,
    }),
  };

  const result = await collectReceiptTableContainers(scope, { y: 80 });

  assert.deepEqual(result, [
    {
      tableIndex: 0,
      tagName: "div",
      role: "grid",
      className: "rtxpc-table body-table",
      fixedOperationContainer: false,
      bounds: { x: 10, y: 100, width: 900, height: 300 },
      headers: ["产品序列号", "项目号", "产品线"],
      visibleDataRowCount: 1,
      rows: [
        {
          tagName: "div",
          role: "row",
          className: "virtual-row",
          rowKeyPresent: true,
          y: 180,
          height: 40,
        },
      ],
    },
  ]);
  assert.equal(JSON.stringify(result).includes("13800000000"), false);
});

test("missing receipt controls return complete schema fields and close dialog", async () => {
  const fixture = createInspectionPage({
    missingSn: true,
    missingRemark: true,
    missingConfirm: true,
  });

  await assert.rejects(
    inspectReceiptForm(fixture.page, {
      dryRun: true,
      writeEnabled: false,
      logger: { info() {}, warn() {} },
    }),
    (error) => {
      assert.equal(error.code, "RECLOUD_SCHEMA_CHANGED");
      assert.deepEqual(error.missingFields, [
        "receipt.snInput",
        "receipt.remarkInput",
        "receipt.confirmButton",
      ]);
      return true;
    }
  );
  assert.equal(fixture.actionClicks, 1);
  assert.equal(fixture.escapePresses, 1);
});

test("inspection API calls query then locator and never calls Recloud writes", async (t) => {
  const calls = [];
  const connector = {
    openRecloud: async () => ({ page: {} }),
    queryRmaByLogisticsNo: async (page, logisticsNo) => {
      calls.push(["query", logisticsNo]);
      return { rmaNo: "JXTH-TEST-INSPECT" };
    },
    inspectReceiptForm: async (page, options) => {
      calls.push(["inspect", options.dryRun, options.writeEnabled]);
      return {
        dryRun: true,
        confirmed: false,
        recloudModified: false,
      };
    },
    confirmSign: async () => assert.fail("must never confirm receipt"),
  };
  const previousDryRun = process.env.DRY_RUN;
  const previousWriteEnabled = process.env.RECLOUD_WRITE_ENABLED;
  process.env.DRY_RUN = "true";
  process.env.RECLOUD_WRITE_ENABLED = "false";
  t.after(() => {
    if (previousDryRun === undefined) delete process.env.DRY_RUN;
    else process.env.DRY_RUN = previousDryRun;
    if (previousWriteEnabled === undefined) {
      delete process.env.RECLOUD_WRITE_ENABLED;
    } else {
      process.env.RECLOUD_WRITE_ENABLED = previousWriteEnabled;
    }
  });

  const server = createApp(connector).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(
    `${url}/api/crm/repairs/receipt-form/inspect`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ logisticsNo: "TEST-LOGISTICS-INSPECT" }),
    }
  );
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.data.inspection.confirmed, false);
  assert.deepEqual(calls, [
    ["query", "TEST-LOGISTICS-INSPECT"],
    ["inspect", true, false],
  ]);
});

test("inspection API exposes safe form-open failure stages and missingFields", async (t) => {
  const connector = {
    openRecloud: async () => ({ page: {} }),
    queryRmaByLogisticsNo: async () => ({ rmaNo: "JXTH-TEST-INSPECT" }),
    inspectReceiptForm: async () => {
      const error = new Error("synthetic safe failure");
      error.code = "RECLOUD_RECEIPT_FORM_NOT_OPENED";
      error.missingFields = ["receiptForm.dialog"];
      error.inspection = {
        receiptEntryFound: true,
        receiptEntryVisible: true,
        receiptEntryEnabled: true,
        receiptEntryClicked: true,
        dialogOpened: false,
        snInputFound: false,
        remarkInputFound: false,
        confirmButtonFound: false,
        missingFields: ["receiptForm.dialog"],
      };
      throw error;
    },
  };
  const previousDryRun = process.env.DRY_RUN;
  const previousWriteEnabled = process.env.RECLOUD_WRITE_ENABLED;
  process.env.DRY_RUN = "true";
  process.env.RECLOUD_WRITE_ENABLED = "false";
  t.after(() => {
    if (previousDryRun === undefined) delete process.env.DRY_RUN;
    else process.env.DRY_RUN = previousDryRun;
    if (previousWriteEnabled === undefined) {
      delete process.env.RECLOUD_WRITE_ENABLED;
    } else {
      process.env.RECLOUD_WRITE_ENABLED = previousWriteEnabled;
    }
  });
  const server = createApp(connector).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => server.close());

  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/api/crm/repairs/receipt-form/inspect`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ logisticsNo: "TEST-LOGISTICS-INSPECT" }),
    }
  );
  const result = await response.json();

  assert.equal(response.status, 502);
  assert.equal(result.code, "RECLOUD_RECEIPT_FORM_NOT_OPENED");
  assert.deepEqual(result.missingFields, ["receiptForm.dialog"]);
  assert.equal(result.inspection.receiptEntryClicked, true);
  assert.equal(result.inspection.dialogOpened, false);
});
