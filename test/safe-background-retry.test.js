const test = require("node:test");
const assert = require("node:assert/strict");
const { scheduleBackgroundRetry } = require("../services/safe-background-retry");

test("a failing retry does not leak a rejection or private error contents", async () => {
  const jobs = [];
  const logs = [];
  let unrefs = 0;
  const options = { setTimeout: job => { jobs.push(job); return { unref: () => unrefs++ }; },
    logger: { error: message => logs.push(message) } };
  scheduleBackgroundRetry(async () => { throw new Error("private synthetic data"); }, 10, options);
  let completed = false;
  scheduleBackgroundRetry(async () => { completed = true; }, 10, options);
  await Promise.all(jobs.map(job => job()));
  assert.equal(completed, true);
  assert.equal(unrefs, 2);
  assert.deepEqual(logs, ["RECLOUD_BACKGROUND_RETRY_FAILED"]);
});
