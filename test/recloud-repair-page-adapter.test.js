const test = require("node:test");
const assert = require("node:assert/strict");
const {
  clickApprovalFlowInput,
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
