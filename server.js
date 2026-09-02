const express = require("express");
const crypto = require("crypto");
const http = require("http");
const https = require("https");
const path = require("path");
if (require.main === module) {
  try {
    process.loadEnvFile?.();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
const recloudConnector = require("./connectors/recloud");
const { normalizeSn } = require("./database/receipt-preparation-store");
const { createBusinessStores } = require("./database/business-store-factory");
const { AccountStore } = require("./database/account-store");
const { WorkCoordinationStore } = require("./database/work-coordination-store");
const { PendingReceiptStore } = require("./database/pending-receipt-store");
const { RmaQueryCacheStore } = require("./database/rma-query-cache-store");
const { validateRuntimeConfig, loadTlsOptions } = require("./config/runtime-config");
const { createRateLimiter, securityHeaders, RotatingJsonLogger, requestLogger } = require("./services/operational-security");
const { LocalRepairAttachmentStore } = require("./database/repair-attachment-store");
const { LocalShippingAttachmentStore } = require("./database/shipping-attachment-store");
const { JsonRecloudSyncOutbox } = require("./database/recloud-sync-outbox");
const { createRecloudAdapter } = require("./connectors/recloud-adapter");
const { RecloudSyncService } = require("./services/recloud-sync-service");
const { createRecloudCommandExecutor } = require("./services/recloud-command-executor");
const { assessRecloudRepairPageReadiness } = require("./services/recloud-repair-page-readiness");
const { JsonRecloudSyncDiagnosticsStore } = require("./database/recloud-sync-diagnostics-store");
const { JsonRecloudRepairCheckpointStore } = require("./database/recloud-repair-checkpoint-store");
const { JsonRecloudFaultCatalogStore } = require("./database/recloud-fault-catalog-store");
const { RecloudSyncDiagnosticsService } = require("./services/recloud-sync-diagnostics-service");
const { FeishuModelCatalog, getSnProjectMatch } = require("./connectors/feishu-model-catalog");
const { FeishuPartsCatalog } = require("./connectors/feishu-parts-catalog");
const { evaluateWarranty } = require("./services/warranty-policy");
const localFaultMappings = require("./knowledge/fault_mapping.json").mappings || {};
const { resolvePartsFee, resolveOutOfWarrantyFee, buildPricingPreview } = require("./services/out-of-warranty-pricing");
const { resolveRepairCharge } = require("./services/repair-charge-policy");
const { analyzeSupervisionOrder } = require("./services/supervision-order-policy");
const {
  queryRepairHistory,
  findMachineRepairHistory,
  queryMachinesInHand,
} = require("./services/repair-history-query");
const {
  buildInformationRepairReport,
  findAttachment,
  reportAttachments,
  searchInformationRepairReports,
} = require("./services/information-repair-report");
const { detectOrderExceptions, detectSyncExceptions, sortExceptions } = require("./services/information-exception-center");
const {
  RecloudSupervisionMonitor,
  monitorEnabled,
  monitorInterval,
} = require("./services/recloud-supervision-monitor");
const { PendingReceiptSync, pendingReceiptSyncEnabled, pendingReceiptSyncInterval } = require('./services/pending-receipt-sync');
const { buildInspectionFormDecision } = require("./services/inspection-form-rules");
const {
  assessRecloudInspectionControlMapping,
  buildRecloudInspectionFormPlan,
} = require("./connectors/recloud-sync-mapping");
const {
  USER_ROLES,
  getLocalCurrentUser,
} = require("./config/local-users");

const SUPPORTED_REPAIR_SPECIALTIES = Object.freeze(["扫地机", "洗地机"]);

function getOutOfWarrantyFeePolicy(order = {}) {
  const treatmentMode = String(order.treatmentMode || "REPAIR").trim() || "REPAIR";
  const noPartsService = ["ABANDONED", "INSPECTION_ONLY", "DEBUGGING"].includes(treatmentMode);
  const nonChargeableTreatment = ["ABANDONED", "INSPECTION_ONLY"].includes(treatmentMode);
  const isOutOfWarranty = order.technicianWarranty === "保外" && !nonChargeableTreatment;
  return {
    noPartsService,
    isOutOfWarranty,
    requiresOutOfWarrantyFee: isOutOfWarranty && treatmentMode === "REPAIR",
  };
}

const LOCAL_FAULT_CATALOG = Object.freeze([
  { name: "功能故障", children: [
    { name: "清洁功能", children: ["不出水", "不吸水", "清洁效果差"] },
    { name: "行走功能", children: ["无法行走", "原地打转", "路径异常"] },
  ] },
  { name: "电气故障", children: [
    { name: "供电系统", children: ["无法开机", "异常关机", "无法充电"] },
    { name: "传感系统", children: ["传感器异常", "避障异常", "地图异常"] },
  ] },
  { name: "结构故障", children: [
    { name: "机身结构", children: ["外壳损坏", "轮组损坏", "刷组损坏"] },
  ] },
]);

function recentRmaBackfillStart(monthCount = 3, now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, Number(value)]));
  const start = new Date(Date.UTC(values.year, values.month - monthCount, 1));
  return `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}-01T00:00:00+08:00`;
}

function buildFaultHierarchy(paths) {
  const roots = new Map();
  for (const value of paths || []) {
    const parts = String(value || "").split("/").map((item) => item.trim()).filter(Boolean);
    if (parts.length < 3) continue;
    if (!roots.has(parts[0])) roots.set(parts[0], new Map());
    const level2 = roots.get(parts[0]);
    if (!level2.has(parts[1])) level2.set(parts[1], new Set());
    level2.get(parts[1]).add(parts.slice(2).join(" / "));
  }
  return [...roots].map(([name, children]) => ({
    name,
    children: [...children].map(([childName, leaves]) => ({ name: childName, children: [...leaves] })),
  }));
}

function normalizeLogisticsNo(value) {
  return String(value || "").trim();
}

function isDryRun(env = process.env) {
  // 安全默认：仅显式设置 DRY_RUN=false 才允许最终确认。
  return String(env.DRY_RUN ?? "true").toLowerCase() !== "false";
}

function isRecloudWriteEnabled(env = process.env) {
  return String(env.RECLOUD_WRITE_ENABLED ?? "false").toLowerCase() === "true";
}

function normalizeMaskedPhone(value) {
  const phone = String(value || "").replace(/\s/g, "");
  return /^1[3-9]\d\*{4}\d{4}$/.test(phone) ? phone : "";
}

function phoneMatches(storedPhone, completePhone) {
  const query = String(completePhone || '').replace(/\D/g, '');
  if (!/^1[3-9]\d{9}$/.test(query)) return false;
  const stored = String(storedPhone || '').replace(/\s/g, '');
  if (stored === query) return true;
  const masked = normalizeMaskedPhone(stored);
  return Boolean(masked)
    && masked.slice(0, 3) === query.slice(0, 3)
    && masked.slice(-4) === query.slice(-4);
}

function createApiError(code, message, status) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function getAllowedRepairSpecialties(user) {
  if (user?.role === USER_ROLES.ADMIN) {
    return [...SUPPORTED_REPAIR_SPECIALTIES];
  }
  if (user?.role !== USER_ROLES.TECHNICIAN) return [];
  return Array.isArray(user?.repairSpecialties)
    ? user.repairSpecialties.filter((item) =>
        SUPPORTED_REPAIR_SPECIALTIES.includes(item)
      )
    : [];
}

function resolveReceiptSpecialty(user, productLine, requestedSpecialty) {
  const allowed = getAllowedRepairSpecialties(user);
  if (allowed.length === 0) {
    throw createApiError(
      "REPAIR_SPECIALTY_NOT_CONFIGURED",
      "当前账号未配置维修品类，请联系管理员",
      403
    );
  }

  const recognizedProduct = SUPPORTED_REPAIR_SPECIALTIES.includes(productLine)
    ? productLine
    : "";
  if (recognizedProduct && !allowed.includes(recognizedProduct)) {
    throw createApiError(
      "REPAIR_SPECIALTY_FORBIDDEN",
      `该工单属于${recognizedProduct}，当前账号无维修权限`,
      403
    );
  }

  if (allowed.length === 1) return allowed[0];

  const requested = String(requestedSpecialty || "").trim();
  if (!requested) {
    throw createApiError(
      "REPAIR_SPECIALTY_REQUIRED",
      "请选择本单维修品类",
      400
    );
  }
  if (!allowed.includes(requested)) {
    throw createApiError(
      "REPAIR_SPECIALTY_FORBIDDEN",
      "所选维修品类不在当前账号权限范围内",
      403
    );
  }
  if (recognizedProduct && requested !== recognizedProduct) {
    throw createApiError(
      "REPAIR_SPECIALTY_MISMATCH",
      `该工单属于${recognizedProduct}，请选择对应维修品类`,
      400
    );
  }
  return requested;
}

function validateReceiptSn(value, logisticsNo = "") {
  const sn = normalizeSn(value);
  if (!sn) {
    throw createApiError("RECEIPT_SN_REQUIRED", "SN 不能为空", 400);
  }
  if (!/^[A-Z0-9-]+$/.test(sn)) {
    throw createApiError(
      "RECEIPT_SN_INVALID",
      "SN 只允许字母、数字和连字符“-”",
      400
    );
  }
  const normalizedLogisticsNo = normalizeLogisticsNo(logisticsNo).toUpperCase();
  if (
    sn === normalizedLogisticsNo ||
    /^(SF|YT|JD|ST|ZTO|YTO|EMS)[A-Z0-9-]{6,}$/.test(sn)
  ) {
    throw createApiError(
      "RECEIPT_SN_LOOKS_LIKE_LOGISTICS",
      "扫描内容疑似物流单号，请重新扫描机器 SN",
      400
    );
  }
  return sn;
}

async function withRecloud(connector, operation, options = {}) {
  let state = withRecloud.queues.get(connector);
  if (!state) {
    state = { tail: Promise.resolve(), foregroundWaiting: 0 };
    withRecloud.queues.set(connector, state);
  }
  const foreground = options.background !== true;
  if (foreground) state.foregroundWaiting += 1;
  const previous = state.tail;
  const current = previous.catch(() => {}).then(async () => {
    const session = await connector.openRecloud();
    if (session.loginRequired) {
      const error = new Error("请重新初始化瑞云登录状态");
      error.code = "RECLOUD_LOGIN_REQUIRED";
      throw error;
    }
    return await operation(session.page, {
      shouldYield: () => options.background === true && state.foregroundWaiting > 0,
    });
  }).finally(() => {
    if (foreground) state.foregroundWaiting = Math.max(0, state.foregroundWaiting - 1);
  });
  state.tail = current;
  return current;
}
withRecloud.queues = new WeakMap();

async function initializeRecloudSession(connector, logger = console) {
  try {
    return await connector.openRecloud();
  } catch (error) {
    if (error.code === "RECLOUD_PROFILE_IN_USE") {
      logger.error(
        "RECLOUD_SESSION: profile_in_use - 浏览器资料目录已被其他后端占用"
      );
    } else {
      const safeCode = [
        "RECLOUD_AUTO_LOGIN_FAILED",
        "RECLOUD_KEYCHAIN_UNAVAILABLE",
        "RECLOUD_LOGIN_USERNAME_REQUIRED",
        "RECLOUD_LOGIN_FORM_CHANGED",
        "RECLOUD_MANUAL_VERIFICATION_REQUIRED",
      ].includes(error.code)
        ? error.code
        : "RECLOUD_SESSION_ERROR";
      logger.error(`RECLOUD_SESSION: failed ${safeCode}`);
    }
    return null;
  }
}

