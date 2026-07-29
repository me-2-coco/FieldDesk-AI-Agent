const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const {
  JsonReceiptPreparationStore,
  normalizeSn,
} = require("../database/receipt-preparation-store");
const {
  createApp,
  normalizeMaskedPhone,
  resolveReceiptSpecialty,
} = require("../server");

const USERS = {
  sweep: {
    userId: "TEST-SWEEP",
    displayName: "测试扫地机师傅",
    role: "TECHNICIAN",
    repairSpecialties: ["扫地机"],
  },
  wash: {
    userId: "TEST-WASH",
    displayName: "测试洗地机师傅",
    role: "TECHNICIAN",
    repairSpecialties: ["洗地机"],
  },
  dual: {
    userId: "TEST-DUAL",
    displayName: "测试双品类师傅",
    role: "TECHNICIAN",
    repairSpecialties: ["扫地机", "洗地机"],
  },
  none: {
    userId: "TEST-NONE",
    displayName: "测试无品类账号",
    role: "WAREHOUSE",
    repairSpecialties: [],
  },
};

async function createTestStore(t) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "fielddesk-receipt-test-")
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return new JsonReceiptPreparationStore(
    path.join(directory, "receipt-preparations.json")
  );
}

async function startServer(t, connector, store, user = USERS.dual) {
  const server = await new Promise((resolve, reject) => {
    const instance = createApp(connector, store, {
      getCurrentUser: () => user,
    }).listen(
      0,
      "127.0.0.1",
      () => resolve(instance)
    );
    instance.on("error", reject);
  });
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

async function post(url, pathName, body) {
  const response = await fetch(`${url}${pathName}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { response, result: await response.json() };
}

function validPayload(overrides = {}) {
  return {
    logisticsNo: "TEST-LOGISTICS-1001",
    rmaNo: "JXTH900001001",
    sn: " test-sn-a1 ",
    specialty: "扫地机",
    remark: "伪造备注",
    productLine: "扫地机",
    customerName: "测试用户",
    phoneMasked: "138****1001",
    reportedFault: "测试故障",
    ...overrides,
  };
}

test("receipt preparation rejects an empty SN", async (t) => {
  const store = await createTestStore(t);
  const connector = {
    openRecloud: async () => assert.fail("must not open Recloud"),
  };
  const url = await startServer(t, connector, store, USERS.sweep);
  const { response, result } = await post(
    url,
    "/api/repairs/prepare-receipt",
    validPayload({ sn: " " })
  );

  assert.equal(response.status, 400);
  assert.equal(result.code, "RECEIPT_SN_REQUIRED");
  assert.equal(result.message, "SN 不能为空");
});

test("SN is trimmed and normalized to uppercase", async (t) => {
  const store = await createTestStore(t);
  const saved = await store.prepare(validPayload());

  assert.equal(normalizeSn(" ab-c1 "), "AB-C1");
  assert.equal(saved.sn, "TEST-SN-A1");
});

test("sweep and wash accounts generate their authorized remarks", () => {
  assert.equal(resolveReceiptSpecialty(USERS.sweep, "扫地机", ""), "扫地机");
  assert.equal(resolveReceiptSpecialty(USERS.wash, "洗地机", ""), "洗地机");
});

test("admin can handle both specialties but must determine this order specialty", () => {
  const admin = {
    userId: "TEST-ADMIN",
    displayName: "测试管理员",
    role: "ADMIN",
    repairSpecialties: [],
  };
  assert.throws(
    () => resolveReceiptSpecialty(admin, "未提供", ""),
    (error) => error.code === "REPAIR_SPECIALTY_REQUIRED"
  );
  assert.equal(
    resolveReceiptSpecialty(admin, "未提供", "洗地机"),
    "洗地机"
  );
});

test("local preparation accepts only a safely masked phone", () => {
  assert.equal(normalizeMaskedPhone("138****1001"), "138****1001");
  assert.equal(normalizeMaskedPhone("13812341001"), "");
  assert.equal(normalizeMaskedPhone("13812341001*"), "");
});

test("dual-specialty account must select the order specialty", async (t) => {
  const store = await createTestStore(t);
  const url = await startServer(
    t,
    { openRecloud: async () => assert.fail("must not open Recloud") },
    store
  );
  const { response, result } = await post(
    url,
    "/api/repairs/prepare-receipt",
    validPayload({
      specialty: "",
      remark: "前端伪造备注",
      productLine: "未提供",
    })
  );

  assert.equal(response.status, 400);
  assert.match(result.message, /请选择本单维修品类/);
});

test("account without a specialty cannot prepare receipt", async (t) => {
  const store = await createTestStore(t);
  const url = await startServer(
    t,
    { openRecloud: async () => assert.fail("must not open Recloud") },
    store,
    USERS.none
  );
  const { response, result } = await post(
    url,
    "/api/repairs/prepare-receipt",
    validPayload()
  );

  assert.equal(response.status, 403);
  assert.equal(result.message, "当前账号未配置维修品类，请联系管理员");
});

test("order product line must be within account specialties", async (t) => {
  const store = await createTestStore(t);
  const url = await startServer(
    t,
    { openRecloud: async () => assert.fail("must not open Recloud") },
    store,
    USERS.sweep
  );
  const { response, result } = await post(
    url,
    "/api/repairs/prepare-receipt",
    validPayload({ productLine: "洗地机", specialty: "扫地机" })
  );

  assert.equal(response.status, 403);
  assert.equal(result.message, "该工单属于洗地机，当前账号无维修权限");
});

test("same RMA submission updates idempotently", async (t) => {
  const store = await createTestStore(t);
  const first = await store.prepare(validPayload());
  const second = await store.prepare(
    validPayload({ sn: "updated-sn", remark: "更新备注" })
  );
  const records = await store.readAll();

  assert.equal(second.id, first.id);
  assert.equal(second.createdAt, first.createdAt);
  assert.equal(second.sn, "UPDATED-SN");
  assert.equal(records.length, 1);
});

test("same SN cannot bind another unfinished RMA", async (t) => {
  const store = await createTestStore(t);
  await store.prepare(validPayload({ sn: "shared-sn" }));

  await assert.rejects(
    store.prepare(
      validPayload({
        logisticsNo: "TEST-LOGISTICS-1002",
        rmaNo: "JXTH900001002",
        sn: "SHARED-SN",
      })
    ),
    (error) => error.code === "SN_ALREADY_BOUND"
  );
});

test("prepare API ignores forged remark and specialties from frontend", async (t) => {
  const store = await createTestStore(t);
  let recloudCalls = 0;
  const connector = {
    async openRecloud() {
      recloudCalls += 1;
      assert.fail("local receipt preparation must not open Recloud");
    },
  };
  const url = await startServer(t, connector, store, USERS.wash);
  const { response, result } = await post(
    url,
    "/api/repairs/prepare-receipt",
    validPayload({
      productLine: "洗地机",
      specialty: "洗地机",
      remark: "扫地机",
      repairSpecialties: ["扫地机"],
    })
  );

  assert.equal(response.status, 200);
  assert.equal(result.data.remark, "洗地机");
  assert.equal(result.data.specialty, "洗地机");
  assert.equal(result.data.status, "RECEIPT_PREPARED");
  assert.equal(result.data.message, "签收资料已准备，尚未同步瑞云");
  assert.equal(result.data.recloudSynced, false);
  assert.equal(result.data.operatorId, "TEST-WASH");
  assert.equal(result.data.operatorName, "测试洗地机师傅");
  assert.equal(result.data.operatorTemporary, true);
  assert.equal(recloudCalls, 0);
});

test("cancel changes only the local preparation status", async (t) => {
  const store = await createTestStore(t);
  const url = await startServer(
    t,
    { openRecloud: async () => assert.fail("must not open Recloud") },
    store,
    USERS.sweep
  );
  await store.prepare(validPayload());

  const { response, result } = await post(
    url,
    "/api/repairs/prepare-receipt/cancel",
    { rmaNo: "JXTH900001001" }
  );

  assert.equal(response.status, 200);
  assert.equal(result.data.status, "RECEIPT_PREPARATION_CANCELLED");
  assert.equal(result.data.recloudSynced, false);
});

test("current-user API exposes only the server-side account profile", async (t) => {
  const store = await createTestStore(t);
  const url = await startServer(t, {}, store, USERS.dual);
  const response = await fetch(`${url}/api/auth/me`);
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(result.data, {
    userId: "TEST-DUAL",
    displayName: "测试双品类师傅",
    role: "TECHNICIAN",
    repairSpecialties: ["扫地机", "洗地机"],
  });
  assert.equal("password" in result.data, false);
});

test("logistics number scanned as SN is rejected", async (t) => {
  const store = await createTestStore(t);
  const url = await startServer(
    t,
    { openRecloud: async () => assert.fail("must not open Recloud") },
    store,
    USERS.sweep
  );
  const { response, result } = await post(
    url,
    "/api/repairs/prepare-receipt",
    validPayload({
      logisticsNo: "SF1234567890",
      sn: " sf1234567890 ",
    })
  );

  assert.equal(response.status, 400);
  assert.match(result.message, /疑似物流单号/);
});

test("SN scan normalization uppercases without auto-submitting", async () => {
  const helpers = await import(
    "../frontend/src/shared/receiptPreparation.js"
  );

  assert.equal(helpers.normalizeReceiptSn(" sn-ab12 \n"), "SN-AB12");
  assert.equal(helpers.validateReceiptSn("SN-AB12", "SF12345678"), "");
  assert.match(
    helpers.validateReceiptSn("sf12345678", "SF12345678"),
    /疑似物流单号/
  );
});

test("frontend enables SN step and shows the local-only success message", async () => {
  const source = await fs.readFile(
    path.join(__dirname, "../frontend/src/pages/Repair.jsx"),
    "utf8"
  );

  assert.match(
    source,
    /onClick=\{startReceiptPreparation\}[\s\S]{0,160}下一步：录入 SN/
  );
  assert.match(source, /签收资料已准备，尚未同步瑞云/);
  assert.match(source, /mode=\{scannerMode\}/);
  assert.match(source, /重新扫码/);
  assert.match(source, /placeholder="请输入、扫描枪输入或使用摄像头扫描"/);
  assert.doesNotMatch(
    source,
    /<button disabled>\s*下一步：录入 SN/
  );
});
