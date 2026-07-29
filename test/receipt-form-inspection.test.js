const test = require("node:test");
const assert = require("node:assert/strict");
const {
  inspectReceiptForm,
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
