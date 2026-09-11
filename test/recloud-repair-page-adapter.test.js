const test = require("node:test");
const assert = require("node:assert/strict");
test("submit checks delayed notices before every click attempt", async () => {
  let checks = 0;
  let clicks = 0;
  const page = { locator: () => ({ count: async () => 0 }), waitForTimeout: async () => {} };
  await clickAfterLoadingSettles(page, { click: async () => {
    assert.equal(checks, clicks + 1);
    if (++clicks === 1) throw new Error("notice intercepts pointer events");
  } }, { beforeAttempt: async () => { checks++; } });
  assert.equal(clicks, 2);
});

test("unknown submit notices stop without closing or confirming", async () => {
  const dialog = { innerText: async () => "请确认扣费", locator: () => { throw new Error("must not click"); } };
  const page = { waitForTimeout: async () => {}, locator: () => ({ count: async () => 1, last: () => dialog }) };
  await assert.rejects(dismissBlockingRepairMessageBoxes(page, { knownNoticesOnly: true }), { code: "RECLOUD_REPAIR_UNKNOWN_SUBMIT_NOTICE" });
});
const {
  clickAfterLoadingSettles,
  clickApprovalFlowInput,
  dismissBlockingRepairMessageBoxes,
  ensurePicklistValue,
  isRecloudRepairFullySubmitted,
  readApprovalFlow,
  waitForDialog,
  waitForRepairSubmissionConfirmed,
} = require("../connectors/recloud-repair-page-adapter");

test("missing required Recloud picklist is filled and verified", async () => {
  let value = "";
  const input = {
    async count() { return 1; },
    async inputValue() { return value; },
    async click() {},
  };
  const item = {
    locator() { return { first() { return input; } }; },
  };
  const option = {
    async click() { value = "霍尔组件不良"; },
  };
  const page = {
    locator() {
      return {
        filter() { return this; },
        async count() { return 1; },
        first() { return option; },
      };
    },
    async waitForTimeout() {},
  };

  assert.equal(await ensurePicklistValue(page, item, "霍尔组件不良", "故障三级分类"), true);
  assert.equal(value, "霍尔组件不良");
});

test("matching Recloud picklist is left unchanged", async () => {
  let clicked = false;
  const input = {
    async count() { return 1; },
    async inputValue() { return "产品质量"; },
    async click() { clicked = true; },
  };
  const item = { locator() { return { first() { return input; } }; } };

  assert.equal(await ensurePicklistValue({}, item, "产品质量", "故障一级分类"), false);
  assert.equal(clicked, false);
});

test("Recloud autocomplete commits a lookup value with keyboard selection", async () => {
  let value = "";
  const keys = [];
  const input = {
    async count() { return 1; },
    async inputValue() { return value; },
    async getAttribute(name) { return name === "type" ? "autocomplete" : value; },
    async click() {},
    async fill(next) { value = next; },
    async press(key) { keys.push(key); },
  };
  const item = { locator() { return { first() { return input; } }; } };
  const page = { async waitForTimeout() {} };

  assert.equal(await ensurePicklistValue(page, item, "霍尔组件不良", "故障三级分类"), true);
  assert.deepEqual(keys, ["ArrowDown", "Enter"]);
});

test("Recloud multi-select value is read from its visible selected tag", async () => {
  const selected = { async allInnerTexts() { return [" 否 "]; } };
  const input = {
    async count() { return 1; },
    async inputValue() { return ""; },
    async click() { assert.fail("matching selected tag must not reopen the dropdown"); },
  };
  const item = {
    locator(selector) {
      if (selector.includes("rt-picklist__tags")) return selected;
      return { first() { return input; } };
    },
  };

  assert.equal(await ensurePicklistValue({}, item, "否", "是否是排障问题"), false);
});

