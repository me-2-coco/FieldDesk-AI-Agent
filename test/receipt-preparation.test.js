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
  const store = new JsonReceiptPreparationStore(
    path.join(directory, "receipt-preparations.json")
  );
  const prepare = store.prepare.bind(store);
  store.prepare = async (input) => {
    const record = await prepare(input);
    await store.markModelAuthorization(record.rmaNo, { repairability: "SUPPORTED", status: "MATCHED" }, USERS.dual);
    return store.addReceiptAttachment(record.rmaNo, { id: "TEST-RECEIPT-PHOTO", name: "receipt.jpg", mimeType: "image/jpeg" }, USERS.dual);
  };
  return store;
}

async function startServer(t, connector, store, user = USERS.dual, options = {}) {
  const server = await new Promise((resolve, reject) => {
    const instance = createApp(connector, store, {
      getCurrentUser: () => user,
      feishuModelCatalog: options.feishuModelCatalog || { authorize: async () => ({ repairability: "SUPPORTED", status: "MATCHED", canContinue: true }) },
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

test("receipt preparation passes the Recloud current project into SN authorization", async (t) => {
  const store = await createTestStore(t);
  let authorizationInput = null;
  const url = await startServer(
    t,
    { openRecloud: async () => assert.fail("must not open Recloud") },
    store,
    USERS.sweep,
    {
      feishuModelCatalog: {
        authorize: async (input) => {
          authorizationInput = input;
          return {
            repairability: "SUPPORTED",
            status: "CHANGE_REQUIRED",
            currentProjectCode: input.currentProjectCode,
            projectCode: "R2580X",
            productModelCode: "010201AA000656",
          };
        },
      },
    }
  );
  const { response, result } = await post(
    url,
    "/api/repairs/prepare-receipt",
    validPayload({
      sn: "R2580X5AMCN0146633",
      currentProjectCode: "R25808",
    })
  );

  assert.equal(response.status, 200);
  assert.deepEqual(authorizationInput, {
    sn: "R2580X5AMCN0146633",
    currentProjectCode: "R25808",
  });
  assert.equal(result.data.recloudProjectCode, "R25808");
  assert.equal(result.data.authorization.productModelCode, "010201AA000656");
});

test("strict dry run may continue the local workflow when the current Recloud project is unavailable", async (t) => {
  const store = await createTestStore(t);
  const url = await startServer(
    t,
    { openRecloud: async () => assert.fail("must not open Recloud") },
    store,
    USERS.wash,
    {
      feishuModelCatalog: {
        authorize: async () => ({
          status: "CURRENT_PROJECT_MISSING",
          repairability: "REVIEW_REQUIRED",
          canContinue: false,
          reason: "未读取到瑞云当前项目号，不能判断是否需要修改",
        }),
      },
    }
  );
  const { response, result } = await post(
    url,
    "/api/repairs/prepare-receipt",
    validPayload({ productLine: "洗地机", specialty: "洗地机" })
  );

  assert.equal(response.status, 200);
  assert.equal(result.data.authorization.localWorkflowAllowed, true);
  assert.match(result.data.message, /可继续本地处理流程/);

  const attachment = await post(
    url,
    "/api/repairs/receipt/attachments",
    {
      rmaNo: "JXTH900001001",
      name: "receipt-second.jpg",
      mimeType: "image/jpeg",
      data: "data:image/jpeg;base64,VEVTVA==",
    }
  );
  assert.equal(attachment.response.status, 200);
  assert.equal(attachment.result.data.attachments.length, 2);

  const completed = await post(
    url,
    "/api/repairs/complete-local-receipt",
    { rmaNo: "JXTH900001001" }
  );
  assert.equal(completed.response.status, 200);
  assert.equal(completed.result.data.status, "RECEIVED_PENDING_INSPECTION");

  const treatment = await post(
    url,
    "/api/repairs/treatment-decision",
    { rmaNo: "JXTH900001001", treatmentMode: "REPAIR" }
  );
  assert.equal(treatment.response.status, 200);
  assert.equal(treatment.result.data.treatmentLabel, "维修");
  assert.equal(treatment.result.data.nextStep, "partsApplication");
});

test("SN is trimmed and normalized to uppercase", async (t) => {
  const store = await createTestStore(t);
  const saved = await store.prepare(validPayload());

  assert.equal(normalizeSn(" ab-c1 "), "AB-C1");
  assert.equal(saved.sn, "TEST-SN-A1");
});

test("existing local order resumes without opening Recloud", async (t) => {
  const store = await createTestStore(t);
  await store.prepare({
    ...validPayload(),
    operatorId: USERS.dual.userId,
    operatorName: USERS.dual.displayName,
  });
  await store.completeReceipt("JXTH900001001", USERS.dual);
  let recloudQueries = 0;
  const url = await startServer(t, {
    openRecloud: async () => {
      recloudQueries += 1;
      throw new Error("must not open Recloud for a local order");
    },
  }, store);

  const { response, result } = await post(
    url,
    "/api/crm/repairs/query",
    { queryValue: "JXTH900001001" }
  );

  assert.equal(response.status, 200);
  assert.equal(result.data.source, "FIELDDESK_LOCAL");
  assert.equal(result.data.localWorkflow.status, "RECEIVED_PENDING_INSPECTION");
  assert.equal(result.data.localWorkflow.sn, "TEST-SN-A1");
  assert.equal(recloudQueries, 0);
});

test("receipt preparation uses the validated specialty when CRM product line is empty", async (t) => {
  const store = await createTestStore(t);
  const connector = {
    openRecloud: async () => assert.fail("must not open Recloud"),
  };
  const url = await startServer(t, connector, store, USERS.wash);
  const { response, result } = await post(
    url,
    "/api/repairs/prepare-receipt",
    validPayload({ specialty: "洗地机", productLine: "" })
  );

  assert.equal(response.status, 200);
  assert.equal(result.data.productLine, "洗地机");
});

test("local receipt completion moves the order to pending inspection", async (t) => {
  const store = await createTestStore(t);
  await store.prepare({
    ...validPayload(),
    operatorId: USERS.sweep.userId,
    operatorName: USERS.sweep.displayName,
    remark: "扫地机",
  });

  const completed = await store.completeReceipt(
    "JXTH900001001",
    USERS.sweep
  );

  assert.equal(completed.status, "RECEIVED_PENDING_INSPECTION");
  assert.equal(completed.sn, "TEST-SN-A1");
  assert.equal(completed.productLine, "扫地机");
  assert.equal(completed.remark, "扫地机");
  assert.equal(completed.operatorName, USERS.sweep.displayName);
});

test("receipt cannot enter inspection before a receipt photo is uploaded", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fielddesk-receipt-photo-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new JsonReceiptPreparationStore(path.join(directory, "orders.json"));
  const prepared = await store.prepare(validPayload());
  await store.markModelAuthorization(prepared.rmaNo, { repairability: "SUPPORTED", status: "MATCHED" }, USERS.sweep);
  await assert.rejects(store.completeReceipt(prepared.rmaNo, USERS.sweep), { code: "RECEIPT_ATTACHMENT_REQUIRED" });
  const withPhoto = await store.addReceiptAttachment(prepared.rmaNo, { id: "PHOTO-1", name: "receipt.jpg", mimeType: "image/jpeg" }, USERS.sweep);
  assert.equal(withPhoto.receiptAttachments.length, 1);
  assert.equal((await store.completeReceipt(prepared.rmaNo, USERS.sweep)).status, "RECEIVED_PENDING_INSPECTION");
});

test("unsupported model is recorded for headquarters transfer and cannot enter inspection", async (t) => {
  const store = await createTestStore(t);
  const prepared = await store.prepare(validPayload({ rmaNo: "JXTH-UNSUPPORTED-1", sn: "W99990123456" }));
  const blocked = await store.markModelAuthorization(prepared.rmaNo, {
    status: "TRANSFER_TO_HEADQUARTERS",
    repairability: "UNSUPPORTED",
    canContinue: false,
  }, USERS.sweep);

  assert.equal(blocked.status, "TRANSFER_TO_HEADQUARTERS_PENDING");
  await assert.rejects(store.completeReceipt(prepared.rmaNo, USERS.sweep), {
    code: "MODEL_AUTHORIZATION_REQUIRED",
  });
  const transferred = await store.transferToHeadquarters(prepared.rmaNo, USERS.sweep);
  assert.equal(transferred.status, "TRANSFERRED_TO_HEADQUARTERS");
  assert.equal(transferred.receiptCompletedAt, undefined);
});

test("signed local order may be manually transferred to headquarters", async (t) => {
  const store = await createTestStore(t);
  const prepared = await store.prepare(validPayload({ rmaNo: "JXTH-MANUAL-TRANSFER-1" }));
  await store.markModelAuthorization(prepared.rmaNo, { repairability: "SUPPORTED", status: "MATCHED" }, USERS.sweep);
  await store.addReceiptAttachment(prepared.rmaNo, { id: "PHOTO-MANUAL", name: "receipt.jpg", mimeType: "image/jpeg" }, USERS.sweep);
  await store.completeReceipt(prepared.rmaNo, USERS.sweep);
  const transferred = await store.transferToHeadquarters(prepared.rmaNo, USERS.sweep);
  assert.equal(transferred.status, "TRANSFERRED_TO_HEADQUARTERS");
  assert.equal(transferred.treatmentMode, "TRANSFER_TO_HEADQUARTERS");
  assert.equal(transferred.treatmentLabel, "转寄总部");
});

test("inspection model match uses saved SN and product line without writing Recloud", async (t) => {
  const store = await createTestStore(t);
  await store.prepare(validPayload());
  await store.completeReceipt("JXTH900001001", USERS.sweep);
  let received;
  const app = createApp({ openRecloud: async () => assert.fail("must not open Recloud") }, store, {
    getCurrentUser: () => USERS.sweep,
    feishuModelCatalog: {
      match: async (input) => {
        received = input;
        return { status: "CHANGE_REQUIRED", currentModel: "M13", expectedModel: "M13S", candidates: ["M13S"] };
      },
    },
  });
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => server.close());
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/repairs/inspection/model-match`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rmaNo: "JXTH900001001", currentModel: "M13", projectCode: "W2211" }),
  });
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.data.autoAction, "REPLACE");
  assert.equal(result.data.expectedModel, "M13S");
  assert.equal(received.sn, "TEST-SN-A1");
  assert.equal(received.productLine, "扫地机");
});

test("inspection result and remark are saved locally without Recloud", async (t) => {
  const store = await createTestStore(t);
  await store.prepare({
    ...validPayload(),
    operatorId: USERS.sweep.userId,
    operatorName: USERS.sweep.displayName,
    remark: "扫地机",
  });
  await store.completeReceipt("JXTH900001001", USERS.sweep);

  const inspected = await store.saveInspection(
    "JXTH900001001",
    {
      inspectionResult: "主机无法启动",
      inspectionRemark: "待进一步拆机确认",
    },
    USERS.sweep
  );

  assert.equal(inspected.status, "INSPECTION_COMPLETED_PENDING_REPAIR");
  assert.equal(inspected.inspectionResult, "主机无法启动");
  assert.equal(inspected.inspectionRemark, "待进一步拆机确认");
});

test("inspection step may defer result entry until repair completion", async (t) => {
  const store = await createTestStore(t);
  await store.prepare(validPayload());
  await store.completeReceipt("JXTH900001001", USERS.sweep);

  const inspected = await store.saveInspection(
    "JXTH900001001",
    { inspectionResult: " " },
    USERS.sweep
  );
  assert.equal(inspected.inspectionResult, "");
  assert.equal(inspected.status, "INSPECTION_COMPLETED_PENDING_REPAIR");
});

test("part application is bound to the current order SN", async (t) => {
  const store = await createTestStore(t);
  await store.prepare(validPayload());
  await store.completeReceipt("JXTH900001001", USERS.sweep);
  await store.saveInspection(
    "JXTH900001001",
    { inspectionResult: "检测完成" },
    USERS.sweep
  );

  const result = await store.applyPart(
    "JXTH900001001",
    { code: "00100123", name: "主刷电机", stock: 10 },
    2,
    USERS.sweep
  );

  assert.equal(result.application.sn, "TEST-SN-A1");
  assert.equal(result.application.quantity, 2);
  assert.equal(result.application.retailPrice, null);
  assert.equal(result.order.partApplications.length, 1);

  const refreshed = await store.applyPart(
    "JXTH900001001",
    { code: "00100123", name: "售后主刷电机", stock: 10, retailPrice: 29, repairLevel: "中修", returnRequired: true },
    1,
    USERS.sweep
  );
  assert.equal(refreshed.application.quantity, 3);
  assert.equal(refreshed.application.partName, "售后主刷电机");
  assert.equal(refreshed.application.retailPrice, 29);
  assert.equal(refreshed.application.repairLevel, "中修");
  assert.equal(refreshed.application.returnRequired, true);
});

test("part application rejects zero stock", async (t) => {
  const store = await createTestStore(t);
  await store.prepare(validPayload());
  await store.completeReceipt("JXTH900001001", USERS.sweep);
  await store.saveInspection(
    "JXTH900001001",
    { inspectionResult: "检测完成" },
    USERS.sweep
  );

  await assert.rejects(
    store.applyPart(
      "JXTH900001001",
      { code: "00100345", name: "滚刷", stock: 0 },
      1,
      USERS.sweep
    ),
    { code: "PART_OUT_OF_STOCK" }
  );
});

test("local receipt and inspection APIs never open Recloud", async (t) => {
  const store = await createTestStore(t);
  const connector = {
    openRecloud: async () => assert.fail("must not open Recloud"),
  };
  const url = await startServer(t, connector, store, USERS.sweep);
  await store.prepare({
    ...validPayload({ sn: "W24480531TEST0001" }),
    operatorId: USERS.sweep.userId,
    operatorName: USERS.sweep.displayName,
    remark: "扫地机",
  });

  const completed = await post(
    url,
    "/api/repairs/complete-local-receipt",
    { rmaNo: "JXTH900001001" }
  );
  assert.equal(completed.response.status, 200);
  assert.equal(
    completed.result.data.status,
    "RECEIVED_PENDING_INSPECTION"
  );
  assert.equal(completed.result.data.recloudSynced, false);

  const inspected = await post(
    url,
    "/api/repairs/inspection",
    {
      rmaNo: "JXTH900001001",
      inspectionResult: "检测结果",
      inspectionRemark: "检测备注",
      faultCategory: "功能问题/无法启动",
      faultCategoryConfirmed: true,
      technicianWarranty: "保内",
      purchaseDate: "2026-01-01",
      warrantyYears: 2,
    }
  );
  assert.equal(inspected.response.status, 200);
  assert.equal(
    inspected.result.data.status,
    "INSPECTION_COMPLETED_PENDING_REPAIR"
  );
  assert.equal(inspected.result.data.recloudSynced, false);
  const prefillWrites = Object.fromEntries(
    inspected.result.data.recloudPrefillPlan.safeWrites.map((item) => [item.key, item.value])
  );
  assert.equal(prefillWrites.faultCategory, "功能问题/无法启动");
  assert.equal(prefillWrites.warrantyStatus, "保内");
  assert.equal(prefillWrites.detectionResult, "维修");
  assert.equal(inspected.result.data.recloudPrefillPlan.canAutoConfirm, false);
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
  assert.equal(result.data.message, "下放机型，可以维修");
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

test("frontend specialty gate accepts the signed-in lowercase technician role", async () => {
  const helpers = await import(
    "../frontend/src/shared/receiptPreparation.js"
  );

  assert.deepEqual(
    helpers.getReceiptSpecialtyGate({
      role: "technician",
      repairSpecialties: ["洗地机"],
    }, "洗地机"),
    {
      specialties: ["洗地机"],
      specialty: "洗地机",
      error: "",
    }
  );
});

test("frontend enables SN step and shows the local-only success message", async () => {
  const source = await fs.readFile(
    path.join(__dirname, "../frontend/src/pages/Repair.jsx"),
    "utf8"
  );

  assert.match(source, /onClick=\{startReceiptPreparation\}/);
  assert.match(source, /下一步：录入 SN/);
  assert.match(source, /当前为演练模式，不会操作瑞云签收/);
  assert.match(source, /mode=\{scannerMode\}/);
  assert.match(source, /重新扫码/);
  assert.match(source, /placeholder="请输入、扫描枪输入或使用摄像头扫描"/);
  assert.match(source, /currentProjectCode: repairDetail\.projectCode \|\| ""/);
  assert.match(source, /preparation\.authorization\?\.localWorkflowAllowed === true/);
  assert.match(source, /localWorkflow\.status !== "MODEL_AUTHORIZATION_REVIEW"/);
  assert.match(source, /上次演练停在项目号验证，可重新录入并继续本地流程/);
  assert.match(source, /receipt-inline-error/);
  assert.doesNotMatch(source, /recloudProjectCode: repairDetail\.projectCode/);
  assert.match(source, /function startReceiptPreparation\(\)[\s\S]*?setSn\(""\)[\s\S]*?setReceiptStep\("form"\)/);
  assert.doesNotMatch(source, /setSn\(normalizeReceiptSn\(repairDetail\?\.productSerialNo/);
  assert.doesNotMatch(source, /setSn\(resolvedSn\)/);
  assert.doesNotMatch(
    source,
    /<button disabled>\s*下一步：录入 SN/
  );
});

test("inspection page shows the required local order fields", async () => {
  const source = await fs.readFile(
    path.join(__dirname, "../frontend/src/pages/RepairProcess.jsx"),
    "utf8"
  );

  assert.match(source, /检测登记/);
  assert.match(source, /寄修单号/);
  assert.match(source, /物流单号/);
  assert.match(source, /SN/);
  assert.match(source, /产品线/);
  assert.match(source, /报修描述/);
  assert.doesNotMatch(source, /请输入检测结果/);
  assert.doesNotMatch(source, /请输入检测备注/);
  assert.match(source, /已检测/);
  assert.match(source, /待检测/);
  assert.match(source, /INSPECTION_COMPLETE/);
  assert.match(source, /瑞云预填复核清单/);
  assert.match(source, /系统不会自动点击瑞云“确认”/);
  assert.doesNotMatch(source, /配件申请/);
});

test("parts page provides live Feishu catalog and SN-bound application", async () => {
  const source = await fs.readFile(
    path.join(__dirname, "../frontend/src/pages/PartsApplication.jsx"),
    "utf8"
  );

  assert.match(source, /寄修单号/);
  assert.match(source, /SN/);
  assert.match(source, /维修品类/);
  assert.match(source, /零售价/);
  assert.match(source, /旧件需返厂/);
  assert.match(source, /searchPartsCatalog/);
  assert.match(source, /实时查询厂家飞书表/);
  assert.match(source, /申请数量/);
  assert.match(source, /不写入瑞云/);
});
