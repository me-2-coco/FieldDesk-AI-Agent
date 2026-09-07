const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isExpectedRmaStillOpen,
  readReceiptDetailWithReuse,
  readReceiptProjectIdentityWithRetry,
} = require("../server");

test("receipt chain keeps the current page when it still contains the verified RMA", async () => {
  const page = {
    locator(selector) {
      assert.equal(selector, "body");
      return { async innerText() { return "RMA JXTH202608304331 产品信息 附件"; } };
    },
  };
  assert.equal(await isExpectedRmaStillOpen(page, "JXTH202608304331"), true);
  assert.equal(await isExpectedRmaStillOpen(page, "JXTH-OTHER"), false);
});

test("receipt chain reuses the current verified RMA detail without rescanning", async () => {
  let reads = 0;
  let queries = 0;
  const connector = {
    async readRmaDetail() { reads += 1; return { rmaNo: "RMA-1", projectCode: "R9430" }; },
    async queryRmaByLogisticsNo() { queries += 1; return { rmaNo: "RMA-1" }; },
  };
  const detail = await readReceiptDetailWithReuse(connector, {}, {
    rmaNo: "RMA-1",
    logisticsNo: "SF-1",
  });
  assert.equal(detail.projectCode, "R9430");
  assert.equal(reads, 1);
  assert.equal(queries, 0);
});

test("receipt chain waits through a transient Recloud detail refresh before rescanning", async () => {
  let reads = 0;
  let queries = 0;
  const waits = [];
  const connector = {
    async readRmaDetail() {
      reads += 1;
      if (reads < 3) throw Object.assign(new Error("refreshing"), { code: "RMA_DETAIL_REGION_NOT_FOUND" });
      return { rmaNo: "RMA-1" };
    },
    async queryRmaByLogisticsNo() { queries += 1; return { rmaNo: "RMA-1" }; },
  };
  const page = { async waitForTimeout(ms) { waits.push(ms); } };
  await readReceiptDetailWithReuse(connector, page, { rmaNo: "RMA-1", logisticsNo: "SF-1" });
  assert.equal(reads, 3);
  assert.equal(queries, 0);
  assert.deepEqual(waits, [250, 250]);
});

test("receipt chain falls back to a fresh query when current detail is unavailable", async () => {
  let queries = 0;
  const connector = {
    async readRmaDetail() { throw Object.assign(new Error("not ready"), { code: "RMA_DETAIL_REGION_NOT_FOUND" }); },
    async queryRmaByLogisticsNo(_page, logisticsNo, options) {
      queries += 1;
      assert.equal(logisticsNo, "SF-1");
      assert.deepEqual(options, { preserveDetailPage: true });
      return { rmaNo: "RMA-1" };
    },
  };
  const page = { async waitForTimeout() {} };
  const detail = await readReceiptDetailWithReuse(connector, page, {
    rmaNo: "RMA-1",
    logisticsNo: "SF-1",
  }, { reuseAttempts: 2, pollMs: 0 });
  assert.equal(detail.rmaNo, "RMA-1");
  assert.equal(queries, 1);
});

test("project verification waits through a transient empty project code", async () => {
  let identityReads = 0;
  const waits = [];
  const connector = {
    async readRmaDetail() { return { rmaNo: "RMA-1", projectCode: "" }; },
    async queryRmaByLogisticsNo() { return { rmaNo: "RMA-1", projectCode: "" }; },
    async readRmaProductIdentity() {
      identityReads += 1;
      return identityReads < 3
        ? { sn: "SN-1", projectCode: "" }
        : { sn: "SN-1", projectCode: "R2502" };
    },
  };
  const page = { async waitForTimeout(ms) { waits.push(ms); } };
  const result = await readReceiptProjectIdentityWithRetry(
    connector,
    page,
    { rmaNo: "RMA-1", logisticsNo: "SF-1", sn: "SN-1", productLine: "扫地机" },
    { detail: { rmaNo: "RMA-1", projectCode: "" } },
    { attempts: 4, pollMs: 10 }
  );
  assert.equal(result.projectCode, "R2502");
  assert.equal(identityReads, 3);
  assert.deepEqual(waits, [10, 10]);
});
