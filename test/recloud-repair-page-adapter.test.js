const test = require("node:test");
const assert = require("node:assert/strict");
const {
  clickApprovalFlowInput,
  dismissBlockingRepairMessageBoxes,
  readApprovalFlow,
} = require("../connectors/recloud-repair-page-adapter");

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
    async waitFor(options) { assert.deepEqual(options, { state: "hidden", timeout: 8000 }); },
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
  assert.deepEqual(clicks, [{ timeout: 5000 }]);
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