function createApp(
  connector = recloudConnector,
  receiptStore = null,
  options = {}
) {
  const runtimeEnv = options.env || process.env;
  const runtimeConfig = validateRuntimeConfig(runtimeEnv);
  const businessStores = options.businessStores || createBusinessStores(runtimeEnv);
  receiptStore ||= businessStores.receiptStore;
  const accountStore = options.accountStore || new AccountStore(options.accountStoreOptions);
  const coordinationStore = options.coordinationStore || new WorkCoordinationStore(options.coordinationStoreOptions);
  const pendingReceiptStore = options.pendingReceiptStore || null;
  const rmaQueryCacheStore = options.rmaQueryCacheStore || null;
  const currentUserProvider =
    options.getCurrentUser || ((req) =>
      req.fieldDeskUser ||
      getLocalCurrentUser(
        runtimeEnv,
        String(req.headers["x-fielddesk-local-user"] || "")
      ));
  const inventoryStore = options.inventoryStore || businessStores.inventoryStore;
  const attachmentStore = options.attachmentStore || new LocalRepairAttachmentStore();
  const receiptAttachmentStore = options.receiptAttachmentStore || new LocalRepairAttachmentStore(
    path.join(__dirname, "database", "uploads", "receipts"),
    { allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"] }
  );
  const shippingAttachmentStore = options.shippingAttachmentStore || new LocalShippingAttachmentStore();
  const syncDiagnostics = options.syncDiagnostics || new RecloudSyncDiagnosticsService(
    options.syncDiagnosticsStore || new JsonRecloudSyncDiagnosticsStore()
  );
  const recloudCommandExecutor = options.recloudCommandExecutor || (
    options.recloudRepairAdapterProvider
      ? createRecloudCommandExecutor({
          repairAdapterProvider: options.recloudRepairAdapterProvider,
          checkpointStore: options.recloudRepairCheckpointStore || new JsonRecloudRepairCheckpointStore(),
          writeEnabled: !isDryRun(runtimeEnv) && isRecloudWriteEnabled(runtimeEnv),
          submitReadyTimeoutMs: Number(runtimeEnv.RECLOUD_REPAIR_SUBMIT_READY_TIMEOUT_MS || 30_000),
          submitReadyPollIntervalMs: Number(runtimeEnv.RECLOUD_REPAIR_SUBMIT_READY_POLL_MS || 500),
        })
      : null
  );
  const syncService = options.syncService || new RecloudSyncService(
    options.syncOutbox || new JsonRecloudSyncOutbox(),
    options.recloudAdapter || createRecloudAdapter(runtimeEnv, {
      readinessProvider: syncDiagnostics,
      commandExecutor: recloudCommandExecutor,
    })
  );
  const feishuModelCatalog = options.feishuModelCatalog || new FeishuModelCatalog({ env: runtimeEnv });
  const feishuPartsCatalog = options.feishuPartsCatalog || new FeishuPartsCatalog({ env: runtimeEnv });
  const faultCatalogStore = options.faultCatalogStore || new JsonRecloudFaultCatalogStore(options.faultCatalogFile);
  const supervisionMonitor = options.supervisionMonitor || null;
  const supervisionInboxStore = options.supervisionInboxStore || businessStores.supervisionInboxStore;
  const app = express();
  const operationalLogger = options.operationalLogger || new RotatingJsonLogger({ directory: runtimeEnv.LOG_DIRECTORY, maxBytes: runtimeEnv.LOG_MAX_BYTES, retention: runtimeEnv.LOG_RETENTION_FILES });
  app.set("trust proxy", runtimeConfig.trustProxy);
  app.use(express.json({ limit: runtimeEnv.REQUEST_BODY_LIMIT || "40mb" }));
  app.use(securityHeaders);
  app.use(createRateLimiter({ limit: Number(runtimeEnv.API_RATE_LIMIT_PER_MINUTE || 120) }));
  app.use("/api/auth", createRateLimiter({ windowMs: 15 * 60_000, limit: Number(runtimeEnv.LOGIN_RATE_LIMIT_PER_15_MINUTES || 10), code: "LOGIN_RATE_LIMITED" }));
  app.use(requestLogger(operationalLogger));

  const accountSessions = new Map();
  const accountSessionMs = Math.min(168, Math.max(1, Number(runtimeEnv.FIELDDESK_SESSION_HOURS || 12))) * 3600_000;

  app.use((req, res, next) => {
    const origin = String(req.headers.origin || "");
    if (origin && !runtimeConfig.frontendOrigins.includes(origin)) return res.status(403).json({ success: false, code: "CORS_ORIGIN_DENIED", message: "来源不受信任" });
    if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,Idempotency-Key,X-FieldDesk-Local-User");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  app.post("/api/auth/login", async (req, res, next) => {
    try {
      const user = await accountStore.findByCredentials(req.body?.userId, req.body?.password);
      if (!user) return res.status(401).json({ success: false, code: "AUTH_INVALID_CREDENTIALS", message: "账号或密码错误，或账号已停用" });
      const sessionToken = crypto.randomBytes(32).toString("base64url");
      accountSessions.set(sessionToken, { userId: user.userId, expiresAt: Date.now() + accountSessionMs });
      res.json({ success: true, data: {
        sessionToken,
        userId: user.userId,
        displayName: user.displayName,
        role: user.role,
        repairSpecialties: getAllowedRepairSpecialties(user),
      } });
    } catch (error) { next(error); }
  });

  app.use(async (req, res, next) => {
    if (String(runtimeEnv.FIELDDESK_AUTH_MODE || "local") !== "accounts") return next();
    if (req.path === "/api/health") return next();
    try {
      await accountStore.ensureBootstrap(runtimeEnv.FIELDDESK_BOOTSTRAP_ADMIN_TOKEN);
      const authorization = String(req.headers.authorization || "");
      const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
      const session = accountSessions.get(token);
      if (session && session.expiresAt <= Date.now()) accountSessions.delete(token);
      const user = session?.expiresAt > Date.now() ? await accountStore.findByUserId(session.userId) : await accountStore.findByToken(token);
      if (!user) return res.status(401).json({ success: false, code: "AUTH_REQUIRED", message: "账号认证失败" });
      req.fieldDeskUser = user;
      next();
    } catch (error) { next(error); }
  });

  app.use(async (req, res, next) => {
    if (req.method !== "POST") return next();
    const user = currentUserProvider(req);
    const resourceId = String(req.body?.rmaNo || "").trim();
    try {
      await coordinationStore.assertAvailable(resourceId, user);
      const key = String(req.headers["idempotency-key"] || "").trim();
      if (key) {
        const claim = await coordinationStore.claimIdempotency(key, user);
        if (claim.duplicate) return res.json(claim.response);
        const originalJson = res.json.bind(res);
        res.json = (body) => {
          const completion = res.statusCode < 400
            ? coordinationStore.finishIdempotency(claim.scopedKey, body)
            : coordinationStore.failIdempotency(claim.scopedKey);
          completion.catch(() => console.error("FIELDDESK_IDEMPOTENCY: persist_failed"));
          return originalJson(body);
        };
      }
      if (resourceId && /^\/api\/(repairs|inventory|shipping|orders)/.test(req.path)) {
        res.on("finish", () => coordinationStore.audit({ action: `${req.method} ${req.path}`, resourceId, user, outcome: res.statusCode < 400 ? "SUCCESS" : "FAILED" }).catch(() => console.error("FIELDDESK_AUDIT: persist_failed")));
      }
      next();
    } catch (error) { next(error); }
  });

  async function enqueueRecloudNode(order, nodeType, recordId) {
    try {
      return await syncService.enqueueOrderNode(order, nodeType, recordId);
    } catch {
      console.error("RECLOUD_SYNC_OUTBOX: enqueue_failed");
      return null;
    }
  }

  app.get("/api/health", (req, res) => {
    res.json({
      success: true,
      service: "fielddesk-api",
      dryRun: isDryRun(),
      recloudWriteEnabled: isRecloudWriteEnabled(),
    });
  });

  app.get("/api/ready", async (req, res) => {
    try {
      await Promise.all([receiptStore.readAll(), inventoryStore.read()]);
      res.json({ success: true, status: "ready", storageDriver: businessStores.driver });
    } catch {
      res.status(503).json({ success: false, status: "not_ready" });
    }
  });

  app.get("/api/supervision/monitor/status", (req, res) => {
    res.json({
      success: true,
      data: supervisionMonitor?.getStatus?.() || {
        enabled: false,
        running: false,
        lastErrorCode: "SUPERVISION_MONITOR_NOT_ATTACHED",
      },
    });
  });

  app.get("/api/auth/me", (req, res) => {
    const user = currentUserProvider(req);
    res.json({
      success: true,
      data: {
        userId: user.userId,
        displayName: user.displayName,
        role: user.role,
        repairSpecialties: getAllowedRepairSpecialties(user),
      },
    });
  });

  app.get("/api/admin/users", async (req, res, next) => {
    try {
      const user = currentUserProvider(req);
      if (user.role !== USER_ROLES.ADMIN) throw createApiError("ACCOUNT_ADMIN_REQUIRED", "只有管理员可以查看账号", 403);
      res.json({ success: true, data: await accountStore.list() });
    } catch (error) { next(error); }
  });

  app.post("/api/admin/users", async (req, res, next) => {
    try {
      const user = currentUserProvider(req);
      res.json({ success: true, data: await accountStore.upsert(req.body || {}, user) });
    } catch (error) { next(error); }
  });

  app.post("/api/orders/lock", async (req, res, next) => {
    try {
      const user = currentUserProvider(req);
      res.json({ success: true, data: await coordinationStore.acquire(String(req.body?.rmaNo || "").trim(), user) });
    } catch (error) { next(error); }
  });

  app.post("/api/orders/unlock", async (req, res, next) => {
    try {
      const user = currentUserProvider(req);
      res.json({ success: true, data: await coordinationStore.release(String(req.body?.rmaNo || "").trim(), user) });
    } catch (error) { next(error); }
  });

  app.get("/api/admin/audit-logs", async (req, res, next) => {
    try {
      const user = currentUserProvider(req);
      if (user.role !== USER_ROLES.ADMIN) throw createApiError("AUDIT_ADMIN_REQUIRED", "只有管理员可以查看操作审计", 403);
      res.json({ success: true, data: await coordinationStore.listAudits() });
    } catch (error) { next(error); }
  });

  app.post("/api/crm/repairs/query", async (req, res, next) => {
    const queryValue = normalizeLogisticsNo(req.body?.queryValue || req.body?.logisticsNo);
    if (!queryValue) {
      return res.status(400).json({ success: false, message: "请输入物流单号、电话、SN或寄修单号" });
    }

    try {
      const user = currentUserProvider(req);
      const allReceiptOrders = await receiptStore.readAll();
      const localOrders = await receiptStore.listOrdersForUser(user, USER_ROLES);
      const normalizedQuery = queryValue.toUpperCase();
      const phoneQuery = /^1[3-9]\d{9}$/.test(queryValue);
      const snQuery = !phoneQuery && !/^JXTH/i.test(queryValue) && !/^SF/i.test(queryValue)
        && /^[A-Z0-9]{12,}$/i.test(queryValue);
      const withMachineHistory = (detail) => {
        const machineHistory = findMachineRepairHistory(allReceiptOrders, {
          sn: detail?.productSerialNo || detail?.sn || "",
          currentRmaNo: detail?.rmaNo || "",
        });
        return {
          ...detail,
          isRepeatRepair: machineHistory.isRepeatRepair,
          previousTechnicianName: machineHistory.previousTechnicianName,
          previousCompletedAt: machineHistory.previousCompletedAt,
          repairHistory: machineHistory.records,
        };
      };
      let localFallbackData = null;
      let onlineQueryValue = queryValue;
      let localMatches = localOrders.filter((order) =>
        [order.rmaNo, order.logisticsNo, order.sn].some(
          (value) => String(value || "").trim().toUpperCase() === normalizedQuery
        ) || (phoneQuery && phoneMatches(order.phoneMasked || order.phone, queryValue))
      );
      const pendingOrders = pendingReceiptStore ? await pendingReceiptStore.readAll() : [];
      const queryCacheOrders = rmaQueryCacheStore ? await rmaQueryCacheStore.readAll() : [];
      const cachedOrders = [...pendingOrders, ...queryCacheOrders];
      const pendingMatches = cachedOrders.filter((order) =>
        [order.rmaNo, order.logisticsNo, order.sn].some(
          (value) => String(value || '').trim().toUpperCase() === normalizedQuery
        ) || (phoneQuery && phoneMatches(order.phoneMasked || order.phone, queryValue))
      );
      for (const order of pendingMatches) {
        const existingIndex = localMatches.findIndex((item) => item.rmaNo === order.rmaNo);
        if (existingIndex < 0) {
          localMatches.push(order);
          continue;
        }
        const existing = localMatches[existingIndex];
        const merged = { ...order, ...existing };
        for (const key of [
          "logisticsNo", "phone", "phoneMasked", "customerName", "regionAddress",
          "reportedFault", "sn", "productLine", "productModel", "pickupStatus",
        ]) {
          if (!String(merged[key] || "").trim()) merged[key] = order[key] || existing[key] || "";
        }
        localMatches[existingIndex] = merged;
      }
      for (const order of localMatches) {
        if (!String(order.productLine || order.specialty || "").trim() && order.sn) {
          const sameMachine = [...localOrders, ...cachedOrders].find((candidate) =>
            String(candidate.sn || "").trim().toUpperCase() === String(order.sn || "").trim().toUpperCase()
            && String(candidate.productLine || candidate.specialty || "").trim()
          );
          if (sameMachine) order.productLine = sameMachine.productLine || sameMachine.specialty || "";
        }
      }
      // A phone lookup must be verified against Recloud's current result.
      // Older fallback rows may have been stamped with the queried phone before
      // the remote detail had actually changed, so they are unsafe as a source
      // of truth for phone searches.
      if (phoneQuery) {
        localMatches = localMatches.filter((order) => (
          order.source !== "RECLOUD_QUERY_FALLBACK"
          && (
            order.source !== "RECLOUD_LIVE_QUERY_CACHE"
            || order.phoneVerified === true
            // A masked phone read directly from the current Recloud order is
            // sufficient to bind the user's complete phone to that same RMA.
            // This avoids discarding a correct local hit merely because the
            // Recloud reveal button did not expose all eleven digits.
            || Boolean(normalizeMaskedPhone(order.phoneMasked || order.phone))
          )
        ));
      }
      if (localMatches.length > 1) {
        return res.json({
          success: true,
          data: {
            matches: localMatches.map((order) => withMachineHistory({
              logisticsNo: order.logisticsNo || "",
              pickupLogisticsNo: order.logisticsNo || "",
              rmaNo: order.rmaNo,
              customer: {
                name: order.customerName || "",
                phoneMasked: phoneQuery ? queryValue : order.phoneMasked || order.phone || "",
                regionAddress: order.regionAddress || "",
              },
              phoneMasked: phoneQuery ? queryValue : order.phoneMasked || order.phone || "",
              reportedFault: order.reportedFault || "",
              productSerialNo: order.sn || "",
              productLine: order.productLine || order.specialty || "",
              productModel: order.productModel || "",
              pickupStatus: order.pickupStatus || "",
              summary: [order.productModel, order.pickupStatus].filter(Boolean).join("｜"),
              localWorkflow: order,
              source: order.source || "FIELDDESK_LOCAL",
              cached: true,
            })),
            cached: true,
          },
        });
      }
      if (localMatches.length === 1) {
        const order = localMatches[0];
        localFallbackData = {
          logisticsNo: order.logisticsNo || "",
          pickupLogisticsNo: order.logisticsNo || "",
          rmaNo: order.rmaNo,
          customer: {
            name: order.customerName || "",
            phoneMasked: phoneQuery ? queryValue : order.phoneMasked || order.phone || "",
            regionAddress: order.regionAddress || "",
          },
          phoneMasked: phoneQuery ? queryValue : order.phoneMasked || order.phone || "",
          reportedFault: order.reportedFault || "",
          productSerialNo: order.sn || "",
          productLine: order.productLine || order.specialty || "",
          productModel: order.productModel || "",
          pickupStatus: order.pickupStatus || "",
          projectCode: order.recloudProjectCode || order.projectCode || "",
          localWorkflow: order,
          source: order.source || "FIELDDESK_LOCAL",
          phoneVerified: phoneQuery
            && phoneMatches(order.phoneMasked || order.phone, queryValue),
          cached: true,
        };
        if (localFallbackData.reportedFault && localFallbackData.productLine) {
          return res.json({ success: true, data: withMachineHistory(localFallbackData) });
        }
        onlineQueryValue = /^SF\d+$/i.test(String(order.logisticsNo || "").trim())
          ? order.logisticsNo
          : order.rmaNo || queryValue;
      }

      let data = await withRecloud(connector, async (page) => {
        const queryOnline = () => {
          if (localFallbackData) {
            return connector.queryRmaByLogisticsNo(page, onlineQueryValue, {
              revealPhoneEnabled: false,
              phoneRevealTimeout: 0,
              requirePickupLogisticsNo: false,
            });
          }
          if (phoneQuery && typeof connector.queryRmaByPhone === "function") {
            return connector.queryRmaByPhone(page, queryValue, {
                revealPhoneEnabled: true,
                phoneRevealTimeout: 3000,
              });
          }
          if (snQuery && typeof connector.queryRmaByIdentifier === "function") {
            return connector.queryRmaByIdentifier(page, queryValue, {
              queryMatchedBy: "SN",
              revealPhoneEnabled: false,
              phoneRevealTimeout: 3000,
            });
          }
          return connector.queryRmaByLogisticsNo(page, queryValue, {
            revealPhoneEnabled: true,
            phoneRevealTimeout: 3000,
          });
        };
        try {
          return await queryOnline();
        } catch (error) {
          if (error.code !== "RECLOUD_QUERY_TIMEOUT") throw error;
          return await queryOnline();
        }
      });
      if (localFallbackData && !Array.isArray(data?.matches)) {
        data = {
          ...localFallbackData,
          ...data,
          customer: { ...(localFallbackData.customer || {}), ...(data?.customer || {}) },
          phoneVerified: localFallbackData.phoneVerified === true
            || data?.phoneVerified === true,
          cached: false,
        };
      }
      if (phoneQuery) {
        const withQueriedPhone = (detail) => ({
          ...detail,
          phoneMasked: detail?.phoneVerified === true ? queryValue : detail?.phoneMasked || "",
          customer: {
            ...(detail?.customer || {}),
            phoneMasked: detail?.phoneVerified === true
              ? queryValue
              : detail?.customer?.phoneMasked || detail?.phoneMasked || "",
          },
        });
        data = Array.isArray(data?.matches)
          ? { ...data, matches: data.matches.map(withQueriedPhone) }
          : withQueriedPhone(data);
      }
      data = Array.isArray(data?.matches)
        ? { ...data, matches: data.matches.map(withMachineHistory) }
        : withMachineHistory(data);
      const liveQueryStore = rmaQueryCacheStore || pendingReceiptStore;
      if (liveQueryStore) {
        const cacheOne = async (detail) => {
          if (!detail?.rmaNo) return;
          await liveQueryStore.upsert({
            rmaNo: detail.rmaNo,
            logisticsNo: detail.pickupLogisticsNo || detail.logisticsNo || '',
            phone: detail.customer?.phoneMasked || detail.phoneMasked || '',
            customerName: detail.customer?.name || '',
            regionAddress: detail.customer?.regionAddress || '',
            reportedFault: detail.reportedFault || '',
            sn: detail.productSerialNo || '',
            productLine: detail.productLine || '',
            productModel: detail.productModel || '',
            pickupStatus: detail.pickupStatus || '',
            phoneVerified: detail.phoneVerified === true,
            source: 'RECLOUD_LIVE_QUERY_CACHE',
          });
        };
        if (Array.isArray(data?.matches)) await Promise.all(data.matches.map(cacheOne));
        else await cacheOne(data);
      }
      return res.json({ success: true, data });
    } catch (error) {
      return next(error);
    }
  });

  app.post(
    "/api/crm/repairs/receipt-form/inspect",
    async (req, res, next) => {
      if (!isDryRun() || isRecloudWriteEnabled()) {
        return res.status(403).json({
          success: false,
          code: "RECLOUD_RECEIPT_INSPECTION_UNSAFE",
          message: "签收表单定位只允许在 DRY_RUN 且写操作关闭时执行",
        });
      }
      const logisticsNo = normalizeLogisticsNo(req.body?.logisticsNo);
      if (!logisticsNo) {
        return res
          .status(400)
          .json({ success: false, message: "缺少物流单号" });
      }

      try {
        const data = await withRecloud(connector, async (page) => {
          const detail = await connector.queryRmaByLogisticsNo(
            page,
            logisticsNo
          );
          const inspection = await connector.inspectReceiptForm(page, {
            dryRun: true,
            writeEnabled: false,
            mappedRowOnly: true,
            rowIndex: 1,
            logisticsNo,
            productLine: detail.productLine,
            allowedProductLines: getAllowedRepairSpecialties(
              currentUserProvider(req)
            ),
          });
          return {
            logisticsNo,
            rmaNo: detail.rmaNo,
            inspection,
          };
        });
        return res.json({ success: true, data });
      } catch (error) {
        return next(error);
      }
    }
  );

  app.post(
    "/api/crm/repairs/receipt-form/simulate",
    async (req, res, next) => {
      if (!isDryRun() || isRecloudWriteEnabled()) {
        return res.status(403).json({
          success: false,
          code: "RECLOUD_RECEIPT_SIMULATION_UNSAFE",
          message: "签收填写演练只允许在 DRY_RUN 且写操作关闭时执行",
        });
      }
      const logisticsNo = normalizeLogisticsNo(req.body?.logisticsNo);
      const sn = String(req.body?.sn ?? "");
      const remark = String(req.body?.remark ?? "");
      const testLogisticsNo = normalizeLogisticsNo(
        process.env.RECLOUD_RECEIPT_TEST_LOGISTICS_NO
      );
      const missingFields = [
        !logisticsNo && "logisticsNo",
        !sn.trim() && "sn",
        !remark.trim() && "remark",
      ].filter(Boolean);
      if (missingFields.length > 0) {
        return res.status(400).json({
          success: false,
          code: "RECLOUD_RECEIPT_SIMULATION_INVALID",
          message: "签收填写演练参数不完整",
          missingFields,
        });
      }
      if (!testLogisticsNo || logisticsNo !== testLogisticsNo) {
        return res.status(403).json({
          success: false,
          code: "RECLOUD_RECEIPT_TEST_ORDER_REQUIRED",
          message: "仅允许使用后端配置的专用未签收测试工单",
          missingFields: [],
        });
      }

      try {
        const data = await withRecloud(connector, async (page) => {
          const detail = await connector.queryRmaByLogisticsNo(
            page,
            logisticsNo
          );
          return connector.simulateReceiptForm(page, sn, remark, {
            dryRun: true,
            writeEnabled: false,
            logisticsNo,
            productLine: detail.productLine,
            allowedProductLines: getAllowedRepairSpecialties(
              currentUserProvider(req)
            ),
          });
        });
        return res.json({ success: true, data });
      } catch (error) {
        return next(error);
      }
    }
  );

  app.post("/api/crm/repairs/detection-form/inspect", async (req, res, next) => {
    if (!isDryRun(runtimeEnv) || isRecloudWriteEnabled(runtimeEnv)) {
      return res.status(403).json({ success: false, code: "RECLOUD_DETECTION_INSPECTION_UNSAFE", message: "检测弹窗定位只允许在严格只读模式下执行" });
    }
    const logisticsNo = normalizeLogisticsNo(req.body?.logisticsNo);
    if (!logisticsNo) return res.status(400).json({ success: false, message: "缺少物流单号" });
    try {
      const data = await withRecloud(connector, async (page) => {
        const detail = await connector.queryRmaByLogisticsNo(page, logisticsNo);
        const inspection = await connector.inspectDetectionForm(page, {
          dryRun: true,
          writeEnabled: false,
          faultKeyword: String(req.body?.faultKeyword || "").trim(),
        });
        inspection.controlMapping = assessRecloudInspectionControlMapping(inspection.fieldControls);
        if (inspection.faultOptions?.length) await faultCatalogStore.merge(inspection.faultOptions);
        return { logisticsNo, rmaNo: detail.rmaNo, inspection };
      });
      return res.json({ success: true, data });
    } catch (error) { return next(error); }
  });

  app.post("/api/crm/repairs/detection-form/simulate", async (req, res, next) => {
    if (!isDryRun(runtimeEnv) || isRecloudWriteEnabled(runtimeEnv)) {
      return res.status(403).json({
        success: false,
        code: "RECLOUD_DETECTION_SIMULATION_UNSAFE",
        message: "检测搜索演练只允许在严格只读模式下执行",
      });
    }
    const logisticsNo = normalizeLogisticsNo(req.body?.logisticsNo);
    const faultKeyword = String(req.body?.faultKeyword || "").trim().slice(0, 30);
    const prefillRequested = req.body?.prefill === true;
    const testLogisticsNo = normalizeLogisticsNo(runtimeEnv.RECLOUD_DETECTION_TEST_LOGISTICS_NO);
    const missingFields = [
      !logisticsNo && "logisticsNo",
      !faultKeyword && "faultKeyword",
      prefillRequested && !String(req.body?.faultCategory || "").trim() && "faultCategory",
      prefillRequested && !String(req.body?.warrantyStatus || "").trim() && "warrantyStatus",
      prefillRequested && !String(req.body?.detectionResult || "").trim() && "detectionResult",
    ].filter(Boolean);
    if (missingFields.length) {
      return res.status(400).json({
        success: false,
        code: "RECLOUD_DETECTION_SIMULATION_INVALID",
        message: "检测搜索演练参数不完整",
        missingFields,
      });
    }
    if (!testLogisticsNo || logisticsNo !== testLogisticsNo) {
      return res.status(403).json({
        success: false,
        code: "RECLOUD_DETECTION_TEST_ORDER_REQUIRED",
        message: "仅允许使用后端配置的专用待检测测试工单",
        missingFields: [],
      });
    }
    try {
      const data = await withRecloud(connector, async (page) => {
        const detail = await connector.queryRmaByLogisticsNo(page, logisticsNo);
        const prefillPlan = prefillRequested
          ? buildRecloudInspectionFormPlan({
              faultCategory: req.body?.faultCategory,
              warrantyStatus: req.body?.warrantyStatus,
              detectionResult: req.body?.detectionResult,
            })
          : null;
        const inspection = await connector.inspectDetectionForm(page, {
          dryRun: true,
          writeEnabled: false,
          faultKeyword,
          prefillPlan,
        });
        inspection.controlMapping = assessRecloudInspectionControlMapping(inspection.fieldControls);
        return { logisticsNo, rmaNo: detail.rmaNo, inspection };
      });
      return res.json({ success: true, data });
    } catch (error) {
      if (error?.code?.startsWith("RECLOUD_DETECTION_PREFILL_")) {
        console.warn("RECLOUD_DETECTION_PREFILL_DIAGNOSTIC:", JSON.stringify({
          code: error.code,
          fieldKey: String(error.fieldKey || "").slice(0, 80),
          phase: String(error.phase || "").slice(0, 40),
          causeCode: String(error.cause?.code || "").slice(0, 80),
          expectedValue: String(error.cause?.expectedValue || "").slice(0, 120),
          candidateValues: Array.isArray(error.cause?.candidateValues)
            ? error.cause.candidateValues.map((value) => String(value).slice(0, 120)).slice(0, 20)
            : [],
          primaryCode: String(error.primaryCode || "").slice(0, 80),
          primaryFieldKey: String(error.primaryFieldKey || "").slice(0, 80),
          fieldsWritten: Array.isArray(error.fieldsWritten) ? error.fieldsWritten.slice(0, 20) : [],
          rollbackControls: Array.isArray(error.rollbackControls) ? error.rollbackControls.slice(0, 30) : [],
          rollbackDialogText: String(error.rollbackDialogText || "").slice(0, 500),
          rollbackCloseCandidates: Array.isArray(error.rollbackCloseCandidates) ? error.rollbackCloseCandidates.slice(0, 40) : [],
        }));
      }
      return next(error);
    }
  });

  app.post("/api/crm/repairs/repair-form/inspect", async (req, res, next) => {
    if (!isDryRun(runtimeEnv) || isRecloudWriteEnabled(runtimeEnv)) {
      return res.status(403).json({ success: false, code: "RECLOUD_REPAIR_INSPECTION_UNSAFE", message: "维修单定位只允许在严格只读模式下执行" });
    }
    const logisticsNo = normalizeLogisticsNo(req.body?.logisticsNo);
    if (!logisticsNo) return res.status(400).json({ success: false, message: "缺少物流单号" });
    const targetAssignee = String(req.body?.targetAssignee || "").trim();
    if (!targetAssignee) return res.status(400).json({ success: false, message: "缺少目标师傅" });
    const testLogisticsNo = normalizeLogisticsNo(runtimeEnv.RECLOUD_REPAIR_TEST_LOGISTICS_NO);
    if (!testLogisticsNo || logisticsNo !== testLogisticsNo) {
      return res.status(403).json({
        success: false,
        code: "RECLOUD_REPAIR_TEST_ORDER_REQUIRED",
        message: "维修页面诊断仅允许使用后端配置的专用测试工单",
      });
    }
    try {
      const data = await withRecloud(connector, async (page) => {
        const detail = await connector.queryRmaByLogisticsNo(page, logisticsNo);
        const inspection = await connector.inspectRepairForm(page, {
          dryRun: true,
          writeEnabled: false,
          searchTerm: detail.rmaNo,
          inspectPartAddDialog: true,
          inspectExecutionControls: true,
          targetAssignee,
        });
        return {
          logisticsNo,
          rmaNo: detail.rmaNo,
          inspection,
          readiness: assessRecloudRepairPageReadiness(inspection),
        };
      });
      return res.json({ success: true, data });
    } catch (error) { return next(error); }
  });

  app.get("/api/recloud/fault-catalog", async (req, res, next) => {
    try {
      const data = await faultCatalogStore.search(req.query.keyword, req.query.limit);
      if (data.items.length || !req.query.rmaNo) return res.json({ success: true, data: { source: "RECLOUD_LOCAL_MIRROR", ...data } });
      const order = (await receiptStore.readAll()).find((item) => item.rmaNo === String(req.query.rmaNo || "").trim());
      const productLine = order?.specialty || order?.productLine || "";
      const suggestions = [...new Set((order?.partApplications || []).map((part) =>
        localFaultMappings[`${productLine}||${part.partCode}`]?.best?.path
      ).filter(Boolean))];
      return res.json({ success: true, data: { source: "LOCAL_REPAIR_KNOWLEDGE", ...data, items: suggestions, complete: true } });
    } catch (error) { return next(error); }
  });

  app.post("/api/recloud/fault-catalog/sync", async (req, res, next) => {
    if (!isDryRun(runtimeEnv) || isRecloudWriteEnabled(runtimeEnv)) {
      return res.status(403).json({ success: false, code: "RECLOUD_FAULT_SYNC_UNSAFE", message: "三级故障同步只允许在严格只读模式下执行" });
    }
    const logisticsNo = normalizeLogisticsNo(req.body?.logisticsNo);
    if (!logisticsNo) return res.status(400).json({ success: false, message: "缺少一张处于待检测状态的物流单号" });
    try {
      const data = await withRecloud(connector, async (page) => {
        await connector.queryRmaByLogisticsNo(page, logisticsNo);
        const inspection = await connector.inspectDetectionForm(page, {
          dryRun: true,
          writeEnabled: false,
          listAllFaults: true,
          actionTimeout: 15000,
        });
        const fullPaths = (inspection.faultOptions || []).filter((item) => String(item).split("/").filter(Boolean).length >= 3);
        if (!fullPaths.length) throw createApiError("RECLOUD_FAULT_CATALOG_INCOMPLETE", "未读取到瑞云三级故障完整路径，保留原目录", 502);
        const catalog = await faultCatalogStore.replace(fullPaths);
        return { ...catalog, count: catalog.items.length, recloudModified: false };
      });
      return res.json({ success: true, data });
    } catch (error) { return next(error); }
  });

  app.post(
    "/api/crm/repairs/receipt-form/table-diagnostics",
    async (req, res, next) => {
      if (!isDryRun() || isRecloudWriteEnabled()) {
        return res.status(403).json({
          success: false,
          code: "RECLOUD_RECEIPT_INSPECTION_UNSAFE",
          message: "RMA 表格结构诊断只允许在严格只读模式下执行",
        });
      }
      const logisticsNo = normalizeLogisticsNo(req.body?.logisticsNo);
      if (!logisticsNo) {
        return res.status(400).json({
          success: false,
          code: "RECLOUD_RECEIPT_SIMULATION_INVALID",
          message: "缺少物流单号",
          missingFields: ["logisticsNo"],
        });
      }
      try {
        const data = await withRecloud(connector, async (page) => {
          const detail = await connector.queryRmaByLogisticsNo(
            page,
            logisticsNo
          );
          return connector.diagnoseReceiptTableStructure(page, {
            dryRun: true,
            writeEnabled: false,
            logisticsNo,
            productLine: detail.productLine,
          });
        });
        return res.json({ success: true, data });
      } catch (error) {
        return next(error);
      }
    }
  );

  app.post(
    "/api/crm/repairs/receipt-form/fixed-operation-diagnostics",
    async (req, res, next) => {
      if (!isDryRun() || isRecloudWriteEnabled()) {
        return res.status(403).json({
          success: false,
          code: "RECLOUD_RECEIPT_INSPECTION_UNSAFE",
          message: "固定操作列诊断只允许在严格只读模式下执行",
        });
      }
      const logisticsNo = normalizeLogisticsNo(req.body?.logisticsNo);
      if (!logisticsNo) {
        return res.status(400).json({
          success: false,
          code: "RECLOUD_RECEIPT_SIMULATION_INVALID",
          message: "缺少物流单号",
          missingFields: ["logisticsNo"],
        });
      }
      try {
        const data = await withRecloud(connector, async (page) => {
          await connector.queryRmaByLogisticsNo(page, logisticsNo);
          const table = await connector.diagnoseReceiptTableStructure(page, {
            dryRun: true,
            writeEnabled: false,
            logisticsNo,
          });
          const headerBottom = Math.max(
            0,
            ...Object.values(table.headerBounds || {}).map(
              (header) =>
                Number(header?.bounds?.y || 0) +
                Number(header?.bounds?.height || 0)
            )
          );
          const tableBottom =
            Number(table.tableRootBounds?.y || 0) +
            Number(table.tableRootBounds?.height || 0);
          const derivedCenterY =
            (table.visibleDataRowCount === 1 || table.mainRowCount === 1) &&
            headerBottom > 0 &&
            tableBottom > headerBottom
              ? (headerBottom + tableBottom) / 2
              : undefined;
          return connector.diagnoseFixedReceiptOperation(page, {
            dryRun: true,
            writeEnabled: false,
            rowIndex: 1,
            targetCenterY:
              table.rowCandidates?.length === 1
                ? table.rowCandidates?.[0]?.y
                : derivedCenterY,
          });
        });
        return res.json({ success: true, data });
      } catch (error) {
        return next(error);
      }
    }
  );

  app.post(
    "/api/crm/repairs/receipt-form/hover-diagnostics",
    async (req, res, next) => {
      if (!isDryRun() || isRecloudWriteEnabled()) {
        return res.status(403).json({
          success: false,
          code: "RECLOUD_RECEIPT_INSPECTION_UNSAFE",
          message: "签收控件悬停诊断只允许在严格只读模式下执行",
        });
      }
      const logisticsNo = normalizeLogisticsNo(req.body?.logisticsNo);
      if (!logisticsNo) {
        return res.status(400).json({
          success: false,
          code: "RECLOUD_RECEIPT_SIMULATION_INVALID",
          message: "缺少物流单号",
          missingFields: ["logisticsNo"],
        });
      }
      try {
        const data = await withRecloud(connector, async (page) => {
          await connector.queryRmaByLogisticsNo(page, logisticsNo);
          const table = await connector.diagnoseReceiptTableStructure(page, {
            dryRun: true,
            writeEnabled: false,
            logisticsNo,
          });
          const headerBottom = Math.max(
            0,
            ...Object.values(table.headerBounds || {}).map(
              (header) =>
                Number(header?.bounds?.y || 0) +
                Number(header?.bounds?.height || 0)
            )
          );
          const tableBottom =
            Number(table.tableRootBounds?.y || 0) +
            Number(table.tableRootBounds?.height || 0);
          const targetCenterY =
            table.rowCandidates?.length === 1
              ? table.rowCandidates[0].y
              : (table.visibleDataRowCount === 1 ||
                    table.mainRowCount === 1) &&
                  tableBottom > headerBottom
                ? (headerBottom + tableBottom) / 2
                : undefined;
          return connector.diagnoseReceiptControlAfterHover(page, {
            dryRun: true,
            writeEnabled: false,
            rowIndex: 1,
            targetCenterY,
          });
        });
        return res.json({ success: true, data });
      } catch (error) {
        return next(error);
      }
    }
  );

  app.post(
    "/api/crm/repairs/receipt-form/row-hover-diagnostics",
    async (req, res, next) => {
      if (!isDryRun() || isRecloudWriteEnabled()) {
        return res.status(403).json({
          success: false,
          code: "RECLOUD_RECEIPT_INSPECTION_UNSAFE",
          message: "签收整行悬停诊断只允许在严格只读模式下执行",
        });
      }
      const logisticsNo = normalizeLogisticsNo(req.body?.logisticsNo);
      if (!logisticsNo) {
        return res.status(400).json({
          success: false,
          code: "RECLOUD_RECEIPT_SIMULATION_INVALID",
          message: "缺少物流单号",
          missingFields: ["logisticsNo"],
        });
      }
      try {
        const data = await withRecloud(connector, async (page) => {
          await connector.queryRmaByLogisticsNo(page, logisticsNo);
          const table = await connector.diagnoseReceiptTableStructure(page, {
            dryRun: true,
            writeEnabled: false,
            logisticsNo,
          });
          const headerBottom = Math.max(
            0,
            ...Object.values(table.headerBounds || {}).map(
              (header) =>
                Number(header?.bounds?.y || 0) +
                Number(header?.bounds?.height || 0)
            )
          );
          const tableBottom =
            Number(table.tableRootBounds?.y || 0) +
            Number(table.tableRootBounds?.height || 0);
          const targetCenterY =
            table.rowCandidates?.length === 1
              ? table.rowCandidates[0].y
              : (table.visibleDataRowCount === 1 ||
                    table.mainRowCount === 1) &&
                  tableBottom > headerBottom
                ? (headerBottom + tableBottom) / 2
                : undefined;
          return connector.diagnoseReceiptControlAfterRowHover(page, {
            dryRun: true,
            writeEnabled: false,
            rowIndex: 1,
            targetCenterY,
          });
        });
        return res.json({ success: true, data });
      } catch (error) {
        return next(error);
      }
    }
  );

  app.post(
    "/api/crm/repairs/receipt-form/layout-diagnostics",
    async (req, res, next) => {
      if (!isDryRun() || isRecloudWriteEnabled()) {
        return res.status(403).json({
          success: false,
          code: "RECLOUD_RECEIPT_INSPECTION_UNSAFE",
          message: "签收布局诊断只允许在严格只读模式下执行",
        });
      }
      const logisticsNo = normalizeLogisticsNo(req.body?.logisticsNo);
      if (!logisticsNo) {
        return res.status(400).json({
          success: false,
          code: "RECLOUD_RECEIPT_SIMULATION_INVALID",
          message: "缺少物流单号",
          missingFields: ["logisticsNo"],
        });
      }
      try {
        const data = await withRecloud(connector, async (page) => {
          await connector.queryRmaByLogisticsNo(page, logisticsNo);
          const table = await connector.diagnoseReceiptTableStructure(page, {
            dryRun: true,
            writeEnabled: false,
            logisticsNo,
          });
          const headerBottom = Math.max(
            0,
            ...Object.values(table.headerBounds || {}).map(
              (header) =>
                Number(header?.bounds?.y || 0) +
                Number(header?.bounds?.height || 0)
            )
          );
          const tableBottom =
            Number(table.tableRootBounds?.y || 0) +
            Number(table.tableRootBounds?.height || 0);
          const targetCenterY =
            table.rowCandidates?.length === 1
              ? table.rowCandidates[0].y
              : (table.visibleDataRowCount === 1 ||
                    table.mainRowCount === 1) &&
                  tableBottom > headerBottom
                ? (headerBottom + tableBottom) / 2
                : undefined;
          return connector.diagnoseReceiptControlLayout(page, {
            dryRun: true,
            writeEnabled: false,
            rowIndex: 1,
            targetCenterY,
          });
        });
        return res.json({ success: true, data });
      } catch (error) {
        return next(error);
      }
    }
  );

  app.post(
    "/api/crm/repairs/receipt-form/vue-state-diagnostics",
    async (req, res, next) => {
      if (!isDryRun() || isRecloudWriteEnabled()) {
        return res.status(403).json({
          success: false,
          code: "RECLOUD_RECEIPT_INSPECTION_UNSAFE",
          message: "签收 Vue 状态诊断只允许在严格只读模式下执行",
        });
      }
      const logisticsNo = normalizeLogisticsNo(req.body?.logisticsNo);
      if (!logisticsNo) {
        return res.status(400).json({
          success: false,
          code: "RECLOUD_RECEIPT_SIMULATION_INVALID",
          message: "缺少物流单号",
          missingFields: ["logisticsNo"],
        });
      }
      try {
        const data = await withRecloud(connector, async (page) => {
          await connector.queryRmaByLogisticsNo(page, logisticsNo);
          const table = await connector.diagnoseReceiptTableStructure(page, {
            dryRun: true,
            writeEnabled: false,
            logisticsNo,
          });
          const headerBottom = Math.max(
            0,
            ...Object.values(table.headerBounds || {}).map(
              (header) =>
                Number(header?.bounds?.y || 0) +
                Number(header?.bounds?.height || 0)
            )
          );
          const tableBottom =
            Number(table.tableRootBounds?.y || 0) +
            Number(table.tableRootBounds?.height || 0);
          const targetCenterY =
            table.rowCandidates?.length === 1
              ? table.rowCandidates[0].y
              : (table.visibleDataRowCount === 1 ||
                    table.mainRowCount === 1) &&
                  tableBottom > headerBottom
                ? (headerBottom + tableBottom) / 2
                : undefined;
          return connector.diagnoseReceiptVueState(page, {
            dryRun: true,
            writeEnabled: false,
            rowIndex: 1,
            targetCenterY,
          });
        });
        return res.json({ success: true, data });
      } catch (error) {
        return next(error);
      }
    }
  );

  app.post(
    "/api/crm/repairs/receipt-form/operation-source-diagnostics",
    async (req, res, next) => {
      if (!isDryRun() || isRecloudWriteEnabled()) {
        return res.status(403).json({
          success: false,
          code: "RECLOUD_RECEIPT_INSPECTION_UNSAFE",
          message: "签收操作来源诊断只允许在严格只读模式下执行",
        });
      }
      const logisticsNo = normalizeLogisticsNo(req.body?.logisticsNo);
      if (!logisticsNo) {
        return res.status(400).json({
          success: false,
          code: "RECLOUD_RECEIPT_SIMULATION_INVALID",
          message: "缺少物流单号",
          missingFields: ["logisticsNo"],
        });
      }
      try {
        const data = await withRecloud(connector, async (page) => {
          const responseObserver =
            connector.createReceiptActionResponseObserver(page);
          let networkActionResponses = [];
          try {
            await connector.queryRmaByLogisticsNo(page, logisticsNo);
            const table = await connector.diagnoseReceiptTableStructure(page, {
              dryRun: true,
              writeEnabled: false,
              logisticsNo,
            });
            networkActionResponses = await responseObserver.stop();
            const headerBottom = Math.max(
              0,
              ...Object.values(table.headerBounds || {}).map(
                (header) =>
                  Number(header?.bounds?.y || 0) +
                  Number(header?.bounds?.height || 0)
              )
            );
            const tableBottom =
              Number(table.tableRootBounds?.y || 0) +
              Number(table.tableRootBounds?.height || 0);
            const targetCenterY =
              table.rowCandidates?.length === 1
                ? table.rowCandidates[0].y
                : (table.visibleDataRowCount === 1 ||
                      table.mainRowCount === 1) &&
                    tableBottom > headerBottom
                  ? (headerBottom + tableBottom) / 2
                  : undefined;
            return connector.diagnoseReceiptOperationSource(page, {
              dryRun: true,
              writeEnabled: false,
              rowIndex: 1,
              targetCenterY,
              networkActionResponses,
            });
          } finally {
            await responseObserver.stop();
          }
        });
        return res.json({ success: true, data });
      } catch (error) {
        return next(error);
      }
    }
  );

  app.post(
    "/api/crm/repairs/receipt-form/renderer-config-diagnostics",
    async (req, res, next) => {
      if (!isDryRun() || isRecloudWriteEnabled()) {
        return res.status(403).json({
          success: false,
          code: "RECLOUD_RECEIPT_INSPECTION_UNSAFE",
          message: "签收 renderer 配置诊断只允许在严格只读模式下执行",
        });
      }
      const logisticsNo = normalizeLogisticsNo(req.body?.logisticsNo);
      if (!logisticsNo) {
        return res.status(400).json({
          success: false,
          code: "RECLOUD_RECEIPT_SIMULATION_INVALID",
          message: "缺少物流单号",
          missingFields: ["logisticsNo"],
        });
      }
      try {
        const data = await withRecloud(connector, async (page) => {
          await connector.queryRmaByLogisticsNo(page, logisticsNo);
          const table = await connector.diagnoseReceiptTableStructure(page, {
            dryRun: true,
            writeEnabled: false,
            logisticsNo,
          });
          const headerBottom = Math.max(
            0,
            ...Object.values(table.headerBounds || {}).map(
              (header) =>
                Number(header?.bounds?.y || 0) +
                Number(header?.bounds?.height || 0)
            )
          );
          const tableBottom =
            Number(table.tableRootBounds?.y || 0) +
            Number(table.tableRootBounds?.height || 0);
          const targetCenterY =
            table.rowCandidates?.length === 1
              ? table.rowCandidates[0].y
              : (table.visibleDataRowCount === 1 ||
                    table.mainRowCount === 1) &&
                  tableBottom > headerBottom
                ? (headerBottom + tableBottom) / 2
                : undefined;
          return connector.diagnoseReceiptRendererConfig(page, {
            dryRun: true,
            writeEnabled: false,
            rowIndex: 1,
            targetCenterY,
          });
        });
        return res.json({ success: true, data });
      } catch (error) {
        return next(error);
      }
    }
  );

  app.post("/api/crm/repairs/receive", async (req, res, next) => {
    if (!isRecloudWriteEnabled(runtimeEnv)) {
      return res.status(403).json({
        success: false,
        code: "RECLOUD_WRITE_DISABLED",
        message: "当前阶段禁止瑞云签收写操作",
      });
    }

    const logisticsNo = normalizeLogisticsNo(req.body?.logisticsNo);
    const requestedSn = String(req.body?.sn || "").trim();
    const requestedRemark = String(req.body?.remark || "").trim();
    if (!logisticsNo) {
      return res.status(400).json({ success: false, message: "缺少物流单号" });
    }

    try {
      const data = await withRecloud(connector, async (page) => {
        const detail = await connector.queryRmaByLogisticsNo(
          page,
          logisticsNo
        );
        const sn = requestedSn || detail.sn;
        if (!sn) throw new Error("CRM 工单没有 SN，请手动提供 SN");
        const receipt = await connector.confirmSign(
          page,
          sn,
          detail.productType,
          requestedRemark,
          { dryRun: isDryRun(runtimeEnv) }
        );
        return { ...detail, sn, receipt };
      });
      return res.json({ success: true, data });
    } catch (error) {
      return next(error);
    }
  });

  app.post("/api/repairs/prepare-receipt", async (req, res, next) => {
    const logisticsNo = normalizeLogisticsNo(req.body?.logisticsNo);
    const rmaNo = String(req.body?.rmaNo || "").trim();
    const productLine = String(req.body?.productLine || "").trim();

    const missingFields = [
      !logisticsNo && "logisticsNo",
      !rmaNo && "rmaNo",
    ].filter(Boolean);
    if (missingFields.length > 0) {
      return res.status(400).json({
        success: false,
        code: "RECEIPT_PREPARATION_INVALID",
        message: `缺少必填字段：${missingFields.join(", ")}`,
        missingFields,
      });
    }

    try {
      const currentUser = currentUserProvider(req);
      const specialty = resolveReceiptSpecialty(
        currentUser,
        productLine,
        req.body?.specialty
      );
      const sn = validateReceiptSn(req.body?.sn, logisticsNo);
      const remark = specialty;
      const currentProjectCode = String(
        req.body?.currentProjectCode || req.body?.recloudProjectCode || ""
      ).trim();
      const data = await receiptStore.prepare({
        logisticsNo,
        rmaNo,
        sn,
        specialty,
        remark,
        productLine: productLine || specialty,
        customerName: String(req.body?.customerName || "").trim(),
        reportedFault: String(req.body?.reportedFault || "").trim(),
        recloudProjectCode: currentProjectCode,
        phoneMasked: normalizeMaskedPhone(req.body?.phoneMasked),
        regionAddress: String(req.body?.regionAddress || "").trim(),
        operatorId: currentUser.userId,
        operatorName: currentUser.displayName,
      });
      const rawAuthorization = typeof feishuModelCatalog.authorize === "function"
        ? await feishuModelCatalog.authorize({ sn, currentProjectCode })
        : await feishuModelCatalog.match({ sn, productLine: productLine || specialty });
      const localWorkflowAllowed = isDryRun(runtimeEnv)
        && !isRecloudWriteEnabled(runtimeEnv)
        && rawAuthorization.status === "CURRENT_PROJECT_MISSING";
      const authorization = localWorkflowAllowed
        ? {
            ...rawAuthorization,
            localWorkflowAllowed: true,
            localWorkflowNotice: "演练模式：瑞云当前项目号待验证，可继续本地处理流程",
          }
        : rawAuthorization;
      const authorizedData = await receiptStore.markModelAuthorization(
        rmaNo,
        authorization,
        currentUser
      );
      const supported = authorization.repairability === "SUPPORTED";
      const unsupported = authorization.repairability === "UNSUPPORTED";
      return res.json({
        success: true,
        data: {
          ...authorizedData,
          authorization,
          pricingPreparation: buildPricingPreview({
            modelRepairFees: authorization.repairFees || {},
            usedParts: [],
            warrantyStatus: "",
          }),
          message: supported
            ? "下放机型，可以维修"
            : localWorkflowAllowed
              ? authorization.localWorkflowNotice
              : unsupported
                ? "未下放机型，需转寄总部"
                : "机型数据异常，已停止并等待人工确认",
          dryRun: true,
          recloudSynced: false,
        },
      });
    } catch (error) {
      return next(error);
    }
  });

  app.post("/api/repairs/transfer-to-headquarters", async (req, res, next) => {
    const rmaNo = String(req.body?.rmaNo || "").trim();
    if (!rmaNo) return res.status(400).json({ success: false, message: "缺少必填字段：rmaNo" });
    try {
      const data = await receiptStore.transferToHeadquarters(rmaNo, currentUserProvider(req));
      return res.json({ success: true, data: { ...data, message: "已登记转寄总部，网点处理流程结束", recloudSynced: false } });
    } catch (error) {
      return next(error);
    }
  });

  app.post("/api/repairs/prepare-receipt/cancel", async (req, res, next) => {
    const rmaNo = String(req.body?.rmaNo || "").trim();
    if (!rmaNo) {
      return res.status(400).json({
        success: false,
        code: "RECEIPT_PREPARATION_INVALID",
        message: "缺少必填字段：rmaNo",
        missingFields: ["rmaNo"],
      });
    }
    try {
      const data = await receiptStore.cancel(
        rmaNo,
        currentUserProvider(req)
      );
      return res.json({
        success: true,
        data: {
          ...data,
          message: "签收准备已取消，未操作瑞云",
          recloudSynced: false,
        },
      });
    } catch (error) {
      return next(error);
    }
  });

  app.post("/api/repairs/complete-local-receipt", async (req, res, next) => {
    const rmaNo = String(req.body?.rmaNo || "").trim();
    if (!rmaNo) {
      return res.status(400).json({
        success: false,
        code: "RECEIPT_PREPARATION_INVALID",
        message: "缺少必填字段：rmaNo",
        missingFields: ["rmaNo"],
      });
    }
    try {
      const data = await receiptStore.completeReceipt(
        rmaNo,
        currentUserProvider(req)
      );
      await enqueueRecloudNode(data, "RECEIPT", data.receiptCompletedAt || data.id);
      // A supervision order may have arrived before the technician received the
      // machine. Recheck immediately after receipt so it can be routed to the
      // assigned technician without waiting for the periodic monitor tick.
      void supervisionMonitor?.pollNow?.();
      return res.json({
        success: true,
        data: {
          ...data,
          statusLabel: "已签收/待选择处理方式",
          message: "本地签收完成，请选择维修、弃修、只检测不维修或调试",
          recloudSynced: false,
        },
      });
    } catch (error) {
      return next(error);
    }
  });

  app.post("/api/repairs/treatment-decision", async (req, res, next) => {
    const rmaNo = String(req.body?.rmaNo || "").trim();
    const treatmentMode = String(req.body?.treatmentMode || "").trim();
    const decisions = {
      REPAIR: { label: "维修", detectionResult: "维修", nextStep: "partsApplication" },
      ABANDONED: { label: "弃修", detectionResult: "弃修", nextStep: "repairCompletion" },
      INSPECTION_ONLY: { label: "只检测不维修", detectionResult: "只检测不维修", nextStep: "repairCompletion" },
      DEBUGGING: { label: "调试", detectionResult: "维修", nextStep: "repairCompletion" },
    };
    if (!rmaNo) return next(createApiError("TREATMENT_DECISION_INVALID", "缺少必填字段：rmaNo", 400));
    if (!decisions[treatmentMode]) return next(createApiError("TREATMENT_MODE_INVALID", "请选择维修、弃修、只检测不维修或调试", 400));
    try {
      const order = (await receiptStore.readAll()).find((item) => item.rmaNo === rmaNo);
      if (!order) throw createApiError("RECEIPT_PREPARATION_NOT_FOUND", "未找到已签收工单", 404);
      const warranty = evaluateWarranty({
        sn: order.sn,
        purchaseDate: order.purchaseDate,
        warrantyYears: order.modelAuthorization?.warrantyYears || 2,
        isOfficialRefurbished: order.modelAuthorization?.isOfficialRefurbished === true,
      });
      if (treatmentMode === "ABANDONED" && warranty.status !== "DETERMINED") {
        throw createApiError("WARRANTY_STATUS_REQUIRED", "暂时无法判断是否保外，确认质保状态后才能选择弃修", 409);
      }
      if (treatmentMode === "ABANDONED" && warranty.warrantyStatus !== "保外") {
        throw createApiError("IN_WARRANTY_ABANDONMENT_NOT_ALLOWED", "该机器在保内，无需付费，不能选择弃修", 409);
      }
      const decision = decisions[treatmentMode];
      const data = await receiptStore.saveTreatmentDecision(rmaNo, {
        treatmentMode,
        detectionResult: decision.detectionResult,
        technicianWarranty: warranty.status === "DETERMINED" ? warranty.warrantyStatus : "",
        warrantyDecision: warranty,
      }, currentUserProvider(req));
      // No-parts treatments are complete inspection decisions by themselves.
      // Their Recloud inspection task can safely use the selected detection
      // result without inventing a fault classification.
      if (treatmentMode !== "REPAIR") {
        await enqueueRecloudNode(data, "INSPECTION_COMPLETED", data.inspectionUpdatedAt || data.id);
      }
      return res.json({
        success: true,
        data: {
          ...data,
          nextStep: decision.nextStep,
          message: treatmentMode === "REPAIR"
            ? "已选择维修，下一步申请配件"
            : `已选择${decision.label}，已跳过配件申请`,
          recloudDetectionResult: decision.detectionResult,
          recloudDetectionPending: false,
        },
      });
    } catch (error) { return next(error); }
  });

  app.post("/api/repairs/receipt/attachments", async (req, res, next) => {
    try {
      const rmaNo = String(req.body?.rmaNo || "").trim();
      if (!rmaNo) throw createApiError("RECEIPT_PREPARATION_INVALID", "缺少必填字段：rmaNo", 400);
      const order = (await receiptStore.readAll()).find((item) => item.rmaNo === rmaNo);
      if (!order) throw createApiError("RECEIPT_PREPARATION_NOT_FOUND", "未找到本地签收准备记录", 404);
      const canAttachDuringLocalSimulation = order.status === "MODEL_AUTHORIZATION_REVIEW"
        && order.modelAuthorization?.localWorkflowAllowed === true;
      if (order.status !== "RECEIPT_PREPARED" && !canAttachDuringLocalSimulation) {
        throw createApiError("RECEIPT_ATTACHMENT_NOT_ALLOWED", "当前工单状态不能补充签收照片", 409);
      }
      const attachment = await receiptAttachmentStore.save(req.body || {});
      const updated = await receiptStore.addReceiptAttachment(rmaNo, attachment, currentUserProvider(req));
      res.json({ success: true, data: { attachment, attachments: updated.receiptAttachments } });
    } catch (error) { next(error); }
  });

  app.post("/api/repairs/inspection", async (req, res, next) => {
    const rmaNo = String(req.body?.rmaNo || "").trim();
    if (!rmaNo) {
      return res.status(400).json({
        success: false,
        code: "INSPECTION_INVALID",
        message: "缺少必填字段：rmaNo",
        missingFields: ["rmaNo"],
      });
    }
    try {
      if (req.body?.faultCategoryConfirmed !== true) {
        throw createApiError("INSPECTION_FAULT_CATEGORY_UNCONFIRMED", "三级故障必须从瑞云返回的选项中选择", 400);
      }
      const order = (await receiptStore.readAll()).find((item) => item.rmaNo === rmaNo);
      if (!order) throw createApiError("RECEIPT_PREPARATION_NOT_FOUND", "未找到待检测工单", 404);
      const warranty = evaluateWarranty({
        sn: order.sn,
        purchaseDate: order.purchaseDate,
        warrantyYears: order.modelAuthorization?.warrantyYears || 2,
        isOfficialRefurbished: order.modelAuthorization?.isOfficialRefurbished === true,
      });
      if (warranty.status !== "DETERMINED") {
        throw createApiError("WARRANTY_MANUAL_CONFIRMATION_REQUIRED", warranty.reason || "质保状态无法自动判断，需人工确认", 409);
      }
      const decision = buildInspectionFormDecision({
        faultCategory: req.body?.faultCategory,
        technicianWarranty: req.body?.technicianWarranty,
        snWarranty: warranty.warrantyStatus,
        detectionResult: req.body?.inspectionResult,
      });
      if (decision.status !== "READY") {
        throw createApiError(
          decision.status === "MANUAL_CONFIRMATION_REQUIRED" ? "WARRANTY_MISMATCH" : "INSPECTION_FORM_INVALID",
          decision.reason || `检测必填项不完整：${(decision.missingFields || []).join(", ")}`,
          decision.status === "MANUAL_CONFIRMATION_REQUIRED" ? 409 : 400
        );
      }
      const data = await receiptStore.saveInspection(
        rmaNo,
        {
          inspectionResult: decision.fields.detectionResult,
          inspectionRemark: req.body?.inspectionRemark,
          faultCategory: decision.fields.faultCategory,
          technicianWarranty: decision.fields.warrantyStatus,
          warrantyDecision: warranty,
          customerReasonConsistent: decision.fields.customerReasonConsistent,
          detectionResult: decision.fields.detectionResult,
          inspectionAbnormal: decision.fields.inspectionAbnormal,
          responsibilityDecision: decision.fields.responsibilityDecision,
          productFunctionDecision: decision.fields.productFunctionDecision,
          originalConsumables: decision.fields.originalConsumables,
          consumableName: decision.fields.consumableName,
          dismantled: decision.fields.dismantled,
        },
        currentUserProvider(req)
      );
      await enqueueRecloudNode(data, "INSPECTION_COMPLETED", data.inspectionUpdatedAt || data.id);
      const recloudPrefillPlan = buildRecloudInspectionFormPlan({
        faultCategory: data.faultCategory,
        warrantyStatus: data.technicianWarranty,
        detectionResult: data.detectionResult,
      });
      return res.json({
        success: true,
        data: {
          ...data,
          recloudPrefillPlan,
          message: "检测信息已保存到 FieldDesk；请按瑞云预填清单人工核对后确认",
          recloudSynced: false,
        },
      });
    } catch (error) {
      return next(error);
    }
  });

  app.post("/api/repairs/supervision/capture", async (req, res, next) => {
    try {
      const rmaNo = String(req.body?.rmaNo || "").trim();
      if (!rmaNo) throw createApiError("SUPERVISION_RMA_REQUIRED", "缺少督办单对应寄修单号", 400);
      const analysis = analyzeSupervisionOrder(req.body?.content);
      const data = await receiptStore.saveSupervisionOrder(rmaNo, {
        sourceId: req.body?.sourceId,
        originalContent: analysis.originalContent,
        analysis,
      }, currentUserProvider(req));
      res.json({ success: true, data: { ...data, message: "督办单已通知对应师傅；瑞云回复仍由信息员操作" } });
    } catch (error) { next(error); }
  });

  app.post("/api/repairs/supervision/sync", async (req, res, next) => {
    try {
      const rmaNo = String(req.body?.rmaNo || "").trim();
      const records = await receiptStore.readAll();
      const order = records.find((item) => item.rmaNo === rmaNo);
      if (!order) throw createApiError("RECEIPT_PREPARATION_NOT_FOUND", "未找到督办单对应工单", 404);
      const user = currentUserProvider(req);
      const privileged = [USER_ROLES.ADMIN, USER_ROLES.WAREHOUSE].includes(user.role);
      if (!privileged && (order.technicianId || order.operatorId) !== user.userId) {
        throw createApiError("SUPERVISION_FORBIDDEN", "只能同步本人负责工单的督办单", 403);
      }
      const liveOrders = await withRecloud(connector, async (page) => {
        return connector.readPendingRmaSupervisionOrders(page);
      });
      const captured = [];
      for (const liveOrder of liveOrders.filter((item) => item.rmaNo === rmaNo)) {
        const analysis = analyzeSupervisionOrder(
          liveOrder.content ||
          liveOrder.processingRecord ||
          `${liveOrder.type || ""} ${liveOrder.subtype || ""}`.trim() ||
          "瑞云督办单待信息员确认",
          { type: liveOrder.type, subtype: liveOrder.subtype }
        );
        const saved = await receiptStore.saveSupervisionOrder(rmaNo, {
          sourceId: liveOrder.sourceId,
          originalContent: analysis.originalContent,
          analysis: { ...analysis, source: liveOrder },
        }, user);
        captured.push(saved.supervisionOrder);
      }
      res.json({ success: true, data: captured });
    } catch (error) { next(error); }
  });

  app.get("/api/repairs/supervision", async (req, res, next) => {
    try {
      const rmaNo = String(req.query?.rmaNo || "").trim();
      const order = (await receiptStore.readAll()).find((item) => item.rmaNo === rmaNo);
      if (!order) throw createApiError("RECEIPT_PREPARATION_NOT_FOUND", "未找到督办单对应工单", 404);
      const user = currentUserProvider(req);
      const privileged = [USER_ROLES.ADMIN, USER_ROLES.WAREHOUSE].includes(user.role);
      if (!privileged && (order.technicianId || order.operatorId) !== user.userId) {
        throw createApiError("SUPERVISION_FORBIDDEN", "只能查看本人负责工单的督办单", 403);
      }
      res.json({
        success: true,
        data: (order.supervisionOrders || []).filter((item) => !item.archivedAt).map((item) => ({
          ...item,
          isRead: (item.readBy || []).some((entry) => entry.userId === user.userId),
          readBy: undefined,
        })),
      });
    } catch (error) { next(error); }
  });

  app.get("/api/repairs/supervision/inbox", async (req, res, next) => {
    try {
      const user = currentUserProvider(req);
      const orders = await receiptStore.listOrdersForUser(user, USER_ROLES);
      const inbox = orders.flatMap((order) => (order.supervisionOrders || []).filter((item) => !item.archivedAt).map((item) => ({
        ...item,
        rmaNo: order.rmaNo,
        orderStatus: order.status,
        isRead: (item.readBy || []).some((entry) => entry.userId === user.userId),
        readBy: undefined,
      })));
      res.json({ success: true, data: inbox });
    } catch (error) { next(error); }
  });

  app.post("/api/repairs/supervision/read", async (req, res, next) => {
    try {
      const rmaNo = String(req.body?.rmaNo || "").trim();
      const supervisionOrderId = String(req.body?.supervisionOrderId || "").trim();
      if (!rmaNo || !supervisionOrderId) throw createApiError("SUPERVISION_READ_FIELDS_REQUIRED", "缺少督办通知已读信息", 400);
      const records = await receiptStore.readAll();
      const order = records.find((item) => item.rmaNo === rmaNo);
      if (!order) throw createApiError("RECEIPT_PREPARATION_NOT_FOUND", "未找到督办单对应工单", 404);
      const user = currentUserProvider(req);
      const privileged = [USER_ROLES.ADMIN, USER_ROLES.WAREHOUSE].includes(user.role);
      if (!privileged && (order.technicianId || order.operatorId) !== user.userId) {
        throw createApiError("SUPERVISION_FORBIDDEN", "只能查看本人负责工单的督办单", 403);
      }
      const item = await receiptStore.markSupervisionOrderRead(rmaNo, supervisionOrderId, user);
      res.json({ success: true, data: { ...item, isRead: true, readBy: undefined } });
    } catch (error) { next(error); }
  });

  app.post("/api/repairs/inspection/warranty-check", async (req, res, next) => {
    try {
      const rmaNo = String(req.body?.rmaNo || "").trim();
      const order = rmaNo
        ? (await receiptStore.readAll()).find((item) => item.rmaNo === rmaNo)
        : null;
      const result = evaluateWarranty({
        sn: order?.sn || req.body?.sn,
        purchaseDate: order?.purchaseDate,
        warrantyYears: order?.modelAuthorization?.warrantyYears || 2,
        isOfficialRefurbished: order?.modelAuthorization?.isOfficialRefurbished === true,
      });
      return res.json({ success: true, data: result });
    } catch (error) {
      return next(error);
    }
  });

  app.post("/api/repairs/inspection/model-match", async (req, res, next) => {
    const rmaNo = String(req.body?.rmaNo || "").trim();
    if (!rmaNo) return next(createApiError("INSPECTION_MODEL_INVALID", "缺少必填字段：rmaNo", 400));
    try {
      const order = (await receiptStore.readAll()).find((item) => item.rmaNo === rmaNo);
      if (!order) throw createApiError("RECEIPT_PREPARATION_NOT_FOUND", "未找到待检测工单", 404);
      const match = await feishuModelCatalog.match({
        sn: order.sn,
        productLine: order.productLine || order.specialty,
        productName: req.body?.productName,
        projectCode: req.body?.projectCode,
        currentModel: req.body?.currentModel,
      });
      return res.json({
        success: true,
        data: {
          ...match,
          source: "FEISHU_MODEL_SHEET",
          autoAction: match.status === "MATCHED" ? "KEEP" : match.status === "CHANGE_REQUIRED" ? "REPLACE" : "STOP",
        },
      });
    } catch (error) {
      return next(error);
    }
  });

  async function hydratePartApplications(order) {
    const applications = Array.isArray(order?.partApplications) ? order.partApplications : [];
    const projectCode = getSnProjectMatch(order?.sn).projectCode;
    const productLine = order?.specialty || order?.productLine;
    return Promise.all(applications.map(async (application) => {
      if (application.retailPrice !== null && application.retailPrice !== undefined && application.retailPrice !== "") return application;
      try {
        const matches = await feishuPartsCatalog.search({ productLine, projectCode, keyword: application.partCode });
        const latest = matches.find((item) => item.code === application.partCode);
        return latest ? {
          ...application,
          partName: latest.name || application.partName,
          retailPrice: latest.retailPrice,
          repairLevel: latest.repairLevel || application.repairLevel,
          returnRequired: Boolean(latest.returnRequired),
        } : application;
      } catch {
        return application;
      }
    }));
  }

  async function repairFeesForOrder(order) {
    const savedFees = order?.modelAuthorization?.repairFees || {};
    if (Object.values(savedFees).some((value) => Number(value) > 0)) return savedFees;
    try {
      const authorization = await feishuModelCatalog.authorize({
        sn: order?.sn,
        currentProjectCode: order?.recloudProjectCode || "",
      });
      return authorization.repairFees || savedFees;
    } catch {
      return savedFees;
    }
  }

  app.post("/api/repairs/parts/apply", async (req, res, next) => {
    const rmaNo = String(req.body?.rmaNo || "").trim();
    const partCode = String(req.body?.partCode || "").trim();
    if (!rmaNo || !partCode) {
      return res.status(400).json({
        success: false,
        code: "PART_APPLICATION_INVALID",
        message: !rmaNo ? "缺少寄修单号" : "请选择有效配件",
      });
    }
    try {
      const user = currentUserProvider(req);
      if (user.role !== USER_ROLES.TECHNICIAN) throw createApiError("INVENTORY_ACTION_FORBIDDEN", "只有维修师傅可以申请配件", 403);
      const order = (await receiptStore.readAll()).find((item) => item.rmaNo === rmaNo);
      if (!order || !["RECEIVED_PENDING_INSPECTION", "INSPECTION_COMPLETED_PENDING_REPAIR", "REPAIR_COMPLETION_DRAFT"].includes(order.status)) throw createApiError("PART_APPLICATION_NOT_ALLOWED", "当前工单不能选择维修配件", 409);
      const projectCode = getSnProjectMatch(order.sn).projectCode;
      const productLine = order.specialty || order.productLine;
      const part = (await feishuPartsCatalog.search({ productLine, projectCode, keyword: partCode }))
        .find((item) => item.code === partCode);
      if (!part) throw createApiError("PART_NOT_FOUND", "该配件不适用于当前机型", 404);
      const data = await receiptStore.applyPart(rmaNo, { ...part, stock: Number(req.body?.quantity) }, req.body?.quantity, user);
      const pricing = buildPricingPreview({
        modelRepairFees: data.order?.modelAuthorization?.repairFees || order.modelAuthorization?.repairFees || {},
        usedParts: data.order?.partApplications || [],
        warrantyStatus: data.order?.technicianWarranty || order.technicianWarranty,
      });
      return res.json({
        success: true,
        data: {
          ...data,
          pricing,
          message: "配件已记录到当前工单",
          recloudSynced: false,
        },
      });
    } catch (error) {
      return next(error);
    }
  });

  app.get("/api/parts-catalog", async (req, res, next) => {
    try {
      const rmaNo = String(req.query.rmaNo || "").trim();
      const keyword = String(req.query.keyword || "").trim().toUpperCase();
      const order = (await receiptStore.readAll()).find((item) => item.rmaNo === rmaNo);
      if (!order) throw createApiError("RECEIPT_PREPARATION_NOT_FOUND", "未找到当前工单", 404);
      const projectCode = getSnProjectMatch(order.sn).projectCode;
      const productLine = order.specialty || order.productLine;
      const items = await feishuPartsCatalog.search({ productLine, projectCode, keyword });
      res.json({ success: true, data: { projectCode, source: "FEISHU_LIVE", queriedAt: new Date().toISOString(), items } });
    } catch (error) { next(error); }
  });

  app.get("/api/repairs/parts", async (req, res, next) => {
    try {
      const rmaNo = String(req.query.rmaNo || "").trim();
      const order = (await receiptStore.readAll()).find((item) => item.rmaNo === rmaNo);
      if (!order) throw createApiError("RECEIPT_PREPARATION_NOT_FOUND", "未找到当前工单", 404);
      const items = await hydratePartApplications(order);
      const pricing = buildPricingPreview({
        modelRepairFees: order.modelAuthorization?.repairFees || {},
        usedParts: items,
        warrantyStatus: order.technicianWarranty,
      });
      res.json({ success: true, data: { items, pricing } });
    } catch (error) { next(error); }
  });

  app.post("/api/repairs/parts/update", async (req, res, next) => {
    try {
      const user = currentUserProvider(req);
      if (user.role !== USER_ROLES.TECHNICIAN) throw createApiError("INVENTORY_ACTION_FORBIDDEN", "只有维修师傅可以修改配件", 403);
      const data = await receiptStore.updatePartApplication(
        String(req.body?.rmaNo || "").trim(),
        String(req.body?.applicationId || "").trim(),
        { quantity: req.body?.quantity, remove: req.body?.remove === true },
        user
      );
      const pricing = buildPricingPreview({
        modelRepairFees: data.order?.modelAuthorization?.repairFees || {},
        usedParts: data.order?.partApplications || [],
        warrantyStatus: data.order?.technicianWarranty,
      });
      res.json({ success: true, data: { ...data, pricing, message: req.body?.remove === true ? "配件已删除" : "配件数量已修改" } });
    } catch (error) { next(error); }
  });

  app.post("/api/repairs/parts/confirm", async (req, res, next) => {
    try {
      const user = currentUserProvider(req);
      if (user.role !== USER_ROLES.TECHNICIAN) throw createApiError("INVENTORY_ACTION_FORBIDDEN", "只有维修师傅可以确认配件", 403);
      const data = await receiptStore.confirmParts(String(req.body?.rmaNo || "").trim(), user);
      res.json({ success: true, data: { ...data, message: data.nextStep === "repairCompletion" ? "配件已确认，进入维修完工" : "配件已确认，进入检测登记" } });
    } catch (error) { next(error); }
  });

  app.get("/api/inventory", async (req, res, next) => {
    try {
      const user = currentUserProvider(req);
      const data = await inventoryStore.view(user, USER_ROLES);
      res.json({ success: true, data });
    } catch (error) { next(error); }
  });

  app.post("/api/inventory/stock-in", async (req, res, next) => {
    try {
      const user = currentUserProvider(req);
      if (![USER_ROLES.ADMIN, USER_ROLES.WAREHOUSE].includes(user.role)) throw createApiError("INVENTORY_ACTION_FORBIDDEN", "只有管理员或库房可以登记入库", 403);
      const data = await inventoryStore.receive(req.body?.partCode, req.body?.partName, req.body?.quantity, user);
      res.json({ success: true, data: { ...data, message: "配件入库已记录" } });
    } catch (error) { next(error); }
  });

  app.post("/api/inventory/allocate", async (req, res, next) => {
    try {
      const user = currentUserProvider(req);
      if (![USER_ROLES.ADMIN, USER_ROLES.WAREHOUSE].includes(user.role)) throw createApiError("INVENTORY_ACTION_FORBIDDEN", "只有管理员或库房可以发放配件", 403);
      const technician = { userId: String(req.body?.technicianId || "").trim(), displayName: String(req.body?.technicianName || "").trim(), role: USER_ROLES.TECHNICIAN };
      if (!technician.userId || !technician.displayName) throw createApiError("INVENTORY_TECHNICIAN_REQUIRED", "请选择领用师傅", 400);
      const data = await inventoryStore.allocate(req.body?.partCode, req.body?.quantity, technician, user);
      res.json({ success: true, data: { ...data, message: "配件已发放给师傅" } });
    } catch (error) { next(error); }
  });

  async function inventoryContext(req) {
    const rmaNo = String(req.body?.rmaNo || "").trim();
    const order = (await receiptStore.readAll()).find((item) => item.rmaNo === rmaNo);
    if (!order) throw createApiError("RECEIPT_PREPARATION_NOT_FOUND", "未找到当前工单", 404);
    return { rmaNo, sn: order.sn };
  }

  app.post("/api/inventory/use", async (req, res, next) => {
    try {
      const user = currentUserProvider(req);
      if (user.role !== USER_ROLES.TECHNICIAN) throw createApiError("INVENTORY_ACTION_FORBIDDEN", "只有维修师傅可以使用配件", 403);
      const data = await inventoryStore.use(await inventoryContext(req), String(req.body?.partCode || ""), req.body?.quantity, user);
      res.json({ success: true, data: { ...data, message: "配件使用已记录" } });
    } catch (error) { next(error); }
  });

  app.post("/api/inventory/returns", async (req, res, next) => {
    try {
      const user = currentUserProvider(req);
      if (user.role !== USER_ROLES.TECHNICIAN) throw createApiError("INVENTORY_ACTION_FORBIDDEN", "只有维修师傅可以申请退还", 403);
      const data = await inventoryStore.requestReturn(await inventoryContext(req), String(req.body?.partCode || ""), req.body?.quantity, user);
      res.json({ success: true, data: { ...data, message: "退还申请已提交，等待库房确认" } });
    } catch (error) { next(error); }
  });

  app.post("/api/inventory/returns/confirm", async (req, res, next) => {
    try {
      const user = currentUserProvider(req);
      if (![USER_ROLES.ADMIN, USER_ROLES.WAREHOUSE].includes(user.role)) throw createApiError("INVENTORY_ACTION_FORBIDDEN", "只有管理员或库房可以确认退还", 403);
      const data = await inventoryStore.confirmReturn(String(req.body?.requestId || ""), user);
      res.json({ success: true, data: { ...data, message: "退还已确认并入总库" } });
    } catch (error) { next(error); }
  });

  app.get("/api/repairs/completion/fault-catalog", async (req, res, next) => {
    try {
      const data = await faultCatalogStore.read();
      res.json({ success: true, data: { source: "RECLOUD_LOCAL_MIRROR", ...data, items: buildFaultHierarchy(data.items) } });
    } catch (error) { next(error); }
  });

  app.post("/api/repairs/completion/context", async (req, res, next) => {
    try {
      const rmaNo = String(req.body?.rmaNo || "").trim();
      const order = (await receiptStore.readAll()).find((item) => item.rmaNo === rmaNo);
      if (!order) throw createApiError("RECEIPT_PREPARATION_NOT_FOUND", "未找到待维修工单", 404);
      if (!["INSPECTION_COMPLETED_PENDING_REPAIR", "REPAIR_COMPLETION_DRAFT"].includes(order.status)) {
        throw createApiError("REPAIR_COMPLETION_NOT_ALLOWED", "仅已完成检测的工单可以进入维修完工", 409);
      }
      const appliedParts = (await hydratePartApplications(order)).map((part) => ({
        partCode: part.partCode, partName: part.partName, quantity: part.quantity,
        repairLevel: part.repairLevel, retailPrice: part.retailPrice,
        returnRequired: Boolean(part.returnRequired),
      }));
      const usedParts = appliedParts.length ? appliedParts : await inventoryStore.usedPartsForOrder(order.rmaNo, order.sn);
      const { noPartsService } = getOutOfWarrantyFeePolicy(order);
      const modelRepairFees = await repairFeesForOrder(order);
      const repairPricing = noPartsService
        ? { status: "NO_PARTS_SERVICE", canPrice: true, highestLevel: "无配件", fee: 0 }
        : resolveOutOfWarrantyFee(modelRepairFees, usedParts);
      const partsPricing = noPartsService
        ? { status: "READY", canPrice: true, partsFee: 0 }
        : resolvePartsFee(usedParts);
      const canPrice = repairPricing.canPrice === true && partsPricing.canPrice === true;
      const pricing = order.technicianWarranty === "保外"
        ? {
            ...repairPricing,
            ...(!partsPricing.canPrice ? { status: partsPricing.status, unresolvedParts: partsPricing.unresolvedParts } : {}),
            canPrice,
            partsFee: partsPricing.partsFee,
            subtotal: canPrice ? Number((partsPricing.partsFee + repairPricing.fee).toFixed(2)) : null,
          }
        : { status: "IN_WARRANTY", canPrice: true, partsFee: 0, fee: 0, subtotal: 0 };
      res.json({ success: true, data: { order, usedParts, pricing, recloudSynced: false } });
    } catch (error) { next(error); }
  });

  app.post("/api/repairs/completion/attachments", async (req, res, next) => {
    try {
      res.json({ success: true, data: await attachmentStore.save(req.body || {}) });
    } catch (error) { next(error); }
  });

  async function saveRepairCompletion(req, res, next, submit) {
    try {
      const rmaNo = String(req.body?.rmaNo || "").trim();
      const order = (await receiptStore.readAll()).find((item) => item.rmaNo === rmaNo);
      if (!order) throw createApiError("RECEIPT_PREPARATION_NOT_FOUND", "未找到待维修工单", 404);
      const appliedParts = (await hydratePartApplications(order)).map((part) => ({
        partCode: part.partCode, partName: part.partName, quantity: part.quantity,
        repairLevel: part.repairLevel, retailPrice: part.retailPrice,
        returnRequired: Boolean(part.returnRequired),
      }));
      const usedParts = appliedParts.length ? appliedParts : await inventoryStore.usedPartsForOrder(order.rmaNo, order.sn);
      const {
        noPartsService,
        isOutOfWarranty,
        requiresOutOfWarrantyFee,
      } = getOutOfWarrantyFeePolicy(order);
      const modelRepairFees = await repairFeesForOrder(order);
      const logisticsChargeMode = isOutOfWarranty
        ? String(req.body?.logisticsChargeMode || "ROUND_TRIP").trim()
        : "NOT_CHARGED";
      const rawOneWayLogisticsFee = req.body?.oneWayLogisticsFee;
      if (submit && requiresOutOfWarrantyFee && (rawOneWayLogisticsFee === "" || rawOneWayLogisticsFee === null || rawOneWayLogisticsFee === undefined)) {
        throw createApiError("LOGISTICS_FEE_REQUIRED", "保外工单必须填写单程物流费", 400);
      }
      const oneWayLogisticsFee = isOutOfWarranty && rawOneWayLogisticsFee !== "" && rawOneWayLogisticsFee !== null && rawOneWayLogisticsFee !== undefined
        ? Number(rawOneWayLogisticsFee)
        : 0;
      if (!Number.isFinite(oneWayLogisticsFee) || oneWayLogisticsFee < 0) {
        throw createApiError("LOGISTICS_FEE_INVALID", "单程物流费必须是大于或等于 0 的数字", 400);
      }
      const repairPricing = noPartsService
        ? { status: "NO_PARTS_SERVICE", canPrice: true, highestLevel: "无配件", fee: 0 }
        : resolveOutOfWarrantyFee(modelRepairFees, usedParts);
      const partsPricing = noPartsService
        ? { status: "READY", canPrice: true, partsFee: 0 }
        : resolvePartsFee(usedParts);
      const canPrice = repairPricing.canPrice === true && partsPricing.canPrice === true;
      const partsFee = partsPricing.partsFee;
      if (submit && isOutOfWarranty && !canPrice) {
        throw createApiError("OUT_OF_WARRANTY_PRICE_REVIEW_REQUIRED", "配件零售价、维修等级或机型维修费不完整，请转人工核价", 409);
      }
      let charge = null;
      if (isOutOfWarranty && canPrice) {
        try {
          charge = resolveRepairCharge({
            partsFee,
            repairFee: repairPricing.fee,
            oneWayLogisticsFee,
            logisticsChargeMode,
          });
        } catch (error) {
          if (["LOGISTICS_FEE_INVALID", "LOGISTICS_CHARGE_MODE_INVALID"].includes(error.code)) {
            throw createApiError(error.code, error.message, 400);
          }
          throw error;
        }
      }
      const pricing = isOutOfWarranty
        ? {
            ...repairPricing,
            partsFee,
            ...(charge || {
              logisticsChargeMode,
              oneWayLogisticsFee,
              logisticsFee: null,
              logisticsMultiplier: null,
              totalFee: null,
              primaryRemark: null,
              secondaryRemark: null,
            }),
            canPrice,
            ...(!partsPricing.canPrice ? { status: partsPricing.status, unresolvedParts: partsPricing.unresolvedParts } : {}),
            subtotal: canPrice ? Number((partsFee + repairPricing.fee).toFixed(2)) : null,
            logisticsSource: "MANUAL_EDITABLE",
          }
        : {
            status: "IN_WARRANTY", canPrice: true, partsFee: 0, fee: 0,
            logisticsChargeMode: "NOT_CHARGED", oneWayLogisticsFee: 0,
            logisticsFee: 0, logisticsMultiplier: 0, subtotal: 0, totalFee: 0,
            primaryRemark: null, secondaryRemark: null, logisticsSource: "NOT_CHARGED",
          };
      const confirmedFaultPath = String(order.faultCategory || "").split(/[|/]/).map((item) => item.trim()).filter(Boolean);
      const confirmedFault = confirmedFaultPath.length >= 3
        ? {
            faultLevel1: confirmedFaultPath[0],
            faultLevel2: confirmedFaultPath[1],
            faultLevel3: confirmedFaultPath.slice(2).join(" / "),
          }
        : {};
      if (!["保内", "保外"].includes(order.technicianWarranty)) {
        throw createApiError("TECHNICIAN_WARRANTY_REQUIRED", "检测阶段尚未确认保内或保外，不能提交维修完工", 409);
      }
      const responsibilityType = order.treatmentMode === "INSPECTION_ONLY"
        ? "保内质保"
        : order.technicianWarranty === "保外" ? "保外维修" : "保内质保";
      const data = await receiptStore.saveRepairCompletion(
        rmaNo,
        {
          ...req.body,
          ...confirmedFault,
          responsibilityType,
          usedParts,
          logisticsChargeMode: pricing.logisticsChargeMode,
          oneWayLogisticsFee,
          logisticsFee: pricing.logisticsFee,
          primaryRemark: pricing.primaryRemark,
          secondaryRemark: pricing.secondaryRemark,
          pricing,
        },
        currentUserProvider(req),
        submit
      );
      if (submit) {
        await enqueueRecloudNode(
          data,
          "REPAIR_COMPLETED",
          data.repairCompletion?.submittedAt || data.id
        );
      }
      res.json({
        success: true,
        data: {
          ...data,
          statusLabel: submit ? "维修已完成" : "维修完工草稿",
          message: submit ? "维修完工已保存，师傅操作已结束，后续发货由后台处理" : "维修完工草稿已保存",
          recloudSynced: false,
        },
      });
    } catch (error) { next(error); }
  }

  app.post("/api/repairs/completion/draft", (req, res, next) => saveRepairCompletion(req, res, next, false));
  app.post("/api/repairs/completion/submit", (req, res, next) => saveRepairCompletion(req, res, next, true));

  app.get("/api/shipping/orders", async (req, res, next) => {
    try {
      const user = currentUserProvider(req);
      res.json({ success: true, data: await receiptStore.listShippingOrders(user, USER_ROLES) });
    } catch (error) { next(error); }
  });

  app.post("/api/shipping/context", async (req, res, next) => {
    try {
      const rmaNo = String(req.body?.rmaNo || "").trim();
      const user = currentUserProvider(req);
      const order = (await receiptStore.readAll()).find((item) => item.rmaNo === rmaNo);
      if (!order) throw createApiError("RECEIPT_PREPARATION_NOT_FOUND", "未找到待发货工单", 404);
      if (![USER_ROLES.ADMIN, USER_ROLES.INFORMATION_CLERK].includes(user.role)) {
        throw createApiError("SHIPPING_ORDER_FORBIDDEN", "只有信息员或管理员可以查看后台发货进度", 403);
      }
      if (!["REPAIR_COMPLETED_PENDING_SHIPMENT", "SHIPPED_PENDING_COMPLETION"].includes(order.status)) {
        throw createApiError("RETURN_SHIPMENT_NOT_ALLOWED", "当前工单不能进入返件发货", 409);
      }
      const usedParts = await inventoryStore.usedPartsForOrder(order.rmaNo, order.sn);
      res.json({ success: true, data: { order, usedParts, syncProvider: "RECLOUD_RESERVED", recloudSynced: false } });
    } catch (error) { next(error); }
  });

  app.post("/api/shipping/attachments", async (req, res, next) => {
    try {
      res.json({ success: true, data: await shippingAttachmentStore.save(req.body || {}) });
    } catch (error) { next(error); }
  });

  app.post("/api/shipping/submit", async (req, res, next) => {
    try {
      const user = currentUserProvider(req);
      const rmaNo = String(req.body?.rmaNo || "").trim();
      const order = (await receiptStore.readAll()).find((item) => item.rmaNo === rmaNo);
      if (!order) throw createApiError("RECEIPT_PREPARATION_NOT_FOUND", "未找到待发货工单", 404);
      const privileged = [USER_ROLES.ADMIN, USER_ROLES.WAREHOUSE].includes(user.role);
      if (!privileged && (order.technicianId || order.operatorId) !== user.userId) {
        throw createApiError("SHIPPING_ORDER_FORBIDDEN", "只能操作本人负责的待发货工单", 403);
      }
      const data = await receiptStore.submitReturnShipment(rmaNo, req.body || {}, user);
      await enqueueRecloudNode(data, "RETURN_SHIPPED", data.returnShipment?.shippedAt || data.id);
      res.json({ success: true, data: { ...data, statusLabel: "已发货/待完结", message: "返件发货已保存到 FieldDesk", recloudSynced: false } });
    } catch (error) { next(error); }
  });

  app.post("/api/shipping/complete", async (req, res, next) => {
    try {
      const user = currentUserProvider(req);
      if (user.role !== USER_ROLES.ADMIN) throw createApiError("ORDER_COMPLETION_FORBIDDEN", "只有管理员可以确认完结", 403);
      const data = await receiptStore.confirmCompletion(String(req.body?.rmaNo || "").trim(), user);
      await enqueueRecloudNode(data, "ORDER_COMPLETED", data.completedAt || data.id);
      res.json({ success: true, data: { ...data, statusLabel: "已完结", message: "工单已在 FieldDesk 本地完结", recloudSynced: false } });
    } catch (error) { next(error); }
  });

  app.get("/api/recloud-sync/tasks", async (req, res, next) => {
    try {
      const user = currentUserProvider(req);
      if (user.role !== USER_ROLES.ADMIN) throw createApiError("SYNC_TASKS_FORBIDDEN", "只有管理员可以查看瑞云同步任务", 403);
      res.json({ success: true, data: await syncService.outbox.readAll() });
    } catch (error) { next(error); }
  });

  app.get("/api/recloud-sync/order-status", async (req, res, next) => {
    try {
      const user = currentUserProvider(req);
      const rmaNo = String(req.query?.rmaNo || "").trim();
      if (!rmaNo) throw createApiError("SYNC_ORDER_STATUS_RMA_REQUIRED", "缺少寄修单号", 400);
      const order = (await receiptStore.readAll()).find((item) => item.rmaNo === rmaNo);
      if (!order) throw createApiError("SYNC_ORDER_STATUS_NOT_FOUND", "未找到对应本地工单", 404);
      const isAdmin = user.role === USER_ROLES.ADMIN;
      const isAssignedTechnician = user.role === USER_ROLES.TECHNICIAN
        && (order.technicianId || order.operatorId) === user.userId;
      if (!isAdmin && !isAssignedTechnician) {
        throw createApiError("SYNC_ORDER_STATUS_FORBIDDEN", "只能查看本人负责工单的瑞云同步状态", 403);
      }
      const task = (await syncService.outbox.readAll())
        .filter((item) => item.nodeType === "REPAIR_COMPLETED" && item.rmaNo === rmaNo)
        .sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")))[0] || null;
      res.json({ success: true, data: task ? {
        exists: true,
        status: task.status,
        completedSteps: Array.isArray(task.completedSteps) ? task.completedSteps.slice(0, 20) : [],
        reviewSteps: Array.isArray(task.reviewSteps) ? task.reviewSteps.slice(0, 10) : [],
        updatedAt: task.updatedAt,
      } : {
        exists: false,
        status: "NOT_CREATED",
        completedSteps: [],
        reviewSteps: [],
        updatedAt: "",
      } });
    } catch (error) { next(error); }
  });

  app.get("/api/recloud-sync/diagnostics", async (req, res, next) => {
    try {
      const user = currentUserProvider(req);
      if (user.role !== USER_ROLES.ADMIN) throw createApiError("SYNC_DIAGNOSTICS_FORBIDDEN", "只有管理员可以查看瑞云同步诊断", 403);
      res.json({ success: true, data: await syncDiagnostics.inspectAll() });
    } catch (error) { next(error); }
  });

  for (const nodeKey of ["receipt", "inspection", "repair", "shipping", "completion"]) {
    app.get(`/api/recloud-sync/diagnostics/${nodeKey}/inspect`, async (req, res, next) => {
      try {
        const user = currentUserProvider(req);
        if (user.role !== USER_ROLES.ADMIN) throw createApiError("SYNC_DIAGNOSTICS_FORBIDDEN", "只有管理员可以查看瑞云同步诊断", 403);
        res.json({ success: true, data: await syncDiagnostics.inspect(nodeKey) });
      } catch (error) { next(error); }
    });
    app.post(`/api/recloud-sync/diagnostics/${nodeKey}/capture`, async (req, res, next) => {
      try {
        const user = currentUserProvider(req);
        if (user.role !== USER_ROLES.ADMIN) throw createApiError("SYNC_DIAGNOSTICS_FORBIDDEN", "只有管理员可以采集瑞云同步诊断", 403);
        const revealPhone = String(process.env.RECLOUD_REVEAL_PHONE_ENABLED || "false").toLowerCase() === "true";
        if (!isDryRun() || isRecloudWriteEnabled() || revealPhone) {
          throw createApiError("SYNC_DIAGNOSTICS_UNSAFE", "同步诊断采集只允许在严格只读安全模式下执行", 403);
        }
        res.json({ success: true, data: await syncDiagnostics.capture(nodeKey, req.body || {}) });
      } catch (error) { next(error); }
    });
  }

  app.get("/api/repairs/local-orders", async (req, res, next) => {
    try {
      const user = currentUserProvider(req);
      res.json({ success: true, data: await receiptStore.listOrdersForUser(user, USER_ROLES) });
    } catch (error) { next(error); }
  });

  app.get("/api/repairs/history", async (req, res, next) => {
    try {
      const user = currentUserProvider(req);
      if (![USER_ROLES.TECHNICIAN, USER_ROLES.INFORMATION_CLERK, USER_ROLES.ADMIN].includes(user.role)) {
        throw createApiError("REPAIR_HISTORY_FORBIDDEN", "当前账号不能查看历史维修记录", 403);
      }
      const keyword = String(req.query?.keyword || req.query?.phone || "").trim();
      const isPhone = /^1[3-9]\d{9}$/.test(keyword.replace(/\D/g, ""));
      const isSn = !isPhone && /^[A-Z0-9-]{8,}$/i.test(keyword);
      if (!isPhone && !isSn) {
        throw createApiError("REPAIR_HISTORY_KEYWORD_INVALID", "请输入完整手机号或机器 SN", 400);
      }
      const data = queryRepairHistory(await receiptStore.readAll(), keyword).slice(0, 100);
      res.json({ success: true, data });
    } catch (error) { next(error); }
  });

  app.get("/api/repairs/repeat-repair", async (req, res, next) => {
    try {
      const user = currentUserProvider(req);
      if (![USER_ROLES.TECHNICIAN, USER_ROLES.INFORMATION_CLERK, USER_ROLES.ADMIN].includes(user.role)) {
        throw createApiError("REPAIR_HISTORY_FORBIDDEN", "当前账号不能查看历史维修记录", 403);
      }
      const sn = String(req.query?.sn || "").trim();
      if (!/^[A-Z0-9-]{8,}$/i.test(sn)) {
        throw createApiError("REPEAT_REPAIR_SN_INVALID", "请输入完整机器 SN", 400);
      }
      const data = findMachineRepairHistory(await receiptStore.readAll(), {
        sn,
        currentRmaNo: String(req.query?.excludeRmaNo || "").trim(),
      });
      res.json({ success: true, data });
    } catch (error) { next(error); }
  });

  app.get("/api/repairs/machines-in-hand", async (req, res, next) => {
    try {
      const user = currentUserProvider(req);
      if (![USER_ROLES.INFORMATION_CLERK, USER_ROLES.ADMIN].includes(user.role)) {
        throw createApiError("MACHINE_TRACKING_FORBIDDEN", "只有信息员或管理员可以查询在手机器", 403);
      }
      const keyword = String(req.query?.keyword || "").trim();
      if (!keyword || (!/[A-Za-z]/.test(keyword) && keyword.replace(/\D/g, "").length < 4)) {
        throw createApiError("MACHINE_TRACKING_KEYWORD_INVALID", "请输入电话或完整物流单号", 400);
      }
      res.json({ success: true, data: queryMachinesInHand(await receiptStore.readAll(), keyword).slice(0, 100) });
    } catch (error) { next(error); }
  });

  function assertInformationReportAccess(user) {
    if (![USER_ROLES.INFORMATION_CLERK, USER_ROLES.ADMIN].includes(user.role)) {
      throw createApiError("INFORMATION_REPORT_FORBIDDEN", "只有信息员或管理员可以查看完整维修报告", 403);
    }
  }

  async function informationReportOrder(req) {
    const rmaNo = String(req.params?.rmaNo || "").trim();
    const order = (await receiptStore.readAll()).find((item) => item.rmaNo === rmaNo);
    if (!order) throw createApiError("INFORMATION_REPORT_NOT_FOUND", "未找到对应本地维修工单", 404);
    return order;
  }

  function attachmentSource(category) {
    return category === "receipt" ? receiptAttachmentStore
      : category === "repair" ? attachmentStore
        : category === "shipping" ? shippingAttachmentStore
          : null;
  }

  app.get("/api/information/repair-reports", async (req, res, next) => {
    try {
      assertInformationReportAccess(currentUserProvider(req));
      const keyword = String(req.query?.keyword || "").trim();
      if (keyword.length < 4) throw createApiError("INFORMATION_REPORT_KEYWORD_INVALID", "请输入至少4位电话、物流单号或寄修单号", 400);
      res.json({ success: true, data: searchInformationRepairReports(await receiptStore.readAll(), keyword).slice(0, 100) });
    } catch (error) { next(error); }
  });

  app.get("/api/information/exceptions", async (req, res, next) => {
    try {
      assertInformationReportAccess(currentUserProvider(req));
      const orders = await receiptStore.readAll();
      const stalledAfterMs = Math.max(60 * 60 * 1000, Number(runtimeEnv.INFORMATION_STALLED_AFTER_HOURS || 24) * 60 * 60 * 1000);
      const orderExceptions = await Promise.all(orders.map(async (order) => {
        const missingAttachmentIds = [];
        await Promise.all(reportAttachments(order).map(async (summary) => {
          const original = findAttachment(order, summary.category, summary.id);
          const source = attachmentSource(summary.category);
          if (!original || !source) { missingAttachmentIds.push(summary.id); return; }
          try { await source.read(order.rmaNo, original); }
          catch { missingAttachmentIds.push(summary.id); }
        }));
        return detectOrderExceptions(order, { stalledAfterMs, missingAttachmentIds });
      }));
      const syncExceptions = detectSyncExceptions(await syncService.outbox.readAll());
      res.json({ success: true, data: sortExceptions([...orderExceptions.flat(), ...syncExceptions]).slice(0, 500) });
    } catch (error) { next(error); }
  });

  app.get("/api/information/repair-reports/:rmaNo", async (req, res, next) => {
    try {
      assertInformationReportAccess(currentUserProvider(req));
      res.json({ success: true, data: buildInformationRepairReport(await informationReportOrder(req)) });
    } catch (error) { next(error); }
  });

  app.get("/api/information/repair-reports/:rmaNo/attachments/:category/:attachmentId", async (req, res, next) => {
    try {
      assertInformationReportAccess(currentUserProvider(req));
      const order = await informationReportOrder(req);
      const category = String(req.params.category || "");
      const attachment = findAttachment(order, category, String(req.params.attachmentId || ""));
      const source = attachmentSource(category);
      if (!attachment || !source) throw createApiError("ATTACHMENT_NOT_FOUND", "附件不存在", 404);
      const data = await source.read(order.rmaNo, attachment);
      res.setHeader("Content-Type", attachment.mimeType || "application/octet-stream");
      res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(attachment.name || "attachment")}`);
      res.setHeader("Content-Length", data.length);
      res.end(data);
    } catch (error) { next(error); }
  });

  app.post("/api/recloud-sync/tasks/retry", async (req, res, next) => {
    try {
      const user = currentUserProvider(req);
      if (user.role !== USER_ROLES.ADMIN) throw createApiError("SYNC_TASKS_FORBIDDEN", "只有管理员可以重试瑞云同步任务", 403);
      res.json({ success: true, data: await syncService.retry(String(req.body?.taskId || "").trim()) });
    } catch (error) { next(error); }
  });

  // 保留已有调用方兼容性。
  app.post("/queryRepair", (req, res, next) => {
    req.url = "/api/crm/repairs/query";
    app.handle(req, res, next);
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const loginRequired = error.code === "RECLOUD_LOGIN_REQUIRED";
    const errors = {
      RECLOUD_LOGIN_REQUIRED: {
        status: 502,
        message: "瑞云登录已失效，请重新初始化登录状态",
      },
      RECLOUD_ORDER_NOT_FOUND: {
        status: 404,
        message: "没有查询到对应的瑞云 RMA 寄修单",
      },
      RECLOUD_SCAN_PAGE_UNAVAILABLE: {
        status: 502,
        message: "无法进入瑞云扫码签收页面",
      },
      RECLOUD_LOGISTICS_FILL_FAILED: {
        status: 502,
        message: "瑞云物流单号输入校验失败",
      },
      RECLOUD_SCHEMA_CHANGED: {
        status: 502,
        message: "瑞云页面结构已变化，暂时无法读取工单",
      },
      RECLOUD_QUERY_TIMEOUT: {
        status: 504,
        message: "瑞云工单查询超时，请稍后重试",
      },
      SN_ALREADY_BOUND: {
        status: 409,
        message: "该 SN 已绑定其他未完成工单",
      },
      RECEIPT_PREPARATION_NOT_FOUND: {
        status: 404,
        message: "未找到待签收准备记录",
      },
      REPAIR_SPECIALTY_NOT_CONFIGURED: {
        status: 403,
        message: error.message,
      },
      REPAIR_SPECIALTY_FORBIDDEN: {
        status: 403,
        message: error.message,
      },
      REPAIR_SPECIALTY_REQUIRED: {
        status: 400,
        message: error.message,
      },
      REPAIR_SPECIALTY_MISMATCH: {
        status: 400,
        message: error.message,
      },
      RECEIPT_SN_REQUIRED: {
        status: 400,
        message: error.message,
      },
      RECEIPT_SN_INVALID: {
        status: 400,
        message: error.message,
      },
      RECEIPT_SN_LOOKS_LIKE_LOGISTICS: {
        status: 400,
        message: error.message,
      },
      RECLOUD_RECEIPT_ACTION_NOT_FOUND: {
        status: 502,
        message: "未找到 RMA 明细中的待处理签收操作",
      },
      RECLOUD_RECEIPT_ACTION_AMBIGUOUS: {
        status: 502,
        message: "RMA 明细中存在多个无法安全区分的签收入口",
      },
      RECLOUD_RECEIPT_CONTROL_AMBIGUOUS: {
        status: 502,
        message: "无法唯一确认目标操作单元格中的签收控件",
      },
      RECLOUD_RECEIPT_FIXED_RIGHT_NOT_FOUND: {
        status: 502,
        message: "未找到目标表格的右侧固定操作列",
      },
      RECLOUD_RECEIPT_FIXED_ROW_AMBIGUOUS: {
        status: 502,
        message: "无法唯一映射目标主表行对应的右侧固定列行",
      },
      RECLOUD_RECEIPT_CONTROL_NOT_FOUND: {
        status: 502,
        message: "目标固定操作行中没有找到签收控件",
      },
      RECLOUD_RECEIPT_ENTRY_CLICK_FAILED: {
        status: 502,
        message: "无法安全打开瑞云签收入口",
      },
      RECLOUD_RECEIPT_FORM_NOT_OPENED: {
        status: 502,
        message: "点击瑞云签收入口后未检测到签收表单",
      },
      RECLOUD_RECEIPT_INSPECTION_UNSAFE: {
        status: 403,
        message: "签收表单定位只允许在严格演练模式下执行",
      },
      RECLOUD_RECEIPT_SIMULATION_UNSAFE: {
        status: 403,
        message: "签收填写演练只允许在严格演练模式下执行",
      },
      RECLOUD_RECEIPT_TEST_ORDER_REQUIRED: {
        status: 403,
        message: "仅允许使用后端配置的专用未签收测试工单",
      },
      RECLOUD_RECEIPT_SIMULATION_INVALID: {
        status: 400,
        message: "签收填写演练参数不完整",
      },
      RECLOUD_RECEIPT_SIMULATION_DIRTY_FORM: {
        status: 409,
        message: "测试工单签收表单不是可安全演练的初始状态",
      },
      RECLOUD_RECEIPT_SIMULATION_VALUE_MISMATCH: {
        status: 502,
        message: "瑞云签收表单演练值校验失败",
      },
      RECLOUD_RECEIPT_SIMULATION_CLEANUP_FAILED: {
        status: 502,
        message: "瑞云签收表单演练内容清理失败",
      },
      RECLOUD_UNEXPECTED_WRITE_REQUEST: {
        status: 502,
        message: "演练期间检测并阻止了非预期写请求",
      },
    };
    const mapped = errors[error.code];
    operationalLogger.write("error", { requestId: res.getHeader("X-Request-Id"), method: req.method, path: req.path, code: error.code || "INTERNAL_ERROR", status: mapped?.status || error.status || 502 });
    console.error(
      "CRM request failed:",
      JSON.stringify({
        code: error.code || "RECLOUD_ERROR",
        message: mapped?.message || "瑞云 CRM 请求失败",
        missingFields: Array.isArray(error.missingFields)
          ? error.missingFields
          : [],
      })
    );
    return res.status(mapped?.status || error.status || 502).json({
      success: false,
      code: mapped ? error.code : "RECLOUD_ERROR",
      message: mapped?.message || (
        Number(error.status) >= 400 && Number(error.status) < 500
          ? error.message
          : "线上查询暂时失败，请稍后重试"
      ),
      missingFields: Array.isArray(error.missingFields)
        ? error.missingFields
        : [],
      inspection: error.inspection || undefined,
      simulation: error.simulation || undefined,
      operationDiagnostics: error.operationDiagnostics || undefined,
      operationControlCandidates:
        error.operationControlCandidates || undefined,
      receiptLocator: error.receiptLocator || undefined,
    });
  });

  return app;
}

if (require.main === module) {
  const runtimeConfig = validateRuntimeConfig(process.env);
  const port = runtimeConfig.port;
  const businessStores = createBusinessStores(process.env);
  const supervisionMonitor = new RecloudSupervisionMonitor({
    receiptStore: businessStores.receiptStore,
    supervisionInboxStore: businessStores.supervisionInboxStore,
    intervalMs: monitorInterval(process.env),
    readOrders: () => withRecloud(recloudConnector, (page) => (
      recloudConnector.readRmaSupervisionOrderStatuses(page)
    ), { background: true }),
  });
  const pendingReceiptStore = new PendingReceiptStore();
  const rmaQueryCacheStore = new RmaQueryCacheStore();
  let rmaQueryBackfillRunning = false;
  let rmaQueryBackfillTimer = null;
  const scheduleRmaQueryBackfill = (delayMs = 0) => {
    if (rmaQueryBackfillTimer) clearTimeout(rmaQueryBackfillTimer);
    rmaQueryBackfillTimer = setTimeout(async () => {
      if (rmaQueryBackfillRunning) return;
      rmaQueryBackfillRunning = true;
      try {
        const snapshot = await rmaQueryCacheStore.readSnapshot();
        const existingRmaNos = snapshot.orders
          .filter((order) => /^1[3-9]\d{9}$/.test(String(order.phone || "").trim()))
          .map((order) => order.rmaNo)
          .filter(Boolean);
        const result = await withRecloud(
          recloudConnector,
          (page, queue) => recloudConnector.readRecentRmaOrders(page, {
            dateFrom: process.env.RMA_QUERY_BACKFILL_FROM || recentRmaBackfillStart(3),
            existingRmaNos,
            maxRecords: Number(process.env.RMA_QUERY_CACHE_CAPACITY || 10000),
            maxPages: Number(process.env.RMA_QUERY_BACKFILL_MAX_PAGES || 500),
            phoneRevealTimeout: Number(process.env.RMA_QUERY_BACKFILL_PHONE_TIMEOUT_MS || 8000),
            shouldYield: queue.shouldYield,
            onOrder: async (order) => rmaQueryCacheStore.mergeIncremental([order], {
              activeRmaNos: null,
              syncedAt: new Date().toISOString(),
            }),
            logger: console,
          }),
          { background: true }
        );
        const interrupted = result.pending > result.orders.length;
        console.info(`RECLOUD_RMA_BACKFILL: discovered=${result.discovered} cached=${result.orders.length} interrupted=${interrupted}`);
        scheduleRmaQueryBackfill(interrupted ? 30000 : 6 * 60 * 60 * 1000);
      } catch (error) {
        console.warn(`RECLOUD_RMA_BACKFILL: failed ${error.code || "UNKNOWN"}`);
        scheduleRmaQueryBackfill(60000);
      } finally {
        rmaQueryBackfillRunning = false;
      }
    }, delayMs);
    rmaQueryBackfillTimer.unref?.();
  };
  const pendingReceiptSync = new PendingReceiptSync({
    store: pendingReceiptStore,
    intervalMs: pendingReceiptSyncInterval(process.env),
    readOrders: (context) => withRecloud(
      recloudConnector,
      (page, queue) => recloudConnector.readPendingReceiptOrders(page, {
        ...context,
        shouldYield: queue.shouldYield,
      }),
      { background: true }
    ),
  });
  const app = createApp(recloudConnector, businessStores.receiptStore, {
    businessStores,
    supervisionMonitor,
    pendingReceiptStore,
    rmaQueryCacheStore,
  });
  const tlsOptions = loadTlsOptions(runtimeConfig);
  const server = tlsOptions ? https.createServer(tlsOptions, app) : http.createServer(app);
  server.listen(port, () => {
    console.log(`FieldDesk API 启动成功 http://localhost:${port}`);
    console.log(
      isDryRun()
        ? "安全模式：DRY_RUN=true，禁止最终确认签收"
        : "警告：DRY_RUN=false，允许最终确认签收"
    );
  });
  initializeRecloudSession(recloudConnector).then((session) => {
    if (session && pendingReceiptSyncEnabled(process.env)) {
      pendingReceiptStore.readSnapshot().then(({ syncedAt, orders }) => {
        const lastSyncedAt = Date.parse(syncedAt);
        const cacheExpired = !Number.isFinite(lastSyncedAt)
          || Date.now() - lastSyncedAt >= pendingReceiptSync.intervalMs;
        pendingReceiptSync.start(orders.length === 0 || cacheExpired);
      });
    }
    if (session) scheduleRmaQueryBackfill(5000);
  }).finally(() => {
    // 监测服务必须持续运行；即使启动时瑞云尚未登录，也要定时重试，
    // 登录恢复后即可自动取得并展示真实督办内容。
    if (monitorEnabled(process.env)) supervisionMonitor.start();
  });
  const shutdown = async () => {
    supervisionMonitor.stop();
    pendingReceiptSync.stop();
    if (rmaQueryBackfillTimer) clearTimeout(rmaQueryBackfillTimer);
    server.close();
    await recloudConnector.closeRecloud?.();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

module.exports = {
  createApp,
  normalizeLogisticsNo,
  withRecloud,
  isDryRun,
  isRecloudWriteEnabled,
  initializeRecloudSession,
  monitorEnabled,
  monitorInterval,
  normalizeMaskedPhone,
  getAllowedRepairSpecialties,
  getOutOfWarrantyFeePolicy,
  resolveReceiptSpecialty,
  validateReceiptSn,
};