test("dialog opened by an action stays bound when a later notice appears", async () => {
  const openedDialog = { id: "assignment" };
  let count = 0;
  const dialogs = {
    async count() {
      count += 1;
      return count === 1 ? 0 : 2;
    },
    nth(index) {
      assert.equal(index, 0);
      return openedDialog;
    },
    last() {
      throw new Error("must not use a dynamic last() locator");
    },
  };
  const page = {
    locator() { return dialogs; },
    async waitForTimeout() {},
  };

  assert.equal(await waitForDialog(page, 0), openedDialog);
});

test("已完工 is not terminal while the final 提交 button is still visible", async () => {
  const visible = { async count() { return 1; } };
  const hidden = { async count() { return 0; } };
  const chain = (result) => ({ filter() { return result; } });
  const page = {
    getByText() { return chain(visible); },
    getByRole(role, options = {}) {
      if (role === "button" && options.name instanceof RegExp && options.name.test("提交")) return chain(visible);
      return chain(hidden);
    },
  };
  assert.equal(await isRecloudRepairFullySubmitted(page), false);
});

test("已完工 becomes terminal after the final 提交 button disappears", async () => {
  const visible = { async count() { return 1; } };
  const hidden = { async count() { return 0; } };
  const page = {
    getByText() { return { filter() { return visible; } }; },
    getByRole() { return { filter() { return hidden; } }; },
  };
  assert.equal(await isRecloudRepairFullySubmitted(page), true);
});

test("submit waits for the Recloud loading mask and retries intercepted clicks", async () => {
  let maskChecks = 0;
  let clickAttempts = 0;
  const waits = [];
  const page = {
    locator(selector) {
      assert.match(selector, /rt-loading-mask/);
      return { async count() { maskChecks += 1; return maskChecks === 1 ? 1 : 0; } };
    },
    async waitForTimeout(ms) { waits.push(ms); },
  };
  const button = {
    async click() {
      clickAttempts += 1;
      if (clickAttempts === 1) throw new Error("loading mask intercepts pointer events");
    },
  };

  await clickAfterLoadingSettles(page, button, { timeoutMs: 5000, pollIntervalMs: 10 });
  assert.equal(clickAttempts, 2);
  assert.deepEqual(waits, [10, 10]);
});

test("submit treats a Recloud terminal state as success while its loading mask remains", async () => {
  let terminalChecks = 0;
  let clickAttempts = 0;
  const page = {
    locator() {
      return { async count() { return 1; } };
    },
    async waitForTimeout() {},
  };
  const button = { async click() { clickAttempts += 1; } };

  const result = await clickAfterLoadingSettles(page, button, {
    timeoutMs: 5000,
    pollIntervalMs: 10,
    async successCheck() {
      terminalChecks += 1;
      return terminalChecks === 2;
    },
  });

  assert.deepEqual(result, { clicked: false, alreadySucceeded: true });
  assert.equal(clickAttempts, 0);
});

test("final submit confirmation polls until the submitted state appears", async () => {
  let checks = 0;
  const visible = { async count() { checks += 1; return 1; } };
  const pending = { async count() { return checks < 3 ? 1 : 0; } };
  const chain = (result) => ({ filter() { return result; } });
  const page = {
    getByText() { return chain(visible); },
    getByRole() { return chain(pending); },
    async waitForTimeout() {},
  };

  assert.equal(await waitForRepairSubmissionConfirmed(page, { timeoutMs: 100, pollIntervalMs: 1 }), true);
  assert.equal(checks, 3);
});

test("approval flow is read from the visible selected tag when the search input is empty", async () => {
  const dialog = {
    locator(selector) {
      assert.match(selector, /rt-picklist__tags/);
      return { async allInnerTexts() { return [" 内部维修单自动审批（成都欣益） "]; } };
    },
  };
  const input = { async inputValue() { return ""; } };

  assert.equal(
    await readApprovalFlow(dialog, input),
    "内部维修单自动审批（成都欣益）"
  );
});

test("approval flow falls back to the input value when no selected tag exists", async () => {
  const dialog = {
    locator() {
      return { async allInnerTexts() { return []; } };
    },
  };
  const input = { async inputValue() { return " 内部维修单自动审批（成都欣益） "; } };

  assert.equal(
    await readApprovalFlow(dialog, input),
    "内部维修单自动审批（成都欣益）"
  );
});

test("approval flow refuses multiple selected values", async () => {
  const dialog = {
    locator() {
      return { async allInnerTexts() { return ["流程甲", "流程乙"]; } };
    },
  };

  await assert.rejects(
    readApprovalFlow(dialog, { async inputValue() { return ""; } }),
    { code: "RECLOUD_REPAIR_APPROVAL_FLOW_AMBIGUOUS", phase: "SUBMIT" }
  );
});

test("approval flow input retries with force only for selected-tag interception", async () => {
  const calls = [];
  const input = {
    async click(options) {
      calls.push(options);
      if (!options.force) throw new Error("element intercepts pointer events");
    },
  };

  await clickApprovalFlowInput(input);
  assert.deepEqual(calls, [
    { timeout: 3000 },
    { timeout: 3000, force: true },
  ]);
});

test("repair assignment closes a blocking Recloud model notice with the top-right X", async () => {
  let visible = true;
  const clicks = [];
  const dialog = {
    async innerText() { return "维修服务单创建成功"; },
    locator(selector) {
      assert.match(selector, /message-box__headerbtn/);
      return {
        async count() { return 1; },
        first() {
          return {
            async click(clickOptions) {
              clicks.push(clickOptions);
              visible = false;
            },
          };
        },
      };
    },
  };
  const page = {
    locator(selector) {
      assert.match(selector, /message-box/);
      return {
        async count() { return visible ? 1 : 0; },
        last() { return dialog; },
      };
    },
    async waitForTimeout() {},
  };

  assert.equal(await dismissBlockingRepairMessageBoxes(page), 1);
  assert.deepEqual(clicks, [{ timeout: 5000, force: true }]);
});

test("repair assignment accepts a notice that disappears during the close click", async () => {
  let visible = true;
  const dialog = {
    async innerText() { return "延迟出现的特殊服务项目"; },
    locator() {
      return {
        async count() { return 1; },
        first() {
          return {
            async click() {
              visible = false;
              throw new Error("element is not visible");
            },
          };
        },
      };
    },
  };
  const page = {
    locator() {
      return {
        async count() { return visible ? 1 : 0; },
        last() { return dialog; },
        async allInnerTexts() { return visible ? ["延迟出现的特殊服务项目"] : []; },
      };
    },
    async waitForTimeout() {},
  };

  assert.equal(await dismissBlockingRepairMessageBoxes(page), 1);
});

test("repair assignment closes consecutive model notices without waiting on a dynamic last locator", async () => {
  const notices = ["第一条提示", "第二条提示"];
  const closed = [];
  const dynamicDialog = {
    async innerText() { return notices.at(-1) || ""; },
    locator() {
      return {
        async count() { return notices.length ? 1 : 0; },
        first() {
          return {
            async click() {
              closed.push(notices.pop());
            },
          };
        },
      };
    },
    async waitFor() {
      throw new Error("must not wait on a dynamic last() locator");
    },
  };
  const page = {
    locator() {
      return {
        async count() { return notices.length; },
        last() { return dynamicDialog; },
      };
    },
    async waitForTimeout() {},
  };

  assert.equal(await dismissBlockingRepairMessageBoxes(page), 2);
  assert.deepEqual(closed, ["第二条提示", "第一条提示"]);
});

test("repair assignment never confirms a model notice when the top-right X is unavailable", async () => {
  const dialog = {
    async innerText() { return "未知业务确认"; },
    locator() {
      return {
        async count() { return 0; },
      };
    },
  };
  const page = {
    locator() {
      return {
        async count() { return 1; },
        last() { return dialog; },
      };
    },
    async waitForTimeout() {},
  };

  await assert.rejects(
    dismissBlockingRepairMessageBoxes(page),
    { code: "RECLOUD_REPAIR_MESSAGE_CLOSE_AMBIGUOUS", phase: "ASSIGNMENT" }
  );
});
