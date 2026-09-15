const express = require("express");
const { blocksPartRetry } = require('./services/recloud-part-write-guard');
const { resolveReportedFault, assertReportedFaultForSubmission, createReportedFaultLoader } = require("./services/reported-fault");
const { monthlyStatistics, canExportMonthly, exportMonthly } = require("./shared/monthly-statistics");
const { canViewPayroll, payrollMonth, buildPayroll, exportPayroll } = require("./shared/payroll");
const crypto = require("crypto");
const http = require("http");
const https = require("https");
const path = require("path");
const { resolveUploadDirectory } = require("./config/upload-paths");
if (require.main === module) {
  try {
    process.loadEnvFile?.();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
const recloudConnector = require("./connectors/recloud");
const { classifyRecloudReceiptState } = require("./connectors/recloud-receipt-state");
const { RECLOUD_HOLD_REASON_GROUPS, validateHoldInput } = require("./shared/recloud-hold-reasons");
const { normalizeSn, validateReceiptCompletion } = require("./database/receipt-preparation-store");
const { scheduleBackgroundRetry, scheduleBackgroundWork } = require("./services/safe-background-retry");
const { createBusinessStores } = require("./database/business-store-factory");
const { AccountStore } = require("./database/account-store");
const { WorkCoordinationStore } = require("./database/work-coordination-store");
const { PendingReceiptStore } = require("./database/pending-receipt-store");
const { RmaQueryCacheStore } = require("./database/rma-query-cache-store");
const { validateRuntimeConfig, loadTlsOptions } = require("./config/runtime-config");
const { createRateLimiter, createBusinessRateLimiter, securityHeaders, RotatingJsonLogger, requestLogger } = require("./services/operational-security");
const { LocalRepairAttachmentStore } = require("./database/repair-attachment-store");
const {
  FREIGHT_WAIVER_APPLICATION_SOURCE,
  FREIGHT_WAIVER_TEMPLATE_VERSION,
  buildFreightWaiverApplicationData,
  closeFreightWaiverApplicationRenderer,
  renderFreightWaiverApplicationPng,
} = require("./services/freight-waiver-application");
const { LocalShippingAttachmentStore } = require("./database/shipping-attachment-store");
const { JsonRecloudSyncOutbox } = require("./database/recloud-sync-outbox");
const { PrintJobStore } = require("./database/print-job-store");
const { createRecloudAdapter } = require("./connectors/recloud-adapter");
const { NODE_METHODS, RecloudSyncService } = require("./services/recloud-sync-service");
const { createRecloudCommandExecutor } = require("./services/recloud-command-executor");
const { orchestrateRepairStart } = require("./services/recloud-repair-start-orchestrator");
const { createRecloudRepairPageAdapter } = require("./connectors/recloud-repair-page-adapter");
const { assessRecloudRepairPageReadiness } = require("./services/recloud-repair-page-readiness");
const { JsonRecloudSyncDiagnosticsStore } = require("./database/recloud-sync-diagnostics-store");
const { JsonRecloudRepairCheckpointStore } = require("./database/recloud-repair-checkpoint-store");
const { JsonRecloudFaultCatalogStore } = require("./database/recloud-fault-catalog-store");
const { RecloudSyncDiagnosticsService } = require("./services/recloud-sync-diagnostics-service");
const {
  FeishuModelCatalog,
  getSnProjectMatch,
  projectCodeMatches,
} = require("./connectors/feishu-model-catalog");
const { FeishuPartsCatalog } = require("./connectors/feishu-parts-catalog");
const { evaluateWarranty, resolveConfirmedWarranty } = require("./services/warranty-policy");
const { orderQuery } = require("./services/recloud-order-query");
const localFaultMappings = require("./knowledge/fault_mapping.json").mappings || {};
const { resolvePartsFee, resolveOutOfWarrantyFee, buildPricingPreview } = require("./services/out-of-warranty-pricing");
const { LOGISTICS_CHARGE_MODES, resolveRepairCharge } = require("./services/repair-charge-policy");
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
const {
  RmaQueryIndexSync,
  rmaQueryIndexSyncEnabled,
  rmaQueryIndexSyncInterval,
} = require('./services/rma-query-index-sync');
const { buildInspectionFormDecision, resolveFaultContent } = require("./services/inspection-form-rules");
const { resolveRecloudTechnician } = require("./services/recloud-technician-mapping");
const {
  assessRecloudInspectionControlMapping,
  buildRecloudInspectionFormPlan,
  buildNodePayload,
  MAPPING_VERSION,
} = require("./connectors/recloud-sync-mapping");
const {
  USER_ROLES,
  getLocalCurrentUser,
} = require("./config/local-users");
const { hasBusinessRole, isBusinessRuleExempt } = require("./config/business-access-policy");
const {
  protectPreReceiptFaults,
  restrictFaultVisibilityForUser,
} = require("./services/pre-receipt-fault-visibility");

const SUPPORTED_REPAIR_SPECIALTIES = Object.freeze(["扫地机", "洗地机"]);
const RECLOUD_FAILED_RETRY_COOLDOWN_MS = 5 * 60 * 1000;
const RECLOUD_RECOVERY_SWEEP_INTERVAL_MS = 60 * 1000;
const RECLOUD_RECOVERY_SWEEP_BATCH_SIZE = 2;
const RECLOUD_IDLE_CHANNEL_RELEASE_MS = 10_000;
const RECEIPT_RECOVERY_STATUSES = new Set([
  "RECEIVED_PENDING_INSPECTION",
  "INSPECTION_IN_PROGRESS",
  "INSPECTION_COMPLETED_PENDING_REPAIR",
  "REPAIR_COMPLETION_DRAFT",
]);
const NON_RETRYABLE_DETECTION_ERRORS = new Set([
  "RECLOUD_ACTION_NOT_FOUND",
  "RECLOUD_DETECTION_PAYLOAD_INVALID",
  "RECLOUD_DETECTION_OPTION_AMBIGUOUS",
  "RECLOUD_DETECTION_FIELD_AMBIGUOUS",
]);
const NON_RETRYABLE_RECEIPT_ERRORS = new Set([
  "RECLOUD_PRODUCT_SN_CORRECTION_READ_ONLY",
]);
const ACCOUNT_SESSION_COOKIE = "fielddesk_session";

function resolvePersistedProjectAuthorization(modelAuthorization, currentProjectCode) {
  if (!modelAuthorization?.projectCode || !currentProjectCode) return null;
  return {
    ...modelAuthorization,
    status: projectCodeMatches(currentProjectCode, modelAuthorization.projectCode)
      ? "MATCHED"
      : "CHANGE_REQUIRED",
    currentProjectCode,
  };
}

function readCookie(req, name) {
  const encodedName = `${encodeURIComponent(name)}=`;
  const item = String(req.headers.cookie || "")
    .split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith(encodedName));
  if (!item) return "";
  try { return decodeURIComponent(item.slice(encodedName.length)); }
  catch { return ""; }
}

function getAccountSessionToken(req) {
  const cookieToken = readCookie(req, ACCOUNT_SESSION_COOKIE);
  if (cookieToken) return cookieToken;
  const authorization = String(req.headers.authorization || "");
  if (authorization.startsWith("Bearer ")) return authorization.slice(7);
  return "";
}

function createRecloudRmaWriteGuard(allowlistValues, runtimeStartedAt = Date.now(), strict = false, admissions = null) {
  const allowlist = new Set(Array.from(allowlistValues || []).map((value) => String(value || "").trim()).filter(Boolean));
  return (rmaNo, candidate = {}) => {
    if (strict) return allowlist.has(String(rmaNo || "").trim());
    if (allowlist.size === 0 || allowlist.has(String(rmaNo || "").trim())) return true;
    // Fence historical backlog while retaining persisted live-work admissions.
    // A later restart must not revoke permission already used by normal work.
    const key = require('./services/recloud-write-admissions').admissionKey(rmaNo, candidate);
    if (admissions?.has(key)) return true;
    // Only business events qualify; polling/retry bookkeeping updates updatedAt.
    const events = [candidate.createdAt, candidate.receiptCompletedAt, candidate.inspectionUpdatedAt,
      candidate.treatmentDecidedAt, candidate.hold?.requestedAt,
      candidate.repairCompletion?.submittedAt, candidate.manualRecoveryRequestedAt];
    const live = events.some(value => Number.isFinite(Date.parse(value)) && Date.parse(value) >= runtimeStartedAt);
    if (!live) return false;
    return admissions ? admissions.grant(key) : true;
  };
}

async function readReceiptDetailWithReuse(connector, page, order, options = {}) {
  const expectedRmaNo = String(order?.rmaNo || "").trim();
  const logisticsNo = String(order?.logisticsNo || "").trim();
  const attempts = Math.max(1, Number(options.reuseAttempts || 8));
  const pollMs = Math.max(0, Number(options.pollMs || 250));
  if (typeof connector.readRmaDetail === "function") {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const detail = await connector.readRmaDetail(page, logisticsNo, {
          fastDomRead: true,
          requirePickupLogisticsNo: false,
        });
        const actualRmaNo = String(detail?.rmaNo || "").trim();
        if (actualRmaNo && actualRmaNo !== expectedRmaNo) {
          throw createApiError(
            "RECLOUD_RECEIPT_ORDER_MISMATCH",
            "瑞云当前页面与待同步寄修单不一致",
            409
          );
        }
        if (actualRmaNo === expectedRmaNo) return detail;
      } catch (error) {
        if (error.code === "RECLOUD_RECEIPT_ORDER_MISMATCH") throw error;
      }
      if (attempt + 1 < attempts) await page.waitForTimeout?.(pollMs);
    }
  }
  return connector.queryRmaByLogisticsNo(page, logisticsNo, { preserveDetailPage: true });
}

async function readReceiptProjectIdentityWithRetry(connector, page, order, seed = {}, options = {}) {
  const attempts = Math.max(1, Number(options.attempts || 6));
  const pollMs = Math.max(0, Number(options.pollMs || 500));
  let detail = seed.detail || {};
  let productIdentity = seed.productIdentity || null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const refreshedProjectCode = String(detail?.projectCode || productIdentity?.projectCode || "").trim();
    if (refreshedProjectCode) {
      return { detail, productIdentity, projectCode: refreshedProjectCode };
    }
    if (attempt > 0 || !seed.detail) {
      detail = await readReceiptDetailWithReuse(connector, page, order, {
        reuseAttempts: 2,
        pollMs,
      });
    }
    if (typeof connector.readRmaProductIdentity === "function") {
      productIdentity = await connector.readRmaProductIdentity(page, {
        sn: order.sn,
        logisticsNo: order.logisticsNo,
        productLine: detail.productLine || detail.productType || order.productLine,
      }).catch(() => null);
    }
    const productSn = String(productIdentity?.sn || "").trim().toUpperCase();
    if (productSn && productSn !== String(order.sn || "").trim().toUpperCase()) {
      throw createApiError(
        "RECLOUD_PRODUCT_SN_MISMATCH",
        "瑞云产品序列号与 FieldDesk 扫描 SN 不一致，已停止后台操作",
        409
      );
    }
    const projectCode = String(detail?.projectCode || productIdentity?.projectCode || "").trim();
    if (projectCode) return { detail, productIdentity, projectCode };
    if (attempt + 1 < attempts) await page.waitForTimeout?.(pollMs);
  }
  return { detail, productIdentity, projectCode: "" };
}

async function isExpectedRmaStillOpen(page, rmaNo) {
  const expected = String(rmaNo || "").trim().toUpperCase();
  if (!expected || typeof page?.locator !== "function") return false;
  const bodyText = String(await page.locator("body").innerText({ timeout: 3000 }).catch(() => "")).toUpperCase();
  return bodyText.includes(expected);
}

function accountSessionCookie(token, maxAgeSeconds, secure = false) {
  const parts = [
    `${ACCOUNT_SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

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

function formatFeeAmount(value) {
  return String(Number(Number(value || 0).toFixed(2)));
}

function abandonedReturnPricing({ partsFee = 0, repairFee = 0, oneWayLogisticsFee = 0, logisticsChargeMode = "ROUND_TRIP", highestLevel = "无配件", canPrice = true, outOfWarrantyReliefEnabled = false } = {}) {
  const normalizedPartsFee = Number(partsFee || 0);
  const normalizedRepairFee = Number(repairFee || 0);
  const normalizedOneWayLogisticsFee = logisticsChargeMode === "WALK_IN" ? 0 : Number(oneWayLogisticsFee || 0);
  const mode = LOGISTICS_CHARGE_MODES[logisticsChargeMode];
  if (!mode || logisticsChargeMode === "WAIVED") {
    const error = new Error("弃修免运费申请请选择收取往返运费或只收单边运费");
    error.code = "LOGISTICS_CHARGE_MODE_INVALID";
    throw error;
  }
  const quotedLogisticsFee = Number((normalizedOneWayLogisticsFee * mode.multiplier).toFixed(2));
  const quotedTotalFee = Number((normalizedPartsFee + normalizedRepairFee + quotedLogisticsFee).toFixed(2));
  return {
    status: "OUT_OF_WARRANTY",
    canPrice,
    highestLevel,
    partsFee: normalizedPartsFee,
    fee: normalizedRepairFee,
    logisticsChargeMode,
    logisticsChargeLabel: mode.label,
    oneWayLogisticsFee: normalizedOneWayLogisticsFee,
    quotedLogisticsFee,
    logisticsFee: outOfWarrantyReliefEnabled ? 0 : quotedLogisticsFee,
    logisticsMultiplier: mode.multiplier,
    subtotal: Number((normalizedPartsFee + normalizedRepairFee).toFixed(2)),
    quotedTotalFee,
    totalFee: outOfWarrantyReliefEnabled ? 0 : quotedLogisticsFee,
    outOfWarrantyReliefEnabled,
    discountEnabled: false,
    discountScope: "ORDER_TOTAL",
    discountRate: 10,
    discountAmount: 0,
    primaryRemark: outOfWarrantyReliefEnabled && logisticsChargeMode !== "WALK_IN" ? "申请运费减免" : "无减免",
    secondaryRemark: `配件费${formatFeeAmount(normalizedPartsFee)}元，维修费${formatFeeAmount(normalizedRepairFee)}元，运费${formatFeeAmount(quotedLogisticsFee)}元，合计${formatFeeAmount(quotedTotalFee)}元，用户放弃维修${logisticsChargeMode === "WALK_IN" ? "" : outOfWarrantyReliefEnabled ? "，免运费寄回" : `，仅收运费${formatFeeAmount(quotedLogisticsFee)}元`}`,
    logisticsSource: outOfWarrantyReliefEnabled ? "ABANDONED_RETURN_WAIVER" : "ABANDONED_RETURN",
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

function recentRmaIndexStart(dayCount = 7, now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, Number(value)]));
  const start = new Date(Date.UTC(values.year, values.month - 1, values.day - Math.max(1, dayCount) + 1));
  return `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}-${String(start.getUTCDate()).padStart(2, "0")}T00:00:00+08:00`;
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

function isRecloudCompletionWriteEnabled(env = process.env) {
  return String(env.RECLOUD_COMPLETION_WRITE_ENABLED ?? "false").toLowerCase() === "true";
}

function isRecloudReceiptWriteEnabled(env = process.env) {
  const receiptOverride = env.RECLOUD_RECEIPT_WRITE_ENABLED;
  if (receiptOverride !== undefined) {
    return String(receiptOverride).toLowerCase() === "true";
  }
  return !isDryRun(env) && isRecloudWriteEnabled(env);
}

function isRecloudInspectionWriteEnabled(env = process.env) {
  const inspectionOverride = env.RECLOUD_INSPECTION_WRITE_ENABLED;
  if (inspectionOverride !== undefined) {
    return String(inspectionOverride).toLowerCase() === "true";
  }
  return !isDryRun(env) && isRecloudWriteEnabled(env);
}

function isRecloudHoldWriteEnabled(env = process.env) {
  const holdOverride = env.RECLOUD_HOLD_WRITE_ENABLED;
  if (holdOverride !== undefined) {
    return String(holdOverride).toLowerCase() === "true";
  }
  return !isDryRun(env) && isRecloudWriteEnabled(env);
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

function technicianWorkloadOrder(order = {}) {
  return {
    rmaNo: order.rmaNo || "",
    logisticsNo: order.logisticsNo || "",
    phoneMasked: order.phoneMasked || normalizeMaskedPhone(order.phone) || "",
    productLine: order.productLine || "",
    specialty: order.specialty || "",
    sn: order.sn || "",
    status: order.status || "",
    receiptCompletedAt: order.receiptCompletedAt || "",
    technicianId: order.technicianId || order.operatorId || "",
    technicianName: order.technicianName || order.operatorName || "",
    operatorId: order.operatorId || "",
    operatorName: order.operatorName || "",
    technicianWarranty: order.technicianWarranty || "",
    treatmentMode: order.treatmentMode || "",
    treatmentLabel: order.treatmentLabel || "",
    resumeStep: order.resumeStep || "",
    recentTimeline: (order.timeline || []).slice(-20).map(event => ({ id: event.id, label: event.label, at: event.at, operatorName: event.operatorName })),
    hold: order.hold ? {
      category: order.hold.category || "",
      reason: order.hold.reason || "",
      remark: order.hold.remark || "",
      status: order.hold.status || "",
    } : null,
    repairCompletion: order.repairCompletion ? {
      submittedAt: order.repairCompletion.submittedAt || "",
      repairMeasure: order.repairCompletion.repairMeasure || "",
      speechTemplate: order.repairCompletion.speechTemplate || "",
    } : null,
    completedAt: order.completedAt || "",
    createdAt: order.createdAt || "",
  };
}

function getAllowedRepairSpecialties(user) {
  if (isBusinessRuleExempt(user) || user?.role === USER_ROLES.ADMIN) {
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

  if (recognizedProduct) return recognizedProduct;
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

async function executeRecloudOperation(connector, operation, options, coordinator, channel) {
  if (options.deadlineAt) {
    let expired = false;
    let page;
    let deadlineTimer;
    const work = Promise.resolve().then(async () => {
      const session = await connector.openRecloud({ channel });
      page = session.page;
      if (expired) {
        Promise.resolve(page?.close?.()).catch(() => {});
        return;
      }
      if (session.loginRequired) {
        const error = new Error("请重新初始化瑞云登录状态");
        error.code = "RECLOUD_LOGIN_REQUIRED";
        throw error;
      }
      return operation(page, { shouldYield: () => false });
    });
    const deadline = new Promise((_, reject) => {
      deadlineTimer = setTimeout(() => {
        expired = true;
        // Closing a stalled browser must not postpone the HTTP response.
        Promise.resolve().then(() => page?.close?.()).catch(() => {});
        const error = new Error("瑞云在线查询未能在限定时间内完成，请稍后重试");
        error.code = "RECLOUD_QUERY_TIMEOUT";
        error.status = 504;
        error.recloudDrainPromise = work.catch(() => {});
        reject(error);
      }, Math.max(0, options.deadlineAt - Date.now()));
    });
    try {
      return await Promise.race([work, deadline]);
    } finally {
      clearTimeout(deadlineTimer);
      connector.releaseRecloudChannel?.(channel, { idleMs: 30000 });
    }
  }
  let session;
  let timer;
  let expired = false;
  let operationStarted = false;
  const closePage = () => Promise.resolve().then(() => session?.page?.close?.()).catch(() => {});
  try {
    const operationPromise = Promise.resolve().then(async () => {
      session = await connector.openRecloud({ channel });
      if (expired) {
        void closePage();
        return;
      }
      if (session.loginRequired) {
        const error = new Error("请重新初始化瑞云登录状态");
        error.code = "RECLOUD_LOGIN_REQUIRED";
        throw error;
      }
      operationStarted = true;
      return operation(session.page, {
        shouldYield: () => options.background === true && coordinator.foregroundWaiting > 0,
        isExpired: () => expired,
      });
    });
    const timeoutMs = Number(options.timeoutMs || 0);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return await operationPromise;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        // Closing can itself hang. Reject on time and retire this channel;
        // a late open is closed above without invoking the business operation.
        void closePage();
        const error = new Error(`瑞云操作超过 ${timeoutMs}ms，已隔离当前通道`);
        error.code = options.timeoutCode || "RECLOUD_OPERATION_TIMEOUT";
        error.status = 504;
        error.resultUnknown = operationStarted && (typeof options.resultUnknownOnTimeout === "function"
          ? options.resultUnknownOnTimeout() === true : options.resultUnknownOnTimeout === true);
        // The caller is released now. The pool retires this channel and uses
        // a new channel identity; it never assigns another order to this page.
        error.recloudDrainPromise = operationPromise.catch(() => {});
        reject(error);
      }, timeoutMs);
      timer.unref?.();
    });
    return await Promise.race([operationPromise, timeoutPromise]);
  } finally {
    clearTimeout(timer);
    const idleReleaseMs = options.idleReleaseMs === undefined
      ? recloudIdleChannelReleaseMs(process.env)
      : Number(options.idleReleaseMs);
    if (Number.isFinite(idleReleaseMs) && idleReleaseMs >= 1_000) {
      connector.releaseRecloudChannel?.(channel, {
        idleMs: idleReleaseMs,
      });
    }
  }
}

function runRecloudPool(coordinator, connector, operation, options, requestedChannel) {
  const size = Math.max(1, Math.min(5, Math.floor(Number(options.concurrency || 1)) || 1));
  const poolKey = `${requestedChannel}:${size}`;
  let pool = coordinator.pools.get(poolKey);
  if (!pool) {
    pool = {
      waiting: [],
      nextSequence: 0,
      nextWorkerId: size,
      workers: Array.from({ length: size }, (_, index) => ({
        busy: false,
        retired: false,
        channel: `${requestedChannel}:${index + 1}`,
      })),
    };
    coordinator.pools.set(poolKey, pool);
  }
  return new Promise((resolve, reject) => {
    const job = {
      operation,
      options,
      resolve,
      reject,
      priority: Number(options.queuePriority || 0),
      sequence: pool.nextSequence++,
      queuedAt: Date.now(),
    };
    pool.waiting.push(job);
    if (options.deadlineAt) {
      job.queueTimer = setTimeout(() => {
        const index = pool.waiting.indexOf(job);
        if (index < 0) return;
        pool.waiting.splice(index, 1);
        const error = new Error("瑞云查询繁忙，请稍后重试");
        error.code = "RECLOUD_QUERY_BUSY";
        error.status = 503;
        reject(error);
      }, Math.max(0, options.deadlineAt - Date.now()));
    }
    pool.waiting.sort((left, right) => (
      right.priority - left.priority || left.sequence - right.sequence
    ));
    const dispatch = () => {
      while (pool.waiting.length > 0) {
        const worker = require('./services/recloud-idle-worker').chooseIdleRecloudWorker(pool.workers, pool.waiting[0].options.affinityKey);
        if (!worker) break;
        const job = pool.waiting.shift();
        clearTimeout(job.queueTimer);
        worker.busy = true;
        worker.affinityKey = job.options.affinityKey || '';
        const startedAt = Date.now();
        console.info('RECLOUD_QUEUE_TIMING', JSON.stringify({ channel: requestedChannel,
          job: job.sequence, phase: 'started', queueMs: startedAt - job.queuedAt, waiting: pool.waiting.length }));
        const current = executeRecloudOperation(
          connector,
          job.operation,
          job.options,
          coordinator,
          worker.channel
        );
        current.then(value => {
          console.info('RECLOUD_QUEUE_TIMING', JSON.stringify({ channel: requestedChannel,
            job: job.sequence, phase: 'completed', executionMs: Date.now() - startedAt }));
          job.resolve(value);
        }, error => {
          console.info('RECLOUD_QUEUE_TIMING', JSON.stringify({ channel: requestedChannel,
            job: job.sequence, phase: 'failed', executionMs: Date.now() - startedAt, code: error.code || 'UNKNOWN' }));
          job.reject(error);
        });
        current.catch((error) => {
          if (error.recloudDrainPromise) {
            // The timed-out page has already been closed. Retire this channel
            // immediately and create a fresh one so an uncooperative stale
            // promise cannot permanently consume one of the fixed write lanes.
            worker.retired = true;
            const retiredIndex = pool.workers.indexOf(worker);
            if (retiredIndex >= 0) pool.workers.splice(retiredIndex, 1);
            pool.nextWorkerId += 1;
            pool.workers.push({
              busy: false,
              retired: false,
              channel: `${requestedChannel}:${pool.nextWorkerId}`,
            });
            // Do not retain an ever-growing list of retired workers while
            // their uncooperative promises may never settle.
          }
        }).finally(() => {
          if (!worker.retired) worker.busy = false;
          dispatch();
        });
      }
    };
    dispatch();
  });
}

async function withRecloud(connector, operation, options = {}) {
  if (options.totalTimeoutMs) options = { ...options, deadlineAt: Date.now() + options.totalTimeoutMs };
  let coordinator = withRecloud.queues.get(connector);
  if (!coordinator) {
    coordinator = { channels: new Map(), pools: new Map(), foregroundWaiting: 0 };
    withRecloud.queues.set(connector, coordinator);
  }
  const foreground = options.background !== true;
  const priority = foreground || options.priority === true;
  const channel = String(options.channel || (foreground ? "foreground" : "background"));
  if (priority) coordinator.foregroundWaiting += 1;
  if (Number(options.concurrency || 1) > 1) {
    return await runRecloudPool(coordinator, connector, operation, options, channel)
      .finally(() => {
        coordinator.foregroundWaiting = Math.max(0, coordinator.foregroundWaiting - 1);
      });
  }
  let state = coordinator.channels.get(channel);
  if (!state) {
    state = { tail: Promise.resolve() };
    coordinator.channels.set(channel, state);
  }
  const previous = state.tail;
  const current = previous.catch(() => {}).then(() => (
    executeRecloudOperation(connector, operation, options, coordinator, channel)
  )).finally(() => {
    if (priority) coordinator.foregroundWaiting = Math.max(0, coordinator.foregroundWaiting - 1);
  });
  state.tail = current.catch(async (error) => {
    if (error.recloudDrainPromise) await error.recloudDrainPromise;
  });
  return current;
}
withRecloud.queues = new WeakMap();

function recloudBusinessWriteTimeoutMs(env = process.env) {
  const configured = Number(env.RECLOUD_BUSINESS_WRITE_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 240000;
}

function recloudBusinessWriteConcurrency(env = process.env) {
  const configured = Number(env.RECLOUD_BUSINESS_WRITE_CONCURRENCY);
  return Number.isFinite(configured) && configured > 0
    ? Math.min(5, Math.floor(configured))
    : 5;
}

function recloudIdleChannelReleaseMs(env = process.env) {
  const configured = Number(env.RECLOUD_IDLE_CHANNEL_RELEASE_MS);
  return Number.isFinite(configured) && configured >= 1_000
    ? Math.floor(configured)
    : RECLOUD_IDLE_CHANNEL_RELEASE_MS;
}

function timestampAgeMs(value, now = Date.now()) {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? Math.max(0, now - timestamp) : Infinity;
}

function shouldAutoResumeReceipt(order, now = Date.now()) {
  if (!order?.receiptCompletedAt || !RECEIPT_RECOVERY_STATUSES.has(order.status)) return false;
  if (require('./services/receipt-attachment-recovery').canRecoverAttachments(order, now)) return true;
  if ([order.recloudReceiptSyncStatus, order.recloudReceiptAttachmentSyncStatus,
    order.recloudProjectVerificationStatus].includes("RESULT_UNKNOWN")) return false;
  const missingDependency = !order.recloudReceiptConfirmedAt
    || !order.recloudProjectVerificationConfirmedAt
    || ((order.receiptAttachments || []).length > 0 && !order.recloudReceiptAttachmentConfirmedAt);
  if (!missingDependency) return false;
  const latestErrorCode = order.recloudReceiptAttachmentLastError?.code
    || order.recloudProjectVerificationLastError?.code
    || order.recloudReceiptLastError?.code;
  if (NON_RETRYABLE_RECEIPT_ERRORS.has(latestErrorCode)) return false;
  const latestErrorTimestamp = [
    order.recloudReceiptAttachmentLastError?.at,
    order.recloudProjectVerificationLastError?.at,
    order.recloudReceiptLastError?.at,
  ].map((value) => Date.parse(String(value || "")))
    .filter(Number.isFinite)
    .sort((left, right) => right - left)[0];
  return !latestErrorTimestamp
    || now - latestErrorTimestamp >= RECLOUD_FAILED_RETRY_COOLDOWN_MS;
}

function shouldAutoResumeDetection(order, now = Date.now(), confirmedRecovery = false) {
  if (order?.recloudDetectionSubmissionStartedAt && !order.recloudDetectionConfirmedAt) return false;
  const authorization = order?.faultCategoryCodeAuthorization;
  const orderCodeAuthorized = Boolean(order?.rmaNo && authorization?.rmaNo === order.rmaNo
    && authorization?.path === order.faultCategory && authorization?.confirmedAt
    && Array.isArray(authorization?.codes) && authorization.codes.includes(order.faultCategoryCode));
  const codeRecovery = (confirmedRecovery || orderCodeAuthorized) && Boolean(order?.faultCategoryCode)
    && order?.recloudDetectionLastError?.code === "RECLOUD_DETECTION_OPTION_AMBIGUOUS";
  // Local completion can precede the receipt uploads and remote detection.
  // Resume missing prerequisites without rolling back the local repair result.
  if (!["INSPECTION_COMPLETED_PENDING_REPAIR", "REPAIR_COMPLETION_DRAFT",
    "REPAIR_COMPLETED_PENDING_SHIPMENT"].includes(order?.status)) return false;
  if (!order.inspectionUpdatedAt || order.recloudDetectionConfirmedAt) return false;
  const status = String(order.recloudDetectionSyncStatus || "");
  if (status === "PENDING") return true;
  if (status === "SYNCING") {
    return timestampAgeMs(order.recloudDetectionAttemptedAt, now) >= 120_000;
  }
  if (status !== "FAILED") return false;
  if (!codeRecovery && NON_RETRYABLE_DETECTION_ERRORS.has(order.recloudDetectionLastError?.code)) return false;
  return timestampAgeMs(
    order.recloudDetectionLastError?.at || order.recloudDetectionAttemptedAt,
    now
  ) >= RECLOUD_FAILED_RETRY_COOLDOWN_MS;
}

function shouldAutoResumeServiceOrder(order, now = Date.now()) {
  if (blocksPartRetry(order?.recloudRepairPreparation?.lastError?.code)) return false;
  if (!order?.recloudDetectionConfirmedAt) return false;
  if (!["INSPECTION_COMPLETED_PENDING_REPAIR", "REPAIR_COMPLETION_DRAFT",
    "REPAIR_COMPLETED_PENDING_SHIPMENT"].includes(order.status)) return false;
  if (order.recloudServiceOrderSyncStatus === "RESULT_UNKNOWN") return false;
  const preparationStatus = String(order.recloudRepairPreparation?.status || "");
  const needsCreation = !order.recloudServiceOrderCreatedAt
    && preparationStatus === "PENDING";
  const needsPreparationRecovery = Boolean(
    order.recloudServiceOrderCreatedAt
    && order.recloudServiceOrderNo
    && preparationStatus === "FAILED"
  );
  if (!needsCreation && !needsPreparationRecovery) return false;
  const status = String(order.recloudServiceOrderSyncStatus || "");
  if (status === "SYNCING") {
    return timestampAgeMs(order.recloudServiceOrderAttemptedAt, now) >= 300_000;
  }
  const lastFailureAt = order.recloudRepairPreparation?.failedAt
    || order.recloudServiceOrderLastError?.at
    || order.recloudServiceOrderAttemptedAt;
  return !lastFailureAt || timestampAgeMs(lastFailureAt, now) >= RECLOUD_FAILED_RETRY_COOLDOWN_MS;
}

function recloudRecoverySweepIntervalMs(env = process.env) {
  const configured = Number(env.RECLOUD_RECOVERY_SWEEP_INTERVAL_MS);
  return Number.isFinite(configured) && configured >= 10_000
    ? Math.floor(configured)
    : RECLOUD_RECOVERY_SWEEP_INTERVAL_MS;
}

function recloudRecoverySweepBatchSize(env = process.env) {
  const configured = Number(env.RECLOUD_RECOVERY_SWEEP_BATCH_SIZE);
  return Number.isFinite(configured) && configured > 0
    ? Math.min(20, Math.floor(configured))
    : RECLOUD_RECOVERY_SWEEP_BATCH_SIZE;
}

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
  const businessWriteOptions = {
    background: true,
    channel: "business-write",
    priority: true,
    queuePriority: 100,
    concurrency: recloudBusinessWriteConcurrency(runtimeEnv),
    timeoutMs: recloudBusinessWriteTimeoutMs(runtimeEnv),
    idleReleaseMs: recloudIdleChannelReleaseMs(runtimeEnv),
    resultUnknownOnTimeout: true,
  };
  const foregroundQueryOptions = {
    channel: "foreground-query",
    concurrency: 4,
    totalTimeoutMs: 60000,
    timeoutCode: "RECLOUD_QUERY_TIMEOUT",
    resultUnknownOnTimeout: false,
  };
  const businessStores = options.businessStores || createBusinessStores(runtimeEnv);
  const recloudWriteRmaAllowlist = new Set(
    String(runtimeEnv.RECLOUD_WRITE_RMA_ALLOWLIST || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
  const isRecloudRmaWriteAllowed = createRecloudRmaWriteGuard(
    recloudWriteRmaAllowlist,
    Date.now(),
    runtimeEnv.RECLOUD_WRITE_RMA_STRICT === "true",
    options.recloudWriteAdmissions || null
  );
  receiptStore ||= businessStores.receiptStore;
  const { ReturnLogisticsService } = require('./services/return-logistics-service');
  const { readReturnLogistics } = require('./connectors/recloud-return-logistics');
  const returnLogistics = options.returnLogisticsService || new ReturnLogisticsService(
    path.join(runtimeEnv.FIELDDESK_DATA_DIRECTORY || path.dirname(receiptStore.filePath || path.join(__dirname, 'database/data/receipt-preparations.json')), 'return-logistics.json'),
    (order, queryOptions) => withRecloud(connector, page => readReturnLogistics(page, order, queryOptions), {
      channel: 'return-logistics-read', background: true, timeoutMs: 90000, totalTimeoutMs: 120000,
      resultUnknownOnTimeout: false,
    })
  );
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
  const uploadDirectory = resolveUploadDirectory(runtimeEnv);
  const attachmentStore = options.attachmentStore || new LocalRepairAttachmentStore(path.join(uploadDirectory, "repairs"));
  const freightWaiverApplicationGenerator = options.freightWaiverApplicationGenerator || (async (input) => {
    const applicationData = buildFreightWaiverApplicationData(input);
    return {
      applicationData,
      buffer: await renderFreightWaiverApplicationPng(applicationData),
    };
  });
  const receiptAttachmentStore = options.receiptAttachmentStore || new LocalRepairAttachmentStore(
    path.join(uploadDirectory, "receipts"),
    { allowedMimeTypes: Object.keys(require("./shared/media-formats.json").types).filter(type => /^(image|video)\//.test(type)) }
  );
  const shippingAttachmentStore = options.shippingAttachmentStore || new LocalShippingAttachmentStore(path.join(uploadDirectory, "shipments"));
  const printJobStore = options.printJobStore || new PrintJobStore(options.printJobStoreOptions);
  const syncDiagnostics = options.syncDiagnostics || new RecloudSyncDiagnosticsService(
    options.syncDiagnosticsStore || new JsonRecloudSyncDiagnosticsStore()
  );
  const recloudCommandExecutor = options.recloudCommandExecutor || (
    options.recloudRepairAdapterProvider
      ? createRecloudCommandExecutor({
          repairAdapterProvider: options.recloudRepairAdapterProvider,
          checkpointStore: options.recloudRepairCheckpointStore || new JsonRecloudRepairCheckpointStore(),
          writeEnabled: isRecloudCompletionWriteEnabled(runtimeEnv) || (!isDryRun(runtimeEnv) && isRecloudWriteEnabled(runtimeEnv)),
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
    }),
    {
      taskFilter: (task) => isRecloudRmaWriteAllowed(task?.rmaNo, task),
      onRepairPartsShortage: async (task, result) => {
        await receiptStore.markPartsShortagePending?.(task.rmaNo, result.missingParts || [], {
          userId: "SYSTEM",
          displayName: "FieldDesk 后台",
        });
      },
      onInspectionOnlyAwaitingInformation: async (task, result) => {
        await receiptStore.markInspectionOnlyAwaitingInformation?.(task.rmaNo, result, {
          userId: "SYSTEM",
          displayName: "FieldDesk 后台",
        });
      },
      onRepairReviewConfirmed: async (task) => {
        await receiptStore.markRepairReviewConfirmed?.(task.rmaNo);
      },
      refreshTaskPayload: async (task) => {
        const order = (await receiptStore.readAll()).find((item) => item.rmaNo === task.rmaNo);
        return order ? { payload: buildNodePayload(order, task.nodeType), mappingVersion: MAPPING_VERSION } : null;
      },
      canProcessTask: async (task) => {
        if (task.nodeType !== "REPAIR_COMPLETED") return true;
        const order = (await receiptStore.readAll()).find((item) => item.rmaNo === task.rmaNo);
        if (!order || !["REPAIR", "DEBUGGING", "ABANDONED", "INSPECTION_ONLY"].includes(order.treatmentMode)) return true;
        const preparationStatus = String(order.recloudRepairPreparation?.status || "NOT_STARTED");
        return preparationStatus === "CONFIRMED"
          || preparationStatus === "PARTS_SHORTAGE";
      },
      staleProcessingMs: recloudBusinessWriteTimeoutMs(runtimeEnv) + 60_000,
    }
  );
  if (typeof syncService.resumePendingTasks === "function") {
    syncService.resumePendingTasks({
      maxTasks: recloudRecoverySweepBatchSize(runtimeEnv),
    }).catch((error) => {
      console.error(`RECLOUD_SYNC_RESUME: failed ${error.code || "UNKNOWN"}`);
    });
  }
  const feishuModelCatalog = options.feishuModelCatalog || new FeishuModelCatalog({ env: runtimeEnv });
  const feishuPartsCatalog = options.feishuPartsCatalog || new FeishuPartsCatalog({ env: runtimeEnv });
  const faultCatalogStore = options.faultCatalogStore || new JsonRecloudFaultCatalogStore(options.faultCatalogFile);
  const supervisionMonitor = options.supervisionMonitor || null;
  const supervisionInboxStore = options.supervisionInboxStore || businessStores.supervisionInboxStore;
  const app = express();
  const operationalLogger = options.operationalLogger || new RotatingJsonLogger({ directory: runtimeEnv.LOG_DIRECTORY, maxBytes: runtimeEnv.LOG_MAX_BYTES, retention: runtimeEnv.LOG_RETENTION_FILES });
  app.set("trust proxy", runtimeConfig.trustProxy);
  // Attachments are sent one file per request as base64. A 100MB binary file
  // expands to roughly 134MB in JSON, so leave enough headroom for the body.
  app.use(securityHeaders);
  app.use(requestLogger(operationalLogger));
  // Admission must happen before JSON/base64 allocation, not inside save().
  app.use(require("./services/upload-admission").createUploadAdmission({
    concurrency: runtimeEnv.UPLOAD_CONCURRENCY,
    maxQueue: runtimeEnv.UPLOAD_QUEUE_LIMIT,
    waitMs: runtimeEnv.UPLOAD_QUEUE_WAIT_MS,
  }));
  app.use(express.json({ limit: runtimeEnv.REQUEST_BODY_LIMIT || "140mb" }));
  // Log rejections and protect login separately from business traffic.
  app.use("/api/auth/login", createRateLimiter({ windowMs: 15 * 60_000, limit: 600, code: "LOGIN_RATE_LIMITED" }));
  app.use("/api/auth/login", createRateLimiter({
    windowMs: 15 * 60_000,
    limit: Number(runtimeEnv.LOGIN_RATE_LIMIT_PER_15_MINUTES || 10),
    code: "LOGIN_RATE_LIMITED",
    keyGenerator: req => `${req.ip}:${crypto.createHash("sha256").update(String(req.body?.userId || "").trim()).digest("hex")}`,
  }));
  const failedAuthLimiter = createRateLimiter();

  const accountSessionMs = Math.min(8760, Math.max(1, Number(runtimeEnv.FIELDDESK_SESSION_HOURS || 720))) * 3600_000;

  app.use((req, res, next) => {
    const origin = String(req.headers.origin || "");
    if (origin && !runtimeConfig.frontendOrigins.includes(origin)) return res.status(403).json({ success: false, code: "CORS_ORIGIN_DENIED", message: "来源不受信任" });
    if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
    if (origin) res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,Idempotency-Key,X-FieldDesk-Local-User,X-Print-Terminal-Id,X-Print-Terminal-Token");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  app.post("/api/auth/login", async (req, res, next) => {
    try {
      if (String(runtimeEnv.FIELDDESK_AUTH_MODE || "local") === "accounts") {
        await accountStore.ensureBootstrap(runtimeEnv.FIELDDESK_BOOTSTRAP_ADMIN_TOKEN);
      }
      const user = await accountStore.findByCredentials(req.body?.userId, req.body?.password);
      if (!user) return res.status(401).json({ success: false, code: "AUTH_INVALID_CREDENTIALS", message: "账号或密码错误，或账号已停用" });
      const sessionToken = crypto.randomBytes(32).toString("base64url");
      const expiresAt = Date.now() + accountSessionMs;
      await accountStore.createSession(sessionToken, user.userId, expiresAt);
      res.setHeader("Set-Cookie", accountSessionCookie(
        sessionToken,
        accountSessionMs / 1000,
        runtimeConfig.production || runtimeConfig.tls.enabled
      ));
      res.json({ success: true, data: {
        userId: user.userId,
        displayName: user.displayName,
        role: user.role,
        repairSpecialties: getAllowedRepairSpecialties(user),
        recloudAssignmentMode: user.recloudAssignmentMode || "DIRECT",
        recloudAssigneeName: user.recloudAssigneeName || "",
        recloudFallbackAssigneeName: user.recloudFallbackAssigneeName || "",
        mustChangePassword: user.mustChangePassword === true,
        accountAuthority: user.accountAuthority || "",
      } });
    } catch (error) { next(error); }
  });

  app.post("/api/auth/logout", async (req, res, next) => {
    try {
      const token = getAccountSessionToken(req);
      await accountStore.revokeSession(token);
      res.setHeader("Set-Cookie", accountSessionCookie("", 0, runtimeConfig.production || runtimeConfig.tls.enabled));
      res.json({ success: true, data: { loggedOut: true } });
    } catch (error) { next(error); }
  });

  app.use(async (req, res, next) => {
    if (String(runtimeEnv.FIELDDESK_AUTH_MODE || "local") !== "accounts") return next();
    if (req.path === "/api/health" || req.path.startsWith("/api/print-agent/")) return next();
    try {
      await accountStore.ensureBootstrap(runtimeEnv.FIELDDESK_BOOTSTRAP_ADMIN_TOKEN);
      const token = getAccountSessionToken(req);
      const session = await accountStore.findSession(token);
      const user = session ? await accountStore.findByUserId(session.userId) : await accountStore.findByToken(token);
      if (!user) return failedAuthLimiter(req, res, () => res.status(401).json({ success: false, code: "AUTH_REQUIRED", message: "账号认证失败" }));
      if (session && user.mustChangePassword === true && req.path !== "/api/auth/change-password") {
        return res.status(403).json({ success: false, code: "PASSWORD_CHANGE_REQUIRED", message: "请先修改初始密码" });
      }
      req.fieldDeskUser = user;
      next();
    } catch (error) { next(error); }
  });

  app.use(createBusinessRateLimiter({
    // Account mode must never trust a client-supplied local-user header.
    getUser: req => String(runtimeEnv.FIELDDESK_AUTH_MODE || "local") === "accounts"
      ? req.fieldDeskUser : currentUserProvider(req),
    readLimit: Number(runtimeEnv.API_READ_RATE_LIMIT_PER_MINUTE || 600),
    pollLimit: Number(runtimeEnv.API_POLL_RATE_LIMIT_PER_MINUTE || 300),
    uploadLimit: Number(runtimeEnv.API_UPLOAD_RATE_LIMIT_PER_MINUTE || 120),
    writeLimit: Number(runtimeEnv.API_WRITE_RATE_LIMIT_PER_MINUTE || runtimeEnv.API_RATE_LIMIT_PER_MINUTE || 180),
  }));

  app.use(async (req, res, next) => {
    if (req.method !== "POST") return next();
    if (req.path.startsWith("/api/print-agent/")) return next();
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

  const activeReceiptSyncs = new Set();
  const receiptRecoveryAttempts = new Map();
  const activeHoldSyncs = new Set();

  function scheduleRecloudHoldSync(order, operator = {}, { manualRetry = false } = {}) {
    const rmaNo = String(order?.rmaNo || "").trim();
    const guardCandidate = manualRetry ? { ...order, manualRecoveryRequestedAt: new Date().toISOString() } : order;
    if (!rmaNo || !isRecloudRmaWriteAllowed(rmaNo, guardCandidate) || order.status !== "ON_HOLD" || !order?.hold || !["PENDING", "FAILED"].includes(order.hold.status) || !isRecloudHoldWriteEnabled(runtimeEnv) || activeHoldSyncs.has(rmaNo)) return false;
    activeHoldSyncs.add(rmaNo);
    setImmediate(async () => {
      let remoteConfirmed = false;
      try {
        await receiptStore.markRecloudHoldSubmitting(rmaNo, operator);
        const result = await withRecloud(connector, async (page) => {
          const detail = await connector.queryRmaByLogisticsNo(page, order.logisticsNo || rmaNo, { preserveDetailPage: true });
          if (detail.rmaNo !== rmaNo) {
            throw createApiError("RECLOUD_HOLD_ORDER_MISMATCH", "瑞云查询结果与当前暂存工单不一致", 409);
          }
          if (typeof connector.submitRmaHold !== "function") {
            throw createApiError("RECLOUD_HOLD_EXECUTOR_UNAVAILABLE", "瑞云滞留执行器尚未装配", 503);
          }
          return connector.submitRmaHold(page, {
            category: order.hold.category,
            reason: order.hold.reason,
            remark: order.hold.remark,
          }, { writeEnabled: true });
        }, { ...businessWriteOptions, timeoutCode: "RECLOUD_HOLD_TIMEOUT" });
        if (result?.confirmed !== true) throw Object.assign(new Error("瑞云暂存结果未确认"), { resultUnknown: true });
        remoteConfirmed = true;
        await receiptStore.markRecloudHoldConfirmed(rmaNo, result, operator);
      } catch (error) {
        await receiptStore.markRecloudHoldFailed(rmaNo, remoteConfirmed
          ? { code: "RECLOUD_HOLD_RESULT_UNKNOWN", resultUnknown: true } : error, operator).catch(() => {});
      } finally {
        activeHoldSyncs.delete(rmaNo);
      }
    });
    return true;
  }

  function scheduleRecloudReceiptSync(order, operator = {}, attemptId = "", scheduleOptions = {}) {
    const query = orderQuery(order);
    order = { ...order, logisticsNo: query.logisticsNo };
    const rmaNo = String(order?.rmaNo || "").trim();
    const receiptNeedsSync = !order?.recloudReceiptConfirmedAt;
    const projectNeedsSync = !order?.recloudProjectVerificationConfirmedAt;
    const attachments = Array.isArray(order?.receiptAttachments)
      ? order.receiptAttachments
      : [];
    const attachmentsNeedSync = attachments.length > 0
      && !order?.recloudReceiptAttachmentConfirmedAt;
    if (
      !rmaNo ||
      order?.snCorrectionRequiredAt ||
      !isRecloudRmaWriteAllowed(rmaNo, order) ||
      !isRecloudReceiptWriteEnabled(runtimeEnv) ||
      (!receiptNeedsSync && !projectNeedsSync && !attachmentsNeedSync) ||
      (receiptNeedsSync && order.recloudReceiptSyncStatus === "RESULT_UNKNOWN") ||
      (attachmentsNeedSync && order.recloudReceiptAttachmentSyncStatus === "RESULT_UNKNOWN"
        && !require('./services/receipt-attachment-recovery').canRecoverAttachments(order)) ||
      (projectNeedsSync && order.recloudProjectVerificationStatus === "RESULT_UNKNOWN") ||
      activeReceiptSyncs.has(rmaNo)
    ) {
      return false;
    }

    activeReceiptSyncs.add(rmaNo);
    scheduleBackgroundWork(async () => {
      let attachmentUploadTriggered = false;
      let receiptRemoteConfirmed = false;
      let attachmentsRemoteConfirmed = false;
      try {
        // Persist the bounded recovery attempt before any remote query, so
        // login/read failures and process restarts cannot create an infinite loop.
        if (order.recloudReceiptAttachmentSyncStatus === 'RESULT_UNKNOWN') {
          await receiptStore.markRecloudReceiptAttachmentsSyncing(rmaNo);
        }
        const result = await withRecloud(connector, async (page) => {
          let projectVerified = !projectNeedsSync;
          let detail = await connector.queryRmaByLogisticsNo(
            page,
            query.identifier,
            {
              ...query.options,
              preserveDetailPage: true,
              fastDomRead: true,
              expectedRmaNo: rmaNo,
              skipPendingReceiptProbe: Boolean(order.recloudReceiptConfirmedAt),
            }
          );
          if (detail.rmaNo && detail.rmaNo !== rmaNo) {
            throw createApiError(
              "RECLOUD_RECEIPT_ORDER_MISMATCH",
              "瑞云查询结果与当前寄修单不一致，已停止签收",
              409
            );
          }
          // Capture the SN-bound product identity while the first verified RMA
          // detail is already open. Re-reading the whole detail after signing
          // is slow and can transiently lose the product region during Recloud's
          // local refresh.
          let productIdentity = !detail.projectCode && typeof connector.readRmaProductIdentity === "function"
            ? await connector.readRmaProductIdentity(page, {
                sn: order.sn,
                logisticsNo: order.logisticsNo,
                productLine: detail.productLine || detail.productType || order.productLine,
              })
            : null;
          if (productIdentity?.sn
            && productIdentity.sn.trim().toUpperCase() !== String(order.sn || "").trim().toUpperCase()) {
            if (typeof connector.correctRmaProductSn !== "function") {
              throw createApiError(
                "RECLOUD_PRODUCT_SN_MISMATCH",
                "瑞云产品序列号与 FieldDesk 扫描 SN 不一致，且当前无法自动修正瑞云",
                409
              );
            }
            const correction = await connector.correctRmaProductSn(page, {
              currentSn: productIdentity.sn,
              expectedSn: order.sn,
              projectCode: productIdentity.projectCode,
              rmaNo,
            }, { dryRun: false });
            productIdentity = correction.identity || {
              ...productIdentity,
              sn: order.sn,
            };
          }
          let currentProjectCode = detail.projectCode || productIdentity?.projectCode || "";
          let receipt = null;
          if (receiptNeedsSync) {
            try {
              const receiptState = classifyRecloudReceiptState(detail);
              // The page action is authoritative: some already-signed RMA
              // details do not expose a stable status field to the parser. Do
              // not enter the complex row mapper unless an actual “签收”
              // action is visible; otherwise skip signing and continue project
              // verification plus attachment upload.
              const hasReceiptAction = typeof connector.hasVisibleReceiptAction === "function"
                ? await connector.hasVisibleReceiptAction(page)
                : receiptState.receiptRequired === true;
              const receiptTarget = hasReceiptAction && typeof connector.findMappedReceiptControl === "function"
                ? await connector.findMappedReceiptControl(page, {
                    logisticsNo: order.logisticsNo,
                    productLine: detail.productLine || detail.productType || order.productLine,
                    rowIndex: 1,
                  })
                : hasReceiptAction
                  ? { entry: null }
                  : null;
              if (!receiptTarget) {
                if (receiptState.code !== "ALREADY_RECEIVED") {
                  throw Object.assign(createApiError("RECLOUD_RECEIPT_RESULT_UNKNOWN", "未找到签收按钮且没有已签收证据，请核对瑞云", 409), { resultUnknown: true });
                }
                receiptRemoteConfirmed = true;
                await receiptStore.markRecloudReceiptConfirmed(rmaNo, {
                  skipped: true,
                  receipt: { confirmed: true, message: "瑞云读取状态为已签收或后续阶段，未重复签收" },
                  operator,
                });
              } else {
                await receiptStore.markRecloudReceiptSyncing(rmaNo, {
                  attemptId,
                  operator,
                });
                receipt = await connector.confirmSign(
                  page,
                  order.sn,
                  detail.productType || detail.productLine || order.productLine,
                  order.remark || order.specialty,
                  {
                    dryRun: false,
                    logisticsNo: order.logisticsNo,
                    productLine:
                      detail.productLine || detail.productType || order.productLine,
                    ...(receiptTarget.entry ? { receiptTarget } : {}),
                  }
                );
                if (!receipt?.confirmed) {
                  throw createApiError(
                    "RECLOUD_RECEIPT_NOT_CONFIRMED",
                    "瑞云未确认签收",
                    502
                  );
                }
                receiptRemoteConfirmed = true;
                await receiptStore.markRecloudReceiptConfirmed(rmaNo, {
                  receipt,
                  operator,
                });
              }
            } catch (error) {
              if (!order.recloudReceiptConfirmedAt) {
                await receiptStore.markRecloudReceiptFailed(rmaNo, {
                  code: error.code,
                  resultUnknown:
                    receiptRemoteConfirmed ||
                    error.resultUnknown === true ||
                    error.code === "RECLOUD_RECEIPT_RESULT_UNKNOWN",
                  operator,
                }).catch(() => {});
              }
              throw error;
            }
          }

          if (projectNeedsSync) try {
            await receiptStore.markRecloudProjectVerification(rmaNo, "SYNCING");
            if (!currentProjectCode) {
              const identityResult = await readReceiptProjectIdentityWithRetry(
                connector,
                page,
                order,
                { detail, productIdentity },
                { attempts: 6, pollMs: 500 }
              );
              detail = identityResult.detail;
              productIdentity = identityResult.productIdentity;
              currentProjectCode = identityResult.projectCode;
            }
            // The SN was already authorized before the technician could finish
            // FieldDesk receipt preparation. Reuse that persisted result when
            // comparing the live Recloud project code. A second Feishu request
            // here can stall an otherwise completed receipt and prevent its
            // attachments from ever reaching the upload stage.
            const cachedProjectAuthorization = resolvePersistedProjectAuthorization(
              order.modelAuthorization,
              currentProjectCode
            );
            // A matching project needs no product-model lookup. For a mismatch,
            // an earlier SN-only authorization can know the expected project and
            // model name while leaving productModelCode empty when variants
            // share one project. Re-resolve with the persisted model hint.
            const cachedAuthorizationIsComplete = cachedProjectAuthorization?.status === "MATCHED";
            const projectAuthorization = cachedAuthorizationIsComplete
              ? cachedProjectAuthorization
              : (typeof feishuModelCatalog.authorize === "function"
                ? await feishuModelCatalog.authorize({
                    sn: order.sn,
                    currentProjectCode,
                    model: order.modelAuthorization?.model,
                  })
                : order.modelAuthorization);
            if (projectAuthorization?.status === "CHANGE_REQUIRED") {
              if (typeof connector.correctRmaProjectModel !== "function") {
                throw createApiError("RECLOUD_PROJECT_CORRECTION_UNAVAILABLE", "瑞云项目号需要修改，但修改功能不可用", 503);
              }
              if (!await isExpectedRmaStillOpen(page, rmaNo)) {
                detail = await connector.queryRmaByLogisticsNo(page, query.identifier, { ...query.options, preserveDetailPage: true });
              }
              await connector.correctRmaProjectModel(page, {
                sn: order.sn,
                currentProjectCode: projectAuthorization.currentProjectCode,
                expectedProjectCode: projectAuthorization.projectCode,
                productModelCode: projectAuthorization.productModelCode,
              }, { dryRun: false });
            } else if (projectAuthorization?.status !== "MATCHED") {
              if (!currentProjectCode) {
                throw createApiError(
                  "RECLOUD_PROJECT_IDENTITY_NOT_READY",
                  "瑞云项目号暂未读取到，后台正在自动重试",
                  409
                );
              }
              throw createApiError("RECLOUD_PROJECT_VERIFICATION_REQUIRED", "无法确认瑞云项目号与 SN 一致，已停止后台操作", 409);
            }
            await receiptStore.markRecloudProjectVerification(rmaNo, "CONFIRMED", {
              projectCode: projectAuthorization?.projectCode || currentProjectCode,
            });
            projectVerified = true;
          } catch (error) {
            await receiptStore.markRecloudProjectVerification(
              rmaNo,
              error.code === "RECLOUD_PROJECT_IDENTITY_NOT_READY" ? "SYNCING" : "FAILED",
              {
              code: error.code || "RECLOUD_PROJECT_VERIFICATION_REQUIRED",
              message: error.message,
              }
            ).catch(() => {});
            throw error;
          }

          let attachmentResult = null;
          if (attachmentsNeedSync) {
            if (!projectVerified) {
              throw createApiError(
                "RECLOUD_PROJECT_VERIFICATION_REQUIRED",
                "项目号未确认，禁止上传签收照片",
                409
              );
            }
            await receiptStore.markRecloudReceiptAttachmentsSyncing(rmaNo);
            try {
              // The first read may intentionally reset the page back to the
              // scanner. Reopen and preserve the verified RMA detail before
              // locating its attachment card, including attachment-only retries.
              if (!await isExpectedRmaStillOpen(page, rmaNo)) {
                detail = await connector.queryRmaByLogisticsNo(
                  page,
                  query.identifier,
                  { ...query.options, preserveDetailPage: true }
                );
              }
              if (detail.rmaNo && detail.rmaNo !== rmaNo) {
                throw createApiError(
                  "RECLOUD_RECEIPT_ORDER_MISMATCH",
                  "瑞云查询结果与当前寄修单不一致，已停止上传签收照片",
                  409
                );
              }
              const hydrated = await Promise.all(attachments.map(async (attachment) => ({
                ...attachment,
                buffer: await receiptAttachmentStore.read(rmaNo, attachment),
              })));
              if (order.recloudReceiptAttachmentSyncStatus === 'RESULT_UNKNOWN') {
                const files = require('./services/receipt-attachment-identity').receiptUploadFiles(rmaNo, hydrated);
                const first = await connector.readRmaReceiptAttachmentSnapshot(page, rmaNo);
                await page.waitForTimeout(2000);
                const second = await connector.readRmaReceiptAttachmentSnapshot(page, rmaNo);
                require('./services/receipt-attachment-recovery').verifyRecoverySnapshots(rmaNo, files, first, second);
              }
              attachmentUploadTriggered = true;
              attachmentResult = await connector.uploadRmaAttachments(
                page,
                hydrated,
                { writeEnabled: true, rmaNo, timeoutMs: 120000 }
              );
              attachmentsRemoteConfirmed = true;
              await receiptStore.markRecloudReceiptAttachmentsConfirmed(rmaNo, {
                result: attachmentResult,
                operator,
              });
            } catch (error) {
              await receiptStore.markRecloudReceiptAttachmentsFailed(rmaNo, {
                code: error.code,
                resultUnknown:
                  attachmentsRemoteConfirmed ||
                  error.resultUnknown === true ||
                  error.code === "RECLOUD_RMA_ATTACHMENT_RESULT_UNKNOWN",
              }).catch(() => {});
              throw error;
            }
          }
          return { receipt, attachmentResult };
        }, {
          ...businessWriteOptions,
          queuePriority: scheduleOptions.queuePriority ?? businessWriteOptions.queuePriority,
          timeoutCode: "RECLOUD_RECEIPT_TIMEOUT",
        });
        receiptRecoveryAttempts.delete(rmaNo);
        const syncedOrder = (await receiptStore.readAll()).find((item) => item.rmaNo === rmaNo);
        if (syncedOrder?.inspectionUpdatedAt && !syncedOrder.recloudDetectionConfirmedAt) {
          scheduleRecloudDetectionSync(syncedOrder, operator);
        }
        return result;
      } catch (error) {
        const current = (await receiptStore.readAll()).find((item) => item.rmaNo === rmaNo);
        const pageCrashed = /page crashed|target (?:page|context|browser).*closed|browser has been closed|page has been closed/i
          .test(String(error?.message || ""));
        const failureCode = error.code || (pageCrashed ? "RECLOUD_PAGE_CRASHED" : "RECLOUD_RECEIPT_FAILED");
        if (current && !current.recloudReceiptConfirmedAt && receiptNeedsSync) {
          await receiptStore.markRecloudReceiptFailed(rmaNo, {
            code: failureCode,
            resultUnknown:
              receiptRemoteConfirmed || error.resultUnknown === true
              || error.code === "RECLOUD_RECEIPT_RESULT_UNKNOWN"
              || error.code === "RECLOUD_RECEIPT_TIMEOUT",
            operator,
          }).catch(() => {});
        }
        if (current && !current.recloudReceiptAttachmentConfirmedAt && attachmentsNeedSync) {
          await receiptStore.markRecloudReceiptAttachmentsFailed(rmaNo, {
            code: failureCode,
            resultUnknown:
              order.recloudReceiptAttachmentSyncStatus === 'RESULT_UNKNOWN'
              || attachmentsRemoteConfirmed || attachmentUploadTriggered
              && (error.resultUnknown === true || error.code === "RECLOUD_RECEIPT_TIMEOUT"),
          }).catch(() => {});
        }
        console.error(
          `RECLOUD_RECEIPT_BACKGROUND: failed ${error.code || "UNKNOWN"}`,
          JSON.stringify({ name: error.name || "Error", message: error.message || "" })
        );
        const retryable = error.retryable !== false
          && !NON_RETRYABLE_RECEIPT_ERRORS.has(failureCode);
        const retryCount = retryable
          ? (receiptRecoveryAttempts.get(rmaNo) || 0) + 1
          : 0;
        if (retryable) receiptRecoveryAttempts.set(rmaNo, retryCount);
        else receiptRecoveryAttempts.delete(rmaNo);
        const retryDelay = retryable ? [2000, 5000, 15000][retryCount - 1] : 0;
        if (retryDelay) {
          const retryTimer = scheduleBackgroundRetry(async () => {
            const latest = (await receiptStore.readAll()).find((item) => item.rmaNo === rmaNo);
            if (latest) scheduleRecloudReceiptSync(
              latest, operator, crypto.randomUUID(), scheduleOptions
            );
          }, retryDelay);
          retryTimer.unref?.();
        }
      } finally {
        activeReceiptSyncs.delete(rmaNo);
      }
    });
    return true;
  }

  if (options.resumePendingRecloudReceipts === true) {
    setImmediate(async () => {
      try {
        const orders = await receiptStore.readAll();
        for (const order of orders) {
          if (shouldAutoResumeReceipt(order)) {
            scheduleRecloudReceiptSync(order, {
              userId: order.operatorId || order.technicianId || "SYSTEM",
              displayName: order.operatorName || order.technicianName || "FieldDesk 后台",
            }, crypto.randomUUID(), { queuePriority: -100 });
          }
        }
      } catch (error) {
        console.error(`RECLOUD_RECEIPT_STARTUP_RESUME: failed ${error.code || "UNKNOWN"}`);
      }
    });
  }

  const activeDetectionSyncs = new Set();
  const detectionRecoveryAttempts = new Map();

  function scheduleRecloudDetectionSync(order, operator = {}, scheduleOptions = {}) {
    const query = orderQuery(order);
    const rmaNo = String(order?.rmaNo || "").trim();
    const receiptDependenciesReady = Boolean(
      order?.recloudReceiptConfirmedAt
      && order?.recloudProjectVerificationConfirmedAt
      && (!(order?.receiptAttachments || []).length || order?.recloudReceiptAttachmentConfirmedAt)
    );
    if (rmaNo && isRecloudReceiptWriteEnabled(runtimeEnv) && !receiptDependenciesReady) {
      scheduleRecloudReceiptSync(order, operator, crypto.randomUUID(), scheduleOptions);
      return false;
    }
    if (
      !rmaNo ||
      !isRecloudRmaWriteAllowed(rmaNo, order) ||
      !isRecloudInspectionWriteEnabled(runtimeEnv) ||
      order.recloudDetectionConfirmedAt ||
      order.recloudDetectionSyncStatus === "RESULT_UNKNOWN" ||
      order.recloudDetectionSubmissionStartedAt ||
      activeDetectionSyncs.has(rmaNo)
    ) {
      return false;
    }
    activeDetectionSyncs.add(rmaNo);
    scheduleBackgroundWork(async () => {
      let confirmationAttempted = false;
      try {
        await receiptStore.markRecloudDetectionSyncing(rmaNo);
        const liveResult = await withRecloud(connector, async (page, operationContext) => {
          const detail = await connector.queryRmaByLogisticsNo(page, query.identifier, {
            ...query.options,
            preserveDetailPage: true,
            fastDomRead: true,
            revealPhoneEnabled: false,
            skipPendingReceiptProbe: true,
          });
          if (detail.rmaNo && detail.rmaNo !== rmaNo) {
            throw createApiError(
              "RECLOUD_DETECTION_ORDER_MISMATCH",
              "瑞云查询结果与当前寄修单不一致，已停止检测",
              409
            );
          }
          return connector.confirmDetection(page, {
            treatmentMode: order.treatmentMode,
            faultCategory: order.faultCategory,
            faultCategoryCode: order.faultCategoryCode || "",
            warrantyStatus: order.technicianWarranty,
            detectionResult: order.detectionResult,
            faultContent: order.faultContent || resolveFaultContent(order),
            inspectionResult: order.inspectionResult,
            productFunctionDecision: order.treatmentMode === "DEBUGGING"
              ? "无异常"
              : order.productFunctionDecision,
            reportedFault: order.reportedFault,
          }, {
            dryRun: false,
            writeEnabled: true,
            onConfirmationAttempt: async () => {
              await receiptStore.markRecloudDetectionSubmissionStarted(rmaNo);
              confirmationAttempted = true;
              if (operationContext.isExpired?.()) {
                throw Object.assign(new Error("检测任务已经超时，禁止迟到提交"), { resultUnknown: true });
              }
            },
          });
        }, {
          ...businessWriteOptions,
          queuePriority: scheduleOptions.queuePriority ?? businessWriteOptions.queuePriority,
          timeoutCode: "RECLOUD_DETECTION_TIMEOUT",
          // The lane deadline may win before confirmDetection can throw.
          resultUnknownOnTimeout: () => confirmationAttempted,
        });
        if (!liveResult?.confirmed) {
          throw createApiError("RECLOUD_DETECTION_NOT_CONFIRMED", "瑞云未确认检测", 502);
        }
        const confirmedOrder = await receiptStore.markRecloudDetectionConfirmed(rmaNo, { operator });
        detectionRecoveryAttempts.delete(rmaNo);
        // The technician may already have moved to the completion form while
        // Recloud detection was running. Continue the dependent service-order
        // work in the background as soon as detection becomes authoritative.
        if (
          confirmedOrder?.recloudRepairPreparation?.status === "PENDING"
          && !confirmedOrder.recloudServiceOrderCreatedAt
        ) {
          scheduleRecloudServiceOrderSync(confirmedOrder, operator);
        }
      } catch (error) {
        const resultUnknown = error.resultUnknown === true
          || (confirmationAttempted && error.resultUnknown !== false)
          || error.code === "RECLOUD_DETECTION_RESULT_UNKNOWN";
        await receiptStore.markRecloudDetectionFailed(rmaNo, {
          code: error.code,
          resultUnknown,
        }).catch(() => {});
        console.error(
          `RECLOUD_DETECTION_BACKGROUND: failed ${error.code || "UNKNOWN"}`,
          JSON.stringify({
            name: error.name || "Error",
            message: error.message || "",
            fieldKey: error.fieldKey || "",
            validationMessages: error.validationMessages || [],
          })
        );
        if (!resultUnknown && !NON_RETRYABLE_DETECTION_ERRORS.has(error.code)) {
          const retryCount = (detectionRecoveryAttempts.get(rmaNo) || 0) + 1;
          detectionRecoveryAttempts.set(rmaNo, retryCount);
          const retryDelay = [2000, 5000, 15000][retryCount - 1];
          if (retryDelay) {
            const retryTimer = scheduleBackgroundRetry(async () => {
              const latest = (await receiptStore.readAll()).find((item) => item.rmaNo === rmaNo);
              if (latest) scheduleRecloudDetectionSync(latest, operator, scheduleOptions);
            }, retryDelay);
            retryTimer.unref?.();
          }
        }
      } finally {
        activeDetectionSyncs.delete(rmaNo);
      }
    });
    return true;
  }

  if (options.resumePendingRecloudDetections === true) {
    setImmediate(async () => {
      try {
        const orders = await receiptStore.readAll();
        for (const order of orders) {
          if (shouldAutoResumeDetection(order)) {
            scheduleRecloudDetectionSync(order, {
              userId: order.operatorId || order.technicianId || "SYSTEM",
              displayName: order.operatorName || order.technicianName || "FieldDesk 后台",
            }, { queuePriority: -100 });
          }
        }
      } catch (error) {
        console.error(`RECLOUD_DETECTION_STARTUP_RESUME: failed ${error.code || "UNKNOWN"}`);
      }
    });
  }

  const activeServiceOrderSyncs = new Set();
  const serviceOrderRecoveryAttempts = new Map();
  const serviceOrderRecoveryNextAt = new Map();

  function scheduleRecloudServiceOrderSync(order, operator = {}, recoveryOptions = {}) {
    if (blocksPartRetry(order?.recloudRepairPreparation?.lastError?.code)) return false;
    const query = orderQuery(order);
    const rmaNo = String(order?.rmaNo || "").trim();
    const forcedPreparationRecovery = Boolean(
      recoveryOptions.forcePreparationRecovery === true
      && order?.recloudServiceOrderCreatedAt
      && order?.recloudServiceOrderNo
    );
    const recoveringPreparation = Boolean(
      order?.recloudServiceOrderCreatedAt
      && (order?.recloudRepairPreparation?.status === "FAILED" || forcedPreparationRecovery)
    );
    if (
      !rmaNo ||
      !isRecloudRmaWriteAllowed(rmaNo, order) ||
      !isRecloudInspectionWriteEnabled(runtimeEnv) ||
      !order.recloudDetectionConfirmedAt ||
      (order.recloudServiceOrderCreatedAt && !recoveringPreparation) ||
      order.recloudServiceOrderSyncStatus === "RESULT_UNKNOWN" ||
      Number(serviceOrderRecoveryNextAt.get(rmaNo) || 0) > Date.now() ||
      activeServiceOrderSyncs.has(rmaNo)
    ) return false;
    activeServiceOrderSyncs.add(rmaNo);
    scheduleBackgroundWork(async () => {
      let serviceOrderCreated = false;
      let creationAttempted = false;
      try {
        await receiptStore.markRecloudServiceOrderSyncing(rmaNo);
        let preparationResult = null;
        const liveResult = await withRecloud(connector, async (page) => {
          let result;
          if (recoveringPreparation) {
            if (!order.recloudServiceOrderNo || typeof connector.openExistingRepairServiceOrder !== "function") {
              throw createApiError("RECLOUD_REPAIR_RECOVERY_CONTEXT_MISSING", "已建维修单缺少恢复所需的服务单号", 409);
            }
            await connector.openExistingRepairServiceOrder(page, {
              rmaNo,
              logisticsNo: order.logisticsNo,
              serviceOrderNo: order.recloudServiceOrderNo,
            });
            serviceOrderCreated = true;
            result = {
              serviceOrderCreated: true,
              serviceOrderNo: order.recloudServiceOrderNo,
              recoveredExistingServiceOrder: true,
            };
          } else {
            // Detection and service-order creation normally run on the same
            // business-write lane. Keep the verified RMA detail page left by
            // detection instead of rescanning the logistics number and
            // rereading the whole order. If another job changed this lane's
            // page, fall back to the authoritative query before writing.
            const reusedDetectionDetail = await isExpectedRmaStillOpen(page, rmaNo);
            if (!reusedDetectionDetail) {
              const detail = await connector.queryRmaByLogisticsNo(page, query.identifier, {
                ...query.options,
                preserveDetailPage: true,
                fastDomRead: true,
                revealPhoneEnabled: false,
                skipPendingReceiptProbe: true,
              });
              if (detail.rmaNo && detail.rmaNo !== rmaNo) {
                throw createApiError("RECLOUD_REPAIR_ORDER_MISMATCH", "瑞云查询结果与当前寄修单不一致", 409);
              }
            }
            try {
              result = await require('./services/recloud-phase-timing').timeRecloudPhase(rmaNo, 'preparation_create_service_order', () => connector.startRepair(page, { dryRun: false, writeEnabled: true, onBeforeCreate: () => { creationAttempted = true; } }));
            } catch (error) {
              // Recloud may keep the just-confirmed detection page visible
              // before refreshing its operation column. Reuse is only an
              // optimization: if the untouched page still has no Repair
              // action, rescan once and continue through the authoritative
              // path instead of retrying the same stale DOM.
              if (!reusedDetectionDetail || error.code !== "RECLOUD_ACTION_NOT_FOUND") throw error;
              const detail = await connector.queryRmaByLogisticsNo(page, query.identifier, {
                ...query.options,
                preserveDetailPage: true,
                fastDomRead: true,
                revealPhoneEnabled: false,
                skipPendingReceiptProbe: true,
              });
              if (detail.rmaNo && detail.rmaNo !== rmaNo) {
                throw createApiError("RECLOUD_REPAIR_ORDER_MISMATCH", "瑞云查询结果与当前寄修单不一致", 409);
              }
              result = await require('./services/recloud-phase-timing').timeRecloudPhase(rmaNo, 'preparation_create_service_order_retry', () => connector.startRepair(page, { dryRun: false, writeEnabled: true, onBeforeCreate: () => { creationAttempted = true; } }));
            }
            if (!result?.serviceOrderCreated) {
              throw createApiError("RECLOUD_SERVICE_ORDER_NOT_CREATED", "瑞云未确认创建维修服务单", 502);
            }
            serviceOrderCreated = true;
            await receiptStore.markRecloudServiceOrderConfirmed(rmaNo, operator, {
              serviceOrderNo: result.serviceOrderNo,
            });
          }
          if (!options.recloudRepairPageAdapterFactory) {
            throw createApiError("RECLOUD_FIRST_ENTRY_ADAPTER_REQUIRED", "缺少首次进入服务单执行器，禁止退出后重新进入补改派", 502);
          }
          const adapter = options.recloudRepairPageAdapterFactory(page, {
            rmaNo,
            logisticsNo: order.logisticsNo,
            sn: order.sn,
            payload: order.recloudRepairPreparation,
          });
          preparationResult = await orchestrateRepairStart({
            assignee: order.recloudRepairPreparation?.assignee,
            assignmentSource: order.recloudRepairPreparation?.assignmentSource,
            warrantyConversionRequested: order.recloudRepairPreparation?.warrantyConversionRequested === true,
            usedParts: order.recloudRepairPreparation?.usedParts || [],
          }, adapter, { writeEnabled: true, orderKey: rmaNo });
          return result;
        }, {
          ...businessWriteOptions,
          queuePriority: recoveryOptions.queuePriority ?? businessWriteOptions.queuePriority,
          timeoutCode: "RECLOUD_SERVICE_ORDER_TIMEOUT",
          affinityKey: rmaNo,
        });
        if (!liveResult?.serviceOrderCreated) {
          throw createApiError("RECLOUD_SERVICE_ORDER_NOT_CREATED", "瑞云未确认创建维修服务单", 502);
        }
        if (!["SUCCESS", "PARTS_SHORTAGE"].includes(preparationResult?.status)) {
          throw createApiError("RECLOUD_REPAIR_PREPARATION_NOT_CONFIRMED", "瑞云改派、保外转保内或配件未全部确认", 502);
        }
        await receiptStore.markRecloudRepairPreparationConfirmed?.(rmaNo, preparationResult, operator);
        if (recoveryOptions.retryCompletionAfterPreparation === true && typeof syncService?.outbox?.readAll === "function") {
          const repairCompletionTask = (await syncService.outbox.readAll())
            .filter((task) => task.rmaNo === rmaNo && task.nodeType === "REPAIR_COMPLETED")
            .filter((task) => ["FAILED", "MANUAL_REVIEW", "READY_DRY_RUN"].includes(task.status))
            .sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")))[0];
          if (repairCompletionTask) await syncService.retry(repairCompletionTask.id);
        }
        serviceOrderRecoveryAttempts.delete(rmaNo);
        serviceOrderRecoveryNextAt.delete(rmaNo);
      } catch (error) {
        const resultUnknown = creationAttempted && (error.resultUnknown === true
          || error.code === "RECLOUD_REPAIR_START_RESULT_UNKNOWN");
        if (serviceOrderCreated) {
          await receiptStore.markRecloudRepairPreparationFailed?.(rmaNo, {
            code: error.code,
            message: error.message,
          }).catch(() => {});
        } else {
          await receiptStore.markRecloudServiceOrderFailed(rmaNo, {
            code: error.code,
            resultUnknown,
          }).catch(() => {});
        }
        console.error(
          `RECLOUD_SERVICE_ORDER_BACKGROUND: failed ${error.code || "UNKNOWN"}`,
          JSON.stringify({ name: error.name || "Error", message: error.message || "" })
        );
        if (!blocksPartRetry(error.code) && (serviceOrderCreated || !resultUnknown) && (serviceOrderRecoveryAttempts.get(rmaNo) || 0) < 4) {
          const retryCount = (serviceOrderRecoveryAttempts.get(rmaNo) || 0) + 1;
          serviceOrderRecoveryAttempts.set(rmaNo, retryCount);
          const retryDelay = [2000, 5000, 15000, 60000][Math.min(retryCount - 1, 3)];
          serviceOrderRecoveryNextAt.set(rmaNo, Date.now() + retryDelay);
          const retryTimer = scheduleBackgroundRetry(async () => {
            serviceOrderRecoveryNextAt.delete(rmaNo);
            const latest = (await receiptStore.readAll()).find((item) => item.rmaNo === rmaNo);
            if (!latest) return;
            scheduleRecloudServiceOrderSync(latest, operator, serviceOrderCreated ? {
              queuePriority: recoveryOptions.queuePriority,
              forcePreparationRecovery: true,
            } : { queuePriority: recoveryOptions.queuePriority });
          }, retryDelay);
          retryTimer.unref?.();
        }
      } finally {
        activeServiceOrderSyncs.delete(rmaNo);
      }
    });
    return true;
  }

  if (options.resumePendingRecloudServiceOrders === true) {
    setImmediate(async () => {
      try {
        const orders = await receiptStore.readAll();
        for (const order of orders) {
          if (
            order.recloudDetectionConfirmedAt
            && !order.recloudServiceOrderCreatedAt
            && order.recloudRepairPreparation?.status === "PENDING"
            && order.recloudServiceOrderSyncStatus === "FAILED"
          ) {
            scheduleRecloudServiceOrderSync(order, {
              userId: order.operatorId || order.technicianId || "SYSTEM",
              displayName: order.operatorName || order.technicianName || "FieldDesk 后台",
            }, { queuePriority: -100 });
          }
        }
      } catch (error) {
        console.error(`RECLOUD_SERVICE_ORDER_STARTUP_RESUME: failed ${error.code || "UNKNOWN"}`);
      }
    });
  }

  let recloudRecoverySweepRunning = false;
  let recloudRecoverySweepTimer = null;
  const runRecloudRecoverySweep = async () => {
    if (recloudRecoverySweepRunning) return { skipped: true, scheduled: 0 };
    recloudRecoverySweepRunning = true;
    try {
      const now = Date.now();
      const batchSize = recloudRecoverySweepBatchSize(runtimeEnv);
      const orders = await receiptStore.readAll();
      const candidates = orders.map((order) => {
        if (shouldAutoResumeReceipt(order, now)) return { order, stage: "receipt" };
        if (shouldAutoResumeDetection(order, now, runtimeEnv.RECLOUD_WRITE_RMA_STRICT === "true")) return { order, stage: "detection" };
        if (shouldAutoResumeServiceOrder(order, now)) return { order, stage: "service-order" };
        return null;
      }).filter(Boolean)
        // Apply the write fence before truncating the recovery batch. Otherwise
        // older blocked records outside a temporary allowlist can occupy every
        // slot and prevent the explicitly allowed order from ever being retried.
        .filter(({ order }) => isRecloudRmaWriteAllowed(order.rmaNo, order))
        .sort((left, right) => String(
          left.order.updatedAt || left.order.createdAt || ""
        ).localeCompare(String(right.order.updatedAt || right.order.createdAt || "")))
        .slice(0, batchSize);
      let scheduled = 0;
      for (const candidate of candidates) {
        const order = candidate.order;
        const operator = {
          userId: order.operatorId || order.technicianId || "SYSTEM",
          displayName: order.operatorName || order.technicianName || "FieldDesk 恢复巡检",
        };
        if (candidate.stage === "receipt") {
          scheduled += Number(scheduleRecloudReceiptSync(
            order, operator, crypto.randomUUID(), { queuePriority: -50 }
          ));
        } else if (candidate.stage === "detection") {
          scheduled += Number(scheduleRecloudDetectionSync(order, operator, { queuePriority: -50 }));
        } else {
          scheduled += Number(scheduleRecloudServiceOrderSync(order, operator, {
            queuePriority: -50,
            forcePreparationRecovery: order.recloudRepairPreparation?.status === "FAILED",
          }));
        }
      }
      const outboxScheduled = typeof syncService.resumePendingTasks === "function"
        ? await syncService.resumePendingTasks({
            minFailedAgeMs: RECLOUD_FAILED_RETRY_COOLDOWN_MS,
            maxTasks: batchSize,
          })
        : 0;
      if (scheduled || outboxScheduled) {
        console.info(`RECLOUD_RECOVERY_WATCHDOG: orderTasks=${scheduled} outboxTasks=${outboxScheduled}`);
      }
      return { skipped: false, scheduled, outboxScheduled };
    } catch (error) {
      console.error(`RECLOUD_RECOVERY_WATCHDOG: failed ${error.code || "UNKNOWN"}`);
      return { skipped: false, scheduled: 0, error: error.code || "UNKNOWN" };
    } finally {
      recloudRecoverySweepRunning = false;
    }
  };
  if (options.recloudRecoveryWatchdogEnabled === true) {
    setImmediate(() => runRecloudRecoverySweep());
    recloudRecoverySweepTimer = setInterval(
      () => runRecloudRecoverySweep(),
      recloudRecoverySweepIntervalMs(runtimeEnv)
    );
    recloudRecoverySweepTimer.unref?.();
  }
  app.locals.runRecloudRecoverySweep = runRecloudRecoverySweep;
  app.locals.stopRecloudRecoveryWatchdog = () => {
    if (recloudRecoverySweepTimer) clearInterval(recloudRecoverySweepTimer);
    recloudRecoverySweepTimer = null;
  };

  app.get("/api/health", (req, res) => {
    res.json({
      success: true,
      service: "fielddesk-api",
      pid: process.pid,
      dryRun: isDryRun(runtimeEnv),
      recloudWriteEnabled: isRecloudWriteEnabled(runtimeEnv),
      receiptWriteEnabled: isRecloudReceiptWriteEnabled(runtimeEnv),
      inspectionWriteEnabled: isRecloudInspectionWriteEnabled(runtimeEnv),
      holdWriteEnabled: isRecloudHoldWriteEnabled(runtimeEnv),
      completionWriteEnabled: isRecloudCompletionWriteEnabled(runtimeEnv),
    });
  });

  app.get("/api/ready", async (req, res) => {
    try {
      await Promise.all([receiptStore.readAll(), inventoryStore.read(), coordinationStore.backend.read()]);
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
        recloudAssignmentMode: user.recloudAssignmentMode || "DIRECT",
        recloudAssigneeName: user.recloudAssigneeName || "",
        recloudFallbackAssigneeName: user.recloudFallbackAssigneeName || "",
        mustChangePassword: user.mustChangePassword === true,
        accountAuthority: user.accountAuthority || "",
      },
    });
  });

  function requirePrintAdministrator(req) {
    const user = currentUserProvider(req);
    if (!hasBusinessRole(user, USER_ROLES.ADMIN)) {
      throw createApiError("PRINT_ADMIN_REQUIRED", "只有负责人或管理员可以配置打印终端", 403);
    }
    return user;
  }

  async function authenticatePrintAgent(req) {
    const terminal = await printJobStore.authenticate(
      req.headers["x-print-terminal-id"],
      req.headers["x-print-terminal-token"]
    );
    if (!terminal) throw createApiError("PRINT_AGENT_AUTH_INVALID", "打印终端认证失败", 401);
    return terminal;
  }

  app.get("/api/print-agent/download/agent", (req, res) => {
    res.download(path.join(__dirname, "scripts", "windows", "FieldDesk-Print-Agent.ps1"), "FieldDesk-Print-Agent.ps1");
  });

  app.get("/api/print-agent/download/installer", (req, res) => {
    res.download(path.join(__dirname, "scripts", "windows", "Install-FieldDesk-Print-Agent.ps1"), "Install-FieldDesk-Print-Agent.ps1");
  });

  app.get("/api/admin/print/terminals", async (req, res, next) => {
    try {
      requirePrintAdministrator(req);
      res.json({ success: true, data: { terminals: await printJobStore.list(), jobs: await printJobStore.listJobs(100) } });
    } catch (error) { next(error); }
  });

  app.post("/api/admin/print/terminals", async (req, res, next) => {
    try {
      requirePrintAdministrator(req);
      res.status(req.body?.id ? 200 : 201).json({ success: true, data: await printJobStore.saveTerminal(req.body || {}) });
    } catch (error) { next(error); }
  });

  app.post("/api/admin/print/terminals/enrollment", async (req, res, next) => {
    try {
      requirePrintAdministrator(req);
      res.setHeader("Cache-Control", "no-store");
      res.json({ success: true, data: await printJobStore.renewEnrollment(req.body?.id) });
    } catch (error) { next(error); }
  });

  app.post("/api/admin/print/terminals/delete", async (req, res, next) => {
    try {
      requirePrintAdministrator(req);
      res.json({ success: true, data: await printJobStore.deleteTerminal(req.body?.id) });
    } catch (error) { next(error); }
  });

  app.post("/api/admin/print/jobs/test", async (req, res, next) => {
    try {
      const user = requirePrintAdministrator(req);
      const terminalId = String(req.body?.terminalId || "").trim();
      if (!terminalId) throw createApiError("PRINT_TERMINAL_REQUIRED", "请选择测试打印终端", 400);
      const job = await printJobStore.enqueue({
        terminalId,
        allowAnyTerminal: true,
        userId: user.userId,
        userName: user.displayName,
        documentType: "TEST_LABEL",
        title: "FieldDesk 测试标签",
        rmaNo: `TEST-${Date.now()}`,
        sn: "XP-420B",
        partCode: "FIELDDESK",
        partName: "PRINT-TEST",
        technicianName: user.displayName,
        idempotencyKey: `print-test:${terminalId}:${Date.now()}`,
      });
      res.status(201).json({ success: true, data: job });
    } catch (error) { next(error); }
  });

  app.post("/api/admin/print/jobs/retry", async (req, res, next) => {
    try {
      requirePrintAdministrator(req);
      res.json({ success: true, data: await printJobStore.retry(req.body?.jobId, req.body?.terminalId) });
    } catch (error) { next(error); }
  });

  app.post("/api/print/jobs", async (req, res, next) => {
    try {
      const user = currentUserProvider(req);
      const job = await printJobStore.enqueue({
        terminalId: req.body?.terminalId,
        documentType: req.body?.documentType,
        title: req.body?.title,
        rmaNo: req.body?.rmaNo,
        sn: req.body?.sn,
        partCode: req.body?.partCode,
        partName: req.body?.partName,
        quantity: req.body?.quantity,
        copies: req.body?.copies,
        technicianName: user.displayName,
        userId: user.userId,
        userName: user.displayName,
        allowAnyTerminal: hasBusinessRole(user, USER_ROLES.ADMIN),
        idempotencyKey: String(req.headers["idempotency-key"] || req.body?.idempotencyKey || "").trim(),
      });
      res.status(201).json({ success: true, data: job });
    } catch (error) { next(error); }
  });

  app.post("/api/print-agent/heartbeat", async (req, res, next) => {
    try {
      const terminal = await authenticatePrintAgent(req);
      res.json({ success: true, data: await printJobStore.heartbeat(terminal.id, req.body || {}) });
    } catch (error) { next(error); }
  });

  app.get("/api/print-agent/jobs/next", async (req, res, next) => {
    try {
      const terminal = await authenticatePrintAgent(req);
      await printJobStore.heartbeat(terminal.id, {
        agentVersion: req.headers["x-print-agent-version"],
        computerName: req.headers["x-print-computer-name"],
        printerName: terminal.printerName,
      });
      res.json({ success: true, data: await printJobStore.leaseNext(terminal.id, String(req.headers["x-print-agent-version"] || "")) });
    } catch (error) { next(error); }
  });

  app.post("/api/print-agent/jobs/complete", async (req, res, next) => {
    try {
      const terminal = await authenticatePrintAgent(req);
      res.json({ success: true, data: await printJobStore.finish(
        terminal.id,
        req.body?.jobId,
        req.body?.success === true,
        req.body?.error
      ) });
    } catch (error) { next(error); }
  });

  app.post("/api/auth/change-password", async (req, res, next) => {
    try {
      const user = currentUserProvider(req);
      await accountStore.changePassword(user.userId, req.body?.newPassword);
      res.json({ success: true, data: { changed: true } });
    } catch (error) { next(error); }
  });

  app.post("/api/auth/recloud-operator-name", async (req, res, next) => {
    try {
      const user = currentUserProvider(req);
      res.json({ success: true, data: await accountStore.updateRecloudOperatorName(user.userId, req.body?.recloudAssigneeName) });
    } catch (error) { next(error); }
  });

  app.get("/api/admin/users", async (req, res, next) => {
    try {
      const user = currentUserProvider(req);
      if (user.role !== USER_ROLES.ADMIN) throw createApiError("ACCOUNT_ADMIN_REQUIRED", "只有管理员可以查看账号", 403);
      res.json({ success: true, data: await accountStore.list(user) });
    } catch (error) { next(error); }
  });

  app.get("/api/admin/accounts/next", async (req, res, next) => {
    try {
      const user = currentUserProvider(req);
      if (user.role !== USER_ROLES.ADMIN) throw createApiError("ACCOUNT_ADMIN_REQUIRED", "只有管理员可以查看账号", 403);
      res.json({ success: true, data: { userId: await accountStore.getNextManagedUserId() } });
    } catch (error) { next(error); }
  });

  app.post("/api/admin/users", async (req, res, next) => {
    try {
      const user = currentUserProvider(req);
      const data = await accountStore.upsert(req.body || {}, user);
      if (data.active === false) await accountStore.revokeSessionsForUser(data.userId);
      res.json({ success: true, data });
    } catch (error) { next(error); }
  });

  app.post("/api/admin/accounts", async (req, res, next) => {
    try {
      const user = currentUserProvider(req);
      res.status(201).json({ success: true, data: await accountStore.createManagedAccount(req.body || {}, user) });
    } catch (error) { next(error); }
  });

  app.post("/api/admin/accounts/delete", async (req, res, next) => {
    try {
      const user = currentUserProvider(req);
      const data = await accountStore.delete(req.body?.userId, user);
      await accountStore.revokeSessionsForUser(data.userId);
      res.json({ success: true, data });
    } catch (error) { next(error); }
  });

  app.post("/api/admin/accounts/reset-password", async (req, res, next) => {
    try {
      const user = currentUserProvider(req);
      const data = await accountStore.resetPassword(req.body?.userId, user);
      await accountStore.revokeSessionsForUser(data.userId);
      res.json({ success: true, data });
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

  const queryDetailRefreshes = new Map();
  const loadReportedFault = createReportedFaultLoader({
    query: order => withRecloud(connector, page => {
      const query = orderQuery(order);
      return connector.queryRmaByLogisticsNo(page, query.identifier, {
        ...query.options, revealPhoneEnabled: false, phoneRevealTimeout: 0,
        expectedRmaNo: order.rmaNo, preserveDetailPage: true,
        fastDomRead: true, skipPendingReceiptProbe: true,
      });
    }, { ...foregroundQueryOptions, totalTimeoutMs: 30000 }),
    save: (rmaNo, fault) => receiptStore.saveReportedFault(rmaNo, fault),
  });
  app.post("/api/crm/repairs/query", async (req, res, next) => {
    const queryValue = normalizeLogisticsNo(req.body?.queryValue || req.body?.logisticsNo);
    if (!queryValue) {
      return res.status(400).json({ success: false, message: "请输入物流单号、电话、SN或寄修单号" });
    }

    try {
      const user = currentUserProvider(req);
      const protectQueryFaults = (data) => protectPreReceiptFaults(data, {
        restricted: restrictFaultVisibilityForUser(user),
      });
      const allReceiptOrders = await receiptStore.readAll();
      const localOrders = await receiptStore.listOrdersForUser(user, USER_ROLES);
      const normalizedQuery = queryValue.toUpperCase();
      const phoneQuery = /^1[3-9]\d{9}$/.test(queryValue);
      const snQuery = !phoneQuery && !/^JXTH/i.test(queryValue) && !/^SF/i.test(queryValue)
        && /^[A-Z0-9]{12,}$/i.test(queryValue);
      let knownRepairOrders = allReceiptOrders;
      const withMachineHistory = (detail) => {
        const machineHistory = findMachineRepairHistory(knownRepairOrders, {
          sn: detail?.productSerialNo || detail?.sn || "",
          phone: detail?.customer?.phoneMasked || detail?.phoneMasked || detail?.phone || "",
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
      knownRepairOrders = [...new Map(
        [...cachedOrders, ...allReceiptOrders].map((order) => [order.rmaNo, order])
      ).values()];
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
          "logisticsNo", "phone", "phoneMasked", "customerName", "regionAddress", "customerAddress", "sourceCreatedAt",
          "reportedFault", "sn", "productLine", "productModel", "pickupStatus",
          "technicianName",
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
          data: protectQueryFaults({
            matches: localMatches.map((order) => withMachineHistory({
              logisticsNo: order.logisticsNo || "",
              pickupLogisticsNo: order.logisticsNo || "",
              rmaNo: order.rmaNo,
              customer: {
                name: order.customerName || "",
                phoneMasked: phoneQuery ? queryValue : order.phoneMasked || order.phone || "",
                regionAddress: order.regionAddress || "",
                customerAddress: order.customerAddress || order.regionAddress || "",
              },
              phoneMasked: phoneQuery ? queryValue : order.phoneMasked || order.phone || "",
              reportedFault: order.reportedFault || "",
              productSerialNo: order.sn || "",
              productLine: order.productLine || order.specialty || "",
              productModel: order.productModel || "",
              sourceCreatedAt: order.sourceCreatedAt || "",
              pickupStatus: order.pickupStatus || "",
              technicianName: order.technicianName || "",
              summary: [order.productModel, order.pickupStatus].filter(Boolean).join("｜"),
              localWorkflow: order,
              source: order.source || "FIELDDESK_LOCAL",
              cached: true,
            })),
            cached: true,
          }),
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
            customerAddress: order.customerAddress || order.regionAddress || "",
          },
          phoneMasked: phoneQuery ? queryValue : order.phoneMasked || order.phone || "",
          reportedFault: order.reportedFault || "",
          productSerialNo: order.sn || "",
          productLine: order.productLine || order.specialty || "",
          productModel: order.productModel || "",
          sourceCreatedAt: order.sourceCreatedAt || "",
          pickupStatus: order.pickupStatus || "",
          technicianName: order.technicianName || "",
          projectCode: order.recloudProjectCode || order.projectCode || "",
          localWorkflow: order,
          source: order.source || "FIELDDESK_LOCAL",
          phoneVerified: phoneQuery
            && phoneMatches(order.phoneMasked || order.phone, queryValue),
          cached: true,
        };
        if (localFallbackData.reportedFault && localFallbackData.productLine) {
          return res.json({ success: true, data: protectQueryFaults(withMachineHistory(localFallbackData)) });
        }
        onlineQueryValue = /^SF\d+$/i.test(String(order.logisticsNo || "").trim())
          ? order.logisticsNo
          : order.rmaNo || queryValue;
      }

      const refreshQuery = async () => {
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
            skipCompleteMetadata: true,
            revealPhoneEnabled: true,
            phoneRevealTimeout: 3000,
          });
        };
        return await queryOnline();
      }, foregroundQueryOptions);
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
      if (Array.isArray(data?.matches)) {
        const liveRows = data.matches.map((detail) => ({
          rmaNo: detail?.rmaNo || "",
          sn: detail?.productSerialNo || detail?.sn || "",
          phoneMasked: detail?.customer?.phoneMasked || detail?.phoneMasked || "",
          productLine: detail?.productLine || "",
          reportedFault: detail?.reportedFault || "",
          sourceCreatedAt: detail?.sourceCreatedAt || detail?.createdAt || "",
          technicianName: detail?.technicianName || "",
        }));
        knownRepairOrders = [...new Map(
          [...knownRepairOrders, ...liveRows].filter((order) => order.rmaNo).map((order) => [order.rmaNo, order])
        ).values()];
        data = { ...data, matches: data.matches.map(withMachineHistory) };
      } else {
        data = withMachineHistory(data);
      }
      const liveQueryStore = rmaQueryCacheStore || pendingReceiptStore;
      if (liveQueryStore) {
        const cacheOne = async (detail) => {
          if (!detail?.rmaNo) return;
          if (detail.reportedFault && typeof receiptStore.saveReportedFault === "function") {
            const saved = await receiptStore.saveReportedFault(detail.rmaNo, detail.reportedFault);
            if (saved && detail.localWorkflow) detail.localWorkflow = { ...detail.localWorkflow, reportedFault: saved.reportedFault };
          }
          await liveQueryStore.upsert({
            rmaNo: detail.rmaNo,
            logisticsNo: detail.pickupLogisticsNo || detail.logisticsNo || '',
            phone: detail.customer?.phoneMasked || detail.phoneMasked || '',
            customerName: detail.customer?.name || '',
            regionAddress: detail.customer?.regionAddress || '',
            customerAddress: detail.customer?.customerAddress || detail.customer?.regionAddress || '',
            reportedFault: detail.reportedFault || '',
            sn: detail.productSerialNo || '',
            productLine: detail.productLine || '',
            productModel: detail.productModel || '',
            sourceCreatedAt: detail.sourceCreatedAt || detail.createdAt || '',
            pickupStatus: detail.pickupStatus || '',
            technicianName: detail.technicianName || '',
            phoneVerified: detail.phoneVerified === true,
            source: 'RECLOUD_LIVE_QUERY_CACHE',
          });
        };
        if (Array.isArray(data?.matches)) await Promise.all(data.matches.map(cacheOne));
        else await cacheOne(data);
      }
      return data;
      };
      if (localFallbackData) {
        // Detail enrichment must never block a known order's lookup.
        const key = localFallbackData.rmaNo;
        if (!queryDetailRefreshes.has(key)) {
          const refresh = refreshQuery()
            .catch(error => console.warn(`RECLOUD_QUERY_ENRICHMENT: ${error.code || "FAILED"}`))
            .finally(() => queryDetailRefreshes.delete(key));
          queryDetailRefreshes.set(key, refresh);
        }
        return res.json({ success: true, data: protectQueryFaults(withMachineHistory({
          ...localFallbackData, detailRefreshPending: true,
        })) });
      }
      const data = await refreshQuery();
      return res.json({ success: true, data: protectQueryFaults(data) });
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
            logisticsNo,
            { preserveDetailPage: true }
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
            logisticsNo,
            { preserveDetailPage: true }
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
        const detail = await connector.queryRmaByLogisticsNo(page, logisticsNo, {
          preserveDetailPage: true,
        });
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
        const detail = await connector.queryRmaByLogisticsNo(page, logisticsNo, {
          preserveDetailPage: true,
        });
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
        const detail = await connector.queryRmaByLogisticsNo(page, logisticsNo, {
          preserveDetailPage: true,
        });
        const inspection = await connector.inspectRepairForm(page, {
          dryRun: true,
          writeEnabled: false,
          searchTerm: detail.rmaNo,
          inspectPartAddDialog: req.body?.inspectPartAddDialog === true,
          inspectExecutionControls: true,
          targetAssignee,
          openAssignmentDialog: Boolean(targetAssignee),
          simulateMeasureText: String(req.body?.simulateMeasureText || "").trim().slice(0, 80),
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
        await connector.queryRmaByLogisticsNo(page, logisticsNo, {
          preserveDetailPage: true,
        });
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
    if (!isRecloudReceiptWriteEnabled(runtimeEnv)) {
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
        let detail = await connector.queryRmaByLogisticsNo(
          page,
          logisticsNo,
          { preserveDetailPage: false }
        );
        const sn = requestedSn || detail.sn;
        if (!sn) throw new Error("CRM 工单没有 SN，请手动提供 SN");
        const receiptState = classifyRecloudReceiptState(detail);
        if (receiptState.receiptRequired === false) {
          return {
            ...detail,
            sn,
            receipt: {
              confirmed: true,
              skipped: true,
              message: `瑞云当前为${receiptState.label}，已跳过重复签收`,
            },
          };
        }
        if (receiptState.receiptRequired !== true) {
          throw createApiError(
            "RECLOUD_RECEIPT_STATE_UNKNOWN",
            "无法确认瑞云是否仍待签收，已停止操作以避免重复签收",
            409
          );
        }
        detail = await connector.queryRmaByLogisticsNo(
          page,
          logisticsNo,
          { preserveDetailPage: true }
        );
        const receipt = await connector.confirmSign(
          page,
          sn,
          detail.productType,
          requestedRemark,
          {
            dryRun: false,
            logisticsNo,
            productLine: detail.productLine || detail.productType,
          }
        );
        return { ...detail, sn, receipt };
      }, { ...businessWriteOptions, timeoutCode: "RECLOUD_DIRECT_RECEIPT_TIMEOUT" });
      return res.json({ success: true, data });
    } catch (error) {
      return next(error);
    }
  });

  app.post("/api/repairs/prepare-receipt", async (req, res, next) => {
    const rmaNo = String(req.body?.rmaNo || "").trim();
    let logisticsNo = normalizeLogisticsNo(req.body?.logisticsNo);
    // 查询结果同时包含寄修单号和揽收物流号。旧前端曾可能把 RMA
    // 误传到 logisticsNo；以后遇到这种情况必须从实时查询缓存纠正，
    // 不能把错误编号继续写进工单和同步任务。
    if (logisticsNo && rmaNo && logisticsNo.toUpperCase() === rmaNo.toUpperCase() && rmaQueryCacheStore) {
      const cachedOrder = (await rmaQueryCacheStore.readAll()).find((item) => item.rmaNo === rmaNo);
      const cachedLogisticsNo = normalizeLogisticsNo(cachedOrder?.logisticsNo);
      if (cachedLogisticsNo && cachedLogisticsNo.toUpperCase() !== rmaNo.toUpperCase()) {
        logisticsNo = cachedLogisticsNo;
      }
    }
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
    if (logisticsNo.toUpperCase() === rmaNo.toUpperCase()) {
      return res.status(409).json({
        success: false,
        code: "RECEIPT_LOGISTICS_RMA_CONFLICT",
        message: "物流单号不能与寄修单号相同，请重新查询后再签收",
      });
    }

    try {
      const currentUser = currentUserProvider(req);
      let reportedFault = String(req.body?.reportedFault || "").trim();
      if (!reportedFault) {
        const internalSources = [];
        if (rmaQueryCacheStore) internalSources.push(...await rmaQueryCacheStore.readAll());
        if (pendingReceiptStore) internalSources.push(...await pendingReceiptStore.readAll());
        internalSources.push(...await receiptStore.readAll());
        reportedFault = resolveReportedFault(rmaNo, internalSources);
      }
      const sn = validateReceiptSn(req.body?.sn, logisticsNo);
      const currentProjectCode = String(
        req.body?.currentProjectCode || req.body?.recloudProjectCode || ""
      ).trim();
      const authorization = currentProjectCode && typeof feishuModelCatalog.authorize === "function"
        ? await feishuModelCatalog.authorize({ sn, currentProjectCode })
        : typeof feishuModelCatalog.authorizeLocal === "function"
          ? await feishuModelCatalog.authorizeLocal({ sn })
        : typeof feishuModelCatalog.authorize === "function"
          ? await feishuModelCatalog.authorize({ sn, currentProjectCode })
        : await feishuModelCatalog.match({ sn, productLine });
      const snProductLine = SUPPORTED_REPAIR_SPECIALTIES.includes(authorization.productLine)
        ? authorization.productLine
        : "";
      const specialty = resolveReceiptSpecialty(
        currentUser,
        snProductLine || productLine,
        req.body?.specialty
      );
      const remark = specialty;
      // The query screen already captured the remote receipt snapshot. Persist
      // that snapshot locally and let the background worker re-query Recloud
      // immediately before any write. This keeps technicians moving while the
      // worker still prevents duplicate or mismatched receipt operations.
      const reportedReceiptRequired = typeof req.body?.recloudReceiptRequired === "boolean"
        ? req.body.recloudReceiptRequired
        : null;
      const verifiedReceiptState = {
        code: reportedReceiptRequired === false ? "ALREADY_RECEIVED" : reportedReceiptRequired === true ? "RECEIPT_REQUIRED" : "UNKNOWN",
        receiptRequired: reportedReceiptRequired,
        label: String(req.body?.recloudReceiptStatus || "").trim() || "状态待后台确认",
        receiptSignedAt: String(req.body?.recloudReceiptSignedAt || "").trim(),
      };
      const verifiedRemoteDetail = {
        orderStatus: String(req.body?.recloudOrderStatus || "").trim(),
        receiptStatus: verifiedReceiptState.label,
        receiptSignedAt: verifiedReceiptState.receiptSignedAt,
      };
      const data = await receiptStore.prepare({
        logisticsNo,
        rmaNo,
        sn,
        specialty,
        remark,
        productLine: snProductLine || productLine || specialty,
        customerName: String(req.body?.customerName || "").trim(),
        reportedFault,
        recloudProjectCode: currentProjectCode,
        recloudOrderStatus: verifiedRemoteDetail.orderStatus || "",
        recloudReceiptStatus: verifiedRemoteDetail.receiptStatus || verifiedReceiptState.label,
        recloudReceiptSignedAt: verifiedRemoteDetail.receiptSignedAt || verifiedReceiptState.receiptSignedAt,
        recloudReceiptRequired: verifiedReceiptState.receiptRequired,
        phoneMasked: normalizeMaskedPhone(req.body?.phoneMasked),
        regionAddress: String(req.body?.regionAddress || "").trim(),
        customerAddress: String(req.body?.customerAddress || req.body?.regionAddress || "").trim(),
        sourceCreatedAt: String(req.body?.sourceCreatedAt || "").trim(),
        productModel: String(req.body?.productModel || "").trim(),
        operatorId: currentUser.userId,
        operatorName: currentUser.displayName,
      });
      const authorizedData = await receiptStore.markModelAuthorization(
        rmaNo,
        authorization,
        currentUser
      );
      const supported = authorization.repairability === "SUPPORTED";
      const unsupported = authorization.repairability === "UNSUPPORTED";
      const responseData = {
        ...authorizedData,
        authorization,
        pricingPreparation: buildPricingPreview({
          modelRepairFees: authorization.repairFees || {},
          usedParts: [],
          warrantyStatus: "",
        }),
        message: supported
          ? "SN 已匹配下放机型，可以维修"
          : unsupported
              ? "未下放机型，需转寄总部"
              : "机型数据异常，已停止并等待人工确认",
        dryRun: true,
        recloudSynced: false,
      };
      return res.json({
        success: true,
        data: protectPreReceiptFaults(responseData, {
          restricted: restrictFaultVisibilityForUser(currentUser),
        }),
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
      const currentUser = currentUserProvider(req);
      const data = await receiptStore.cancel(
        rmaNo,
        currentUser
      );
      return res.json({
        success: true,
        data: protectPreReceiptFaults({
          ...data,
          message: "签收准备已取消，未操作瑞云",
          recloudSynced: false,
        }, { restricted: restrictFaultVisibilityForUser(currentUser) }),
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
      const currentUser = currentUserProvider(req);
      const prepared = (await receiptStore.readAll()).find((item) => item.rmaNo === rmaNo);
      if (!prepared) {
        throw createApiError("RECEIPT_PREPARATION_NOT_FOUND", "未找到本地签收准备记录", 404);
      }
      validateReceiptCompletion(prepared);
      const data = await receiptStore.completeReceipt(
        rmaNo,
        currentUser
      );
      const recloudSynced = Boolean(data.recloudReceiptConfirmedAt);
      const recloudSyncQueued = scheduleRecloudReceiptSync(
        data,
        currentUser,
        String(req.headers["idempotency-key"] || "").trim()
      );
      if (!isRecloudReceiptWriteEnabled(runtimeEnv)) {
        await enqueueRecloudNode(data, "RECEIPT", data.receiptCompletedAt || data.id);
      }
      // A supervision order may have arrived before the technician received the
      // machine. Recheck immediately after receipt so it can be routed to the
      // assigned technician without waiting for the periodic monitor tick.
      void supervisionMonitor?.pollNow?.();
      return res.json({
        success: true,
        data: {
          ...data,
          statusLabel: "已签收/待选择处理方式",
          message: recloudSynced
            ? "瑞云签收完成，请选择维修、弃修、只检测不维修或调试"
            : recloudSyncQueued
              ? "FieldDesk 签收完成，瑞云正在后台同步，请继续下一步"
              : data.recloudReceiptSyncStatus === "RESULT_UNKNOWN"
                ? "FieldDesk 签收完成，瑞云结果等待管理员核对，请继续下一步"
                : "演示签收完成，请选择维修、弃修、只检测不维修或调试",
          recloudSynced,
          recloudReceiptSyncStatus: recloudSynced
            ? "CONFIRMED"
            : recloudSyncQueued
              ? "PENDING"
              : data.recloudReceiptSyncStatus || "LOCAL_ONLY",
        },
      });
    } catch (error) {
      return next(error);
    }
  });

  app.post("/api/repairs/treatment-decision", async (req, res, next) => {
    const rmaNo = String(req.body?.rmaNo || "").trim();
    const treatmentMode = String(req.body?.treatmentMode || "").trim();
    const inspectionFaultOutcome = String(req.body?.inspectionFaultOutcome || "").trim();
    const decisions = {
      REPAIR: { label: "维修", detectionResult: "维修", nextStep: "partsApplication" },
      ABANDONED: { label: "弃修", detectionResult: "弃修", nextStep: "partsApplication" },
      INSPECTION_ONLY: { label: "只检测不维修", detectionResult: "只检测不维修", nextStep: "repairProcess" },
      DEBUGGING: { label: "调试", detectionResult: "维修", nextStep: "repairProcess" },
      ON_HOLD: { label: "暂存", detectionResult: "", nextStep: "home" },
    };
    if (!rmaNo) return next(createApiError("TREATMENT_DECISION_INVALID", "缺少必填字段：rmaNo", 400));
    if (!decisions[treatmentMode]) return next(createApiError("TREATMENT_MODE_INVALID", "请选择维修、弃修、只检测不维修、调试或暂存", 400));
    if (treatmentMode === "INSPECTION_ONLY" && !["FAULT_REPRODUCED", "NO_FAULT"].includes(inspectionFaultOutcome)) {
      return next(createApiError("INSPECTION_FAULT_OUTCOME_REQUIRED", "只检测不维修必须选择故障复现或无故障", 400));
    }
    try {
      const order = (await receiptStore.readAll()).find((item) => item.rmaNo === rmaNo);
      if (!order) throw createApiError("RECEIPT_PREPARATION_NOT_FOUND", "未找到已签收工单", 404);
      const warranty = evaluateWarranty({
        sn: order.sn,
        purchaseDate: order.purchaseDate,
        warrantyYears: order.modelAuthorization?.warrantyYears || 2,
        isOfficialRefurbished: order.modelAuthorization?.isOfficialRefurbished === true,
      });
      const effectiveWarranty = resolveConfirmedWarranty(order, warranty);
      if (treatmentMode === "ABANDONED" && effectiveWarranty.status !== "DETERMINED") {
        throw createApiError("WARRANTY_STATUS_REQUIRED", "暂时无法判断是否保外，确认质保状态后才能选择弃修", 409);
      }
      if (treatmentMode === "ABANDONED" && effectiveWarranty.warrantyStatus !== "保外") {
        throw createApiError("IN_WARRANTY_ABANDONMENT_NOT_ALLOWED", "该机器在保内，无需付费，不能选择弃修", 409);
      }
      const holdInput = treatmentMode === "ON_HOLD"
        ? validateHoldInput({ category: req.body?.holdCategory, reason: req.body?.holdReason, remark: req.body?.holdRemark })
        : null;
      const decision = decisions[treatmentMode];
      const nextStep = treatmentMode === "INSPECTION_ONLY" && inspectionFaultOutcome === "FAULT_REPRODUCED"
        ? "partsApplication"
        : decision.nextStep;
      const data = await receiptStore.saveTreatmentDecision(rmaNo, {
        treatmentMode,
        inspectionFaultOutcome,
        detectionResult: decision.detectionResult,
        technicianWarranty: effectiveWarranty.status === "DETERMINED" ? effectiveWarranty.warrantyStatus : "",
        warrantyDecision: order.warrantyDecision || warranty,
        ...(holdInput ? { holdCategory: holdInput.category, holdReason: holdInput.reason, holdRemark: holdInput.remark } : {}),
      }, currentUserProvider(req));
      if (treatmentMode === "ABANDONED") {
        scheduleFreightWaiverApplicationRefresh(data, currentUserProvider(req));
      }
      const holdSyncQueued = treatmentMode === "ON_HOLD"
        ? scheduleRecloudHoldSync(data, currentUserProvider(req))
        : false;
      return res.json({
        success: true,
        data: {
          ...data,
          nextStep,
          message: treatmentMode === "ON_HOLD"
            ? holdSyncQueued
              ? "本单已暂存，瑞云滞留正在后台同步"
              : "本单已暂存；瑞云滞留同步未启用，请管理员处理"
            : treatmentMode === "INSPECTION_ONLY" && inspectionFaultOutcome === "FAULT_REPRODUCED"
              ? "已选择只检测不维修（故障复现），下一步登记故障配件；仅保存到 FieldDesk，不向瑞云添加配件"
            : ["REPAIR", "ABANDONED"].includes(treatmentMode)
            ? treatmentMode === "ABANDONED" ? "已选择弃修，下一步登记故障配件报价" : "已选择维修，下一步申请配件"
            : `已选择${decision.label}，下一步登记故障分类并完成检测`,
          recloudDetectionResult: decision.detectionResult,
          recloudDetectionPending: false,
          holdSyncQueued,
        },
      });
    } catch (error) { return next(error); }
  });

  app.get("/api/repairs/hold-reasons", (_req, res) => {
    res.json({ success: true, data: { source: "LOCAL_MIRROR", groups: RECLOUD_HOLD_REASON_GROUPS } });
  });

  app.post("/api/repairs/hold/reconcile", async (req, res, next) => {
    const rmaNo = String(req.body?.rmaNo || "").trim();
    let owned = false;
    try {
      const user = currentUserProvider(req);
      if (!hasBusinessRole(user, USER_ROLES.ADMIN)) throw createApiError("HOLD_RECONCILIATION_FORBIDDEN", "请由管理员或负责人核对暂存", 403);
      const order = (await receiptStore.readAll()).find(item => item.rmaNo === rmaNo);
      if (order?.status !== "ON_HOLD" || !["RESULT_UNKNOWN", "SUBMITTING", "FAILED"].includes(order.hold?.status)) {
        throw createApiError("HOLD_RECONCILIATION_STATE_INVALID", "当前暂存不需要核对", 409);
      }
      if (activeHoldSyncs.has(rmaNo)) throw createApiError("HOLD_RECONCILIATION_BUSY", "暂存仍在执行，请稍后核对", 409);
      if (typeof connector.readRmaHoldSnapshot !== "function") throw createApiError("HOLD_RECONCILIATION_UNAVAILABLE", "暂存核对不可用", 503);
      activeHoldSyncs.add(rmaNo); owned = true;
      const snapshot = await withRecloud(connector, async page => {
        const detail = await connector.queryRmaByLogisticsNo(page, order.logisticsNo || rmaNo, { preserveDetailPage: true });
        if (detail.rmaNo !== rmaNo) throw createApiError("HOLD_RECONCILIATION_ORDER_MISMATCH", "瑞云查询工单不一致", 409);
        return connector.readRmaHoldSnapshot(page, rmaNo);
      }, { totalTimeoutMs: 45000, timeoutCode: "HOLD_RECONCILIATION_TIMEOUT" });
      const data = await receiptStore.reconcileRecloudHold(rmaNo, order.hold, snapshot, user);
      res.json({ success: true, data });
    } catch (error) { next(error); }
    finally { if (owned) activeHoldSyncs.delete(rmaNo); }
  });

  app.post("/api/repairs/hold/retry", async (req, res, next) => {
    try {
      const user = currentUserProvider(req);
      if (!hasBusinessRole(user, USER_ROLES.TECHNICIAN, USER_ROLES.INFORMATION_CLERK, USER_ROLES.ADMIN)) {
        throw createApiError("RECLOUD_HOLD_RETRY_FORBIDDEN", "当前账号不能重试暂存同步", 403);
      }
      const rmaNo = String(req.body?.rmaNo || "").trim();
      const order = (await receiptStore.readAll()).find((item) => item.rmaNo === rmaNo);
      if (!order?.hold) throw createApiError("HOLD_NOT_FOUND", "未找到暂存记录", 404);
      if (!hasBusinessRole(user, USER_ROLES.ADMIN, USER_ROLES.INFORMATION_CLERK)
        && ![order.operatorId, order.technicianId].includes(user.userId)) {
        throw createApiError("RECLOUD_HOLD_RETRY_FORBIDDEN", "只能重试本人负责的暂存工单", 403);
      }
      if (!isRecloudHoldWriteEnabled(runtimeEnv)) throw createApiError("RECLOUD_HOLD_DISABLED", "瑞云暂存同步未启用", 409);
      if (["SUBMITTING", "RESULT_UNKNOWN"].includes(order.hold.status)) throw createApiError("RECLOUD_HOLD_RESULT_UNKNOWN", "暂存正在执行或结果未确认，请先核对瑞云，勿重复提交", 409);
      const queued = scheduleRecloudHoldSync(order, user, { manualRetry: true });
      res.json({ success: true, data: { queued, message: queued ? "瑞云滞留已进入后台重试" : "当前暂存无需重试或正在执行" } });
    } catch (error) { next(error); }
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

  app.post("/api/admin/recloud/receipt-attachments/retry", async (req, res, next) => {
    try {
      const user = currentUserProvider(req);
      if (!hasBusinessRole(user, USER_ROLES.ADMIN, USER_ROLES.INFORMATION_CLERK)) {
        throw createApiError("RECLOUD_ATTACHMENT_RETRY_FORBIDDEN", "只有管理员或信息员可以重试瑞云签收照片", 403);
      }
      const rmaNo = String(req.body?.rmaNo || "").trim();
      if (!rmaNo) throw createApiError("RECEIPT_PREPARATION_INVALID", "缺少必填字段：rmaNo", 400);
      const order = (await receiptStore.readAll()).find((item) => item.rmaNo === rmaNo);
      if (!order) throw createApiError("RECEIPT_PREPARATION_NOT_FOUND", "未找到本地签收准备记录", 404);
      if (!(order.receiptAttachments || []).length) {
        throw createApiError("RECEIPT_ATTACHMENT_REQUIRED", "该工单没有可同步的签收照片", 409);
      }
      if (!order.recloudReceiptConfirmedAt) {
        throw createApiError("RECLOUD_RECEIPT_NOT_CONFIRMED", "请先核实瑞云签收状态，再单独重试照片", 409);
      }
      const queued = scheduleRecloudReceiptSync(order, user, crypto.randomUUID());
      return res.json({
        success: true,
        data: {
          rmaNo,
          queued,
          message: queued ? "签收照片已进入后台同步" : "签收照片无需同步或已有任务执行中",
        },
      });
    } catch (error) { return next(error); }
  });

  app.post('/api/repairs/admin/reconcile-receipt-attachments', async (req, res, next) => {
    const rmaNo = String(req.body?.rmaNo || '').trim(); let owned = false;
    try {
      const user = currentUserProvider(req);
      if (!hasBusinessRole(user, USER_ROLES.ADMIN)) throw createApiError('RECEIPT_ATTACHMENT_FORBIDDEN', '请由管理员或负责人核对附件', 403);
      const order = (await receiptStore.readAll()).find(item => item.rmaNo === rmaNo);
      if (!order?.recloudReceiptConfirmedAt || order.recloudReceiptAttachmentConfirmedAt
        || !['FAILED', 'RESULT_UNKNOWN'].includes(order.recloudReceiptAttachmentSyncStatus)) throw createApiError('RECEIPT_ATTACHMENT_STATE_INVALID', '当前附件不需要核对', 409);
      if (activeReceiptSyncs.has(rmaNo)) throw createApiError('RECEIPT_ATTACHMENT_BUSY', '该单仍在同步，请稍后核对', 409);
      if (typeof connector.readRmaReceiptAttachmentSnapshot !== 'function') throw createApiError('RECEIPT_ATTACHMENT_UNAVAILABLE', '附件核对不可用', 503);
      activeReceiptSyncs.add(rmaNo); owned = true;
      const hydrated = await Promise.all((order.receiptAttachments || []).map(async file => ({ ...file, buffer: await receiptAttachmentStore.read(rmaNo, file) })));
      const files = require('./services/receipt-attachment-identity').receiptUploadFiles(rmaNo, hydrated);
      const snapshot = await withRecloud(connector, async page => {
        const query = orderQuery(order);
        const detail = await connector.queryRmaByLogisticsNo(page, query.identifier, { ...query.options, preserveDetailPage: true });
        if (detail.rmaNo !== rmaNo) throw createApiError('RECEIPT_ATTACHMENT_ORDER_MISMATCH', '瑞云工单不一致', 409);
        return connector.readRmaReceiptAttachmentSnapshot(page, rmaNo);
      }, { totalTimeoutMs: 45000, timeoutCode: 'RECEIPT_ATTACHMENT_TIMEOUT' });
      res.json({ success: true, data: await receiptStore.reconcileReceiptAttachments(order, files, snapshot, user) });
    } catch (error) { next(error); }
    finally { if (owned) activeReceiptSyncs.delete(rmaNo); }
  });

  app.post("/api/repairs/admin/reconcile-receipt", async (req, res, next) => {
    const rmaNo = String(req.body?.rmaNo || '').trim(); let owned = false;
    try {
      const user = currentUserProvider(req);
      if (!hasBusinessRole(user, USER_ROLES.ADMIN)) throw createApiError('RECEIPT_RECONCILIATION_FORBIDDEN', '请由管理员或负责人核对签收', 403);
      const order = (await receiptStore.readAll()).find(item => item.rmaNo === rmaNo);
      if (!order || !['RESULT_UNKNOWN', 'FAILED'].includes(order.recloudReceiptSyncStatus) || order.recloudReceiptConfirmedAt) throw createApiError('RECEIPT_RECONCILIATION_STATE_INVALID', '当前签收不需要核对', 409);
      if (activeReceiptSyncs.has(rmaNo)) throw createApiError('RECEIPT_RECONCILIATION_BUSY', '该单仍在同步，请稍后核对', 409);
      if (typeof connector.readRmaReceiptSnapshot !== 'function') throw createApiError('RECEIPT_RECONCILIATION_UNAVAILABLE', '签收核对不可用', 503);
      activeReceiptSyncs.add(rmaNo); owned = true;
      const snapshot = await withRecloud(connector, async page => {
        const query = orderQuery(order);
        const detail = await connector.queryRmaByLogisticsNo(page, query.identifier, { ...query.options, preserveDetailPage: true });
        if (detail.rmaNo !== rmaNo) throw createApiError('RECEIPT_RECONCILIATION_ORDER_MISMATCH', '瑞云工单不一致', 409);
        return connector.readRmaReceiptSnapshot(page, rmaNo);
      }, { totalTimeoutMs: 45000, timeoutCode: 'RECEIPT_RECONCILIATION_TIMEOUT' });
      const data = await receiptStore.reconcileReceiptFromSnapshot(order, snapshot, user);
      res.json({ success: true, data });
    } catch (error) { next(error); }
    finally { if (owned) activeReceiptSyncs.delete(rmaNo); }
  });

  app.post("/api/repairs/recloud-receipt/reconcile-confirmed", async (req, res, next) => {
    try {
      const user = currentUserProvider(req);
      const rmaNo = String(req.body?.rmaNo || "").trim();
      const order = (await receiptStore.readAll()).find(item => item.rmaNo === rmaNo);
      if (!order) throw createApiError("RECEIPT_PREPARATION_NOT_FOUND", "未找到本地工单", 404);
      if (!hasBusinessRole(user, USER_ROLES.ADMIN)
        && ![order.operatorId, order.technicianId].includes(user.userId)) {
        throw createApiError("RECLOUD_RECEIPT_RETRY_FORBIDDEN", "只能核对自己的瑞云签收工单", 403);
      }
      if (req.body.confirmedSigned !== true || String(req.body.sn || "").trim() !== order.sn) {
        throw createApiError("RECEIPT_RECONCILIATION_CONFIRM_REQUIRED", "请核对瑞云对应SN行已签收后确认", 409);
      }
      if (!order.recloudReceiptConfirmedAt && order.recloudReceiptSyncStatus !== "RESULT_UNKNOWN") {
        throw createApiError("RECEIPT_RECONCILIATION_STATE_INVALID", "仅可核对结果未知的签收", 409);
      }
      const updated = await receiptStore.markRecloudReceiptConfirmed(rmaNo, {
        operator: user, receipt: { message: "人工核对对应SN行已签收，恢复后续同步" },
      });
      const queued = scheduleRecloudReceiptSync(updated, user, crypto.randomUUID());
      res.json({ success: true, data: { rmaNo, queued, message: queued ? "已核实签收，后续同步已恢复" : "已核实签收，后续同步等待执行" } });
    } catch (error) { next(error); }
  });

  app.post("/api/repairs/recloud-receipt/retry", async (req, res, next) => {
    try {
      const user = currentUserProvider(req);
      const rmaNo = String(req.body?.rmaNo || "").trim();
      if (!rmaNo) throw createApiError("RECEIPT_PREPARATION_INVALID", "缺少必填字段：rmaNo", 400);
      let order = (await receiptStore.readAll()).find((item) => item.rmaNo === rmaNo);
      if (!order) throw createApiError("RECEIPT_PREPARATION_NOT_FOUND", "未找到本地签收准备记录", 404);
      const ownsOrder = [order.operatorId, order.technicianId]
        .map((value) => String(value || "").trim())
        .includes(String(user.userId || "").trim());
      if (!ownsOrder && !hasBusinessRole(user, USER_ROLES.ADMIN)) {
        throw createApiError("RECLOUD_RECEIPT_RETRY_FORBIDDEN", "只能重试自己的瑞云签收工单", 403);
      }
      if (order.recloudReceiptResult?.skipped === true) {
        order = await receiptStore.resetFalseSkippedRecloudReceipt(rmaNo, user);
      } else if (order.recloudReceiptConfirmedAt) {
        throw createApiError("RECLOUD_RECEIPT_ALREADY_CONFIRMED", "瑞云签收已经确认，禁止重复提交", 409);
      }
      if (order.recloudReceiptSyncStatus === "RESULT_UNKNOWN") {
        throw createApiError("RECLOUD_RECEIPT_RECONCILIATION_REQUIRED", "瑞云签收结果未知，请先人工核对", 409);
      }
      const queued = scheduleRecloudReceiptSync(order, user, crypto.randomUUID());
      return res.json({
        success: true,
        data: {
          rmaNo,
          queued,
          message: queued ? "瑞云签收已进入安全重试" : "当前没有可重试的瑞云签收任务",
        },
      });
    } catch (error) { return next(error); }
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
      if (order.treatmentMode === "REPAIR" && (!(order.partApplications || []).length || !order.partsConfirmedAt)) {
        throw createApiError("REPAIR_PARTS_NOT_CONFIRMED", "请先添加并确认维修配件，再进行故障分类和检测", 409);
      }
      const warranty = evaluateWarranty({
        sn: order.sn,
        purchaseDate: order.purchaseDate,
        warrantyYears: order.modelAuthorization?.warrantyYears || 2,
        isOfficialRefurbished: order.modelAuthorization?.isOfficialRefurbished === true,
      });
      const effectiveWarranty = resolveConfirmedWarranty(order, warranty);
      if (effectiveWarranty.status !== "DETERMINED") {
        throw createApiError("WARRANTY_MANUAL_CONFIRMATION_REQUIRED", warranty.reason || "质保状态无法自动判断，需人工确认", 409);
      }
      const decision = buildInspectionFormDecision({
        faultCategory: req.body?.faultCategory,
        technicianWarranty: req.body?.technicianWarranty,
        snWarranty: effectiveWarranty.warrantyStatus,
        detectionResult: req.body?.inspectionResult,
        treatmentMode: order.treatmentMode,
        inspectionFaultOutcome: order.inspectionFaultOutcome,
      });
      if (decision.status !== "READY") {
        throw createApiError(
          decision.status === "MANUAL_CONFIRMATION_REQUIRED" ? "WARRANTY_MISMATCH" : "INSPECTION_FORM_INVALID",
          decision.reason || `检测必填项不完整：${(decision.missingFields || []).join(", ")}`,
          decision.status === "MANUAL_CONFIRMATION_REQUIRED" ? 409 : 400
        );
      }
      const recloudWriteEnabled = isRecloudInspectionWriteEnabled(runtimeEnv);
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
          inspectionFaultOutcome: order.inspectionFaultOutcome,
          faultContent: decision.fields.faultContent,
          originalConsumables: decision.fields.originalConsumables,
          consumableName: decision.fields.consumableName,
          dismantled: decision.fields.dismantled,
          recloudDetectionSyncStatus: recloudWriteEnabled ? "PENDING" : "NOT_STARTED",
        },
        currentUserProvider(req)
      );
      const recloudSyncQueued = recloudWriteEnabled
        ? scheduleRecloudDetectionSync(data, currentUserProvider(req))
        : false;
      if (!recloudWriteEnabled) {
        await enqueueRecloudNode(data, "INSPECTION_COMPLETED", data.inspectionUpdatedAt || data.id);
      }
      const recloudPrefillPlan = buildRecloudInspectionFormPlan({
        treatmentMode: data.treatmentMode,
        faultCategory: data.faultCategory,
        warrantyStatus: data.technicianWarranty,
        detectionResult: data.detectionResult,
        reportedFault: data.reportedFault,
        faultContent: data.faultContent || resolveFaultContent(data),
      });
      return res.json({
        success: true,
        data: {
          ...data,
          recloudPrefillPlan,
          message: recloudSyncQueued
            ? "FieldDesk 检测已保存，瑞云正在后台检测；可继续处理其他工单"
            : data.recloudDetectionConfirmedAt
              ? "瑞云检测已确认，可立即进入下一步"
              : "检测信息已保存到 FieldDesk；请按瑞云预填清单人工核对后确认",
          recloudWriteEnabled,
          recloudSynced: Boolean(data.recloudDetectionConfirmedAt),
          recloudDetectionSyncStatus: recloudSyncQueued
            ? "PENDING"
            : data.recloudDetectionSyncStatus || "NOT_STARTED",
          recloudResult: null,
        },
      });
    } catch (error) {
      return next(error);
    }
  });

  app.post("/api/repairs/start-repair", async (req, res, next) => {
    try {
      const rmaNo = String(req.body?.rmaNo || "").trim();
      if (!rmaNo) throw createApiError("REPAIR_START_INVALID", "缺少必填字段：rmaNo", 400);
      const order = (await receiptStore.readAll()).find((item) => item.rmaNo === rmaNo);
      if (!order) throw createApiError("RECEIPT_PREPARATION_NOT_FOUND", "未找到待维修工单", 404);
      const createsRecloudServiceOrder = ["REPAIR", "DEBUGGING", "ABANDONED", "INSPECTION_ONLY"].includes(order.treatmentMode);
      if (!createsRecloudServiceOrder) throw createApiError("REPAIR_START_NOT_REQUIRED", "当前处理方式无需创建维修服务单", 409);
      if (!order.inspectionUpdatedAt) throw createApiError("INSPECTION_REQUIRED", "请先完成检测", 409);
      const recloudWriteEnabled = isRecloudInspectionWriteEnabled(runtimeEnv);
      if (recloudWriteEnabled && !order.recloudDetectionConfirmedAt
        && ["FAILED", "SYNCING"].includes(order.recloudDetectionSyncStatus)) {
        scheduleRecloudDetectionSync(order, currentUserProvider(req));
      }
      if (
        recloudWriteEnabled &&
        !options.recloudRepairPageAdapterFactory &&
        !options.recloudRepairAdapterProvider?.open
      ) {
        throw createApiError(
          "RECLOUD_REPAIR_EXECUTOR_NOT_CONFIGURED",
          "瑞云维修执行器尚未接入，已阻止进入维修，避免出现 FieldDesk 已进入但瑞云未操作",
          503
        );
      }
      const operator = currentUserProvider(req);
      const recloudTechnician = resolveRecloudTechnician(operator, {
        defaultFallbackAssignee: runtimeEnv.RECLOUD_DEFAULT_FALLBACK_ASSIGNEE,
      });
      const appliedParts = order.treatmentMode === "REPAIR"
        ? (await hydratePartApplications(order)).map((part) => ({
          partCode: part.partCode,
          partName: part.partName,
          quantity: part.quantity,
          repairLevel: part.repairLevel,
          returnRequired: Boolean(part.returnRequired),
        }))
        : [];
      const usedParts = order.treatmentMode === "REPAIR"
        ? (appliedParts.length
          ? appliedParts
          : await inventoryStore.usedPartsForOrder(order.rmaNo, order.sn))
        : [];
      const repairPreparation = {
        fieldDeskUserId: recloudTechnician.fieldDeskUserId,
        fieldDeskDisplayName: recloudTechnician.fieldDeskDisplayName,
        assignee: recloudTechnician.servicePerson,
        assignmentSource: recloudTechnician.source,
        warrantyConversionRequested: order.treatmentMode === "REPAIR"
          && order.manufacturerWarrantyConversion?.requested === true,
        usedParts,
        capturedAt: new Date().toISOString(),
      };
      const data = await receiptStore.startRepair(rmaNo, {
        recloudSynced: Boolean(order.recloudServiceOrderCreatedAt),
        recloudSyncStatus: recloudWriteEnabled ? "PENDING" : "NOT_STARTED",
        repairPreparation,
      }, operator);
      const waitingForDetection = recloudWriteEnabled && !data.recloudDetectionConfirmedAt;
      const recloudSyncQueued = recloudWriteEnabled && !waitingForDetection
        ? scheduleRecloudServiceOrderSync(data, operator)
        : false;
      res.json({
        success: true,
        data: {
          ...data,
          nextStep: "repairCompletion",
          recloudResult: null,
          recloudServiceOrderSyncStatus: recloudSyncQueued
            ? "PENDING"
            : data.recloudServiceOrderSyncStatus || "NOT_STARTED",
          message: recloudSyncQueued
            ? "已进入维修，瑞云服务单正在后台创建"
            : waitingForDetection
              ? "已进入下一步；瑞云检测完成后将自动创建维修服务单"
            : data.recloudServiceOrderCreatedAt
              ? "瑞云维修服务单已创建，进入维修"
              : "演示模式：已进入维修，未操作瑞云",
        },
      });
    } catch (error) { next(error); }
  });

  // Pure local check: never schedules Recloud writes or recreates an order.
  app.get("/api/repairs/:rmaNo/local-state", async (req, res, next) => {
    try {
      const rmaNo = String(req.params.rmaNo || "").trim();
      const user = currentUserProvider(req);
      const order = (await receiptStore.readAll()).find(item => item.rmaNo === rmaNo);
      if (order && !hasBusinessRole(user, USER_ROLES.ADMIN, USER_ROLES.WAREHOUSE)
        && ![order.technicianId, order.operatorId].includes(user.userId)) {
        throw createApiError("REPAIR_SYNC_STATUS_FORBIDDEN", "只能查看本人负责工单", 403);
      }
      res.json({ success: true, data: { rmaNo, exists: Boolean(order) } });
    } catch (error) { next(error); }
  });

  app.get("/api/repairs/:rmaNo/sync-status", async (req, res, next) => {
    try {
      const rmaNo = String(req.params?.rmaNo || "").trim();
      const user = currentUserProvider(req);
      const order = (await receiptStore.readAll()).find((item) => item.rmaNo === rmaNo);
      if (!order) throw createApiError("RECEIPT_PREPARATION_NOT_FOUND", "未找到待维修工单", 404);
      const privileged = hasBusinessRole(user, USER_ROLES.ADMIN, USER_ROLES.WAREHOUSE);
      if (!privileged && ![order.technicianId, order.operatorId].includes(user.userId)) {
        throw createApiError("REPAIR_SYNC_STATUS_FORBIDDEN", "只能查看本人负责工单的同步状态", 403);
      }
      if (
        order.recloudDetectionConfirmedAt
        && !order.recloudServiceOrderCreatedAt
        && order.recloudServiceOrderSyncStatus === "FAILED"
        && order.recloudRepairPreparation?.status === "PENDING"
      ) {
        scheduleRecloudServiceOrderSync(order, user);
      }
      res.json({
        success: true,
        data: {
          rmaNo,
          sn: order.sn,
          recloudWriteEnabled: isRecloudInspectionWriteEnabled(runtimeEnv),
          recloudReceiptSyncStatus: order.recloudReceiptSyncStatus || "NOT_STARTED",
          recloudReceiptConfirmedAt: order.recloudReceiptConfirmedAt || "",
          recloudReceiptLastError: order.recloudReceiptLastError || null,
          recloudProjectVerificationStatus: order.recloudProjectVerificationStatus || "NOT_STARTED",
          recloudProjectVerificationConfirmedAt: order.recloudProjectVerificationConfirmedAt || "",
          recloudProjectVerificationLastError: order.recloudProjectVerificationLastError || null,
          recloudReceiptAttachmentSyncStatus: order.recloudReceiptAttachmentSyncStatus || "NOT_STARTED",
          recloudReceiptAttachmentConfirmedAt: order.recloudReceiptAttachmentConfirmedAt || "",
          recloudReceiptAttachmentLastError: order.recloudReceiptAttachmentLastError || null,
          recloudDetectionSyncStatus: order.recloudDetectionSubmissionStartedAt && !order.recloudDetectionConfirmedAt
            ? "RESULT_UNKNOWN" : order.recloudDetectionSyncStatus || "NOT_STARTED",
          recloudDetectionConfirmedAt: order.recloudDetectionConfirmedAt || "",
          recloudDetectionLastError: order.recloudDetectionLastError || null,
          recloudServiceOrderSyncStatus: order.recloudServiceOrderSyncStatus || "NOT_STARTED",
          recloudServiceOrderAttemptedAt: order.recloudServiceOrderAttemptedAt || "",
          recloudServiceOrderCreatedAt: order.recloudServiceOrderCreatedAt || "",
          recloudServiceOrderLastError: order.recloudServiceOrderLastError || null,
          recloudRepairPreparationStatus: order.recloudRepairPreparation?.status || "NOT_STARTED",
          recloudRepairPreparationLastError: order.recloudRepairPreparation?.lastError || null,
          recloudRepairPreparationCanComplete:
            order.recloudRepairPreparation?.status === "CONFIRMED"
            || order.recloudRepairPreparation?.status === "PARTS_SHORTAGE",
          updatedAt: order.updatedAt || "",
        },
      });
    } catch (error) { next(error); }
  });

  app.post("/api/repairs/:rmaNo/recloud-preparation/retry", async (req, res, next) => {
    try {
      const rmaNo = String(req.params?.rmaNo || "").trim();
      const user = currentUserProvider(req);
      const order = (await receiptStore.readAll()).find((item) => item.rmaNo === rmaNo);
      if (!order) throw createApiError("RECEIPT_PREPARATION_NOT_FOUND", "未找到待恢复工单", 404);
      const privileged = hasBusinessRole(user, USER_ROLES.ADMIN, USER_ROLES.WAREHOUSE);
      if (!privileged && ![order.technicianId, order.operatorId].includes(user.userId)) {
        throw createApiError("REPAIR_PREPARATION_RETRY_FORBIDDEN", "只能恢复本人负责的瑞云维修单", 403);
      }
      if (!order.recloudServiceOrderCreatedAt || !order.recloudServiceOrderNo) {
        throw createApiError("RECLOUD_REPAIR_RECOVERY_CONTEXT_MISSING", "当前工单没有可恢复的瑞云维修单", 409);
      }
      const queued = scheduleRecloudServiceOrderSync(order, user, {
        forcePreparationRecovery: true,
        retryCompletionAfterPreparation: true,
      });
      if (!queued) throw createApiError("RECLOUD_REPAIR_RECOVERY_BUSY", "该工单正在恢复，请稍候", 409);
      res.json({ success: true, data: { rmaNo, queued: true, message: "已从瑞云维修准备节点继续恢复" } });
    } catch (error) { next(error); }
  });

  app.post("/api/admin/recloud/service-order/reconcile-not-created", async (req, res, next) => {
    try {
      const rmaNo = String(req.body?.rmaNo || "").trim();
      const user = currentUserProvider(req);
      if (!hasBusinessRole(user, USER_ROLES.ADMIN)) {
        throw createApiError("RECLOUD_SERVICE_ORDER_RECONCILE_FORBIDDEN", "只有管理员可以核对维修服务单未创建", 403);
      }
      if (!rmaNo || req.body?.confirmedNotCreated !== true) {
        throw createApiError("RECLOUD_SERVICE_ORDER_RECONCILE_CONFIRMATION_REQUIRED", "必须明确确认瑞云维修单号为空", 400);
      }
      const order = (await receiptStore.readAll()).find((item) => item.rmaNo === rmaNo);
      if (!order) throw createApiError("RECEIPT_PREPARATION_NOT_FOUND", "未找到待恢复工单", 404);
      if (order.recloudServiceOrderSyncStatus !== "RESULT_UNKNOWN") {
        throw createApiError("RECLOUD_SERVICE_ORDER_RECONCILE_NOT_REQUIRED", "当前维修服务单不需要人工核对", 409);
      }
      const reconciled = await receiptStore.reconcileRecloudServiceOrderNotCreated(rmaNo, user);
      serviceOrderRecoveryAttempts.delete(rmaNo);
      serviceOrderRecoveryNextAt.delete(rmaNo);
      const queued = scheduleRecloudServiceOrderSync(reconciled, user);
      if (!queued) throw createApiError("RECLOUD_SERVICE_ORDER_RETRY_BUSY", "维修服务单恢复任务暂未进入队列", 409);
      res.json({ success: true, data: { rmaNo, queued: true, message: "已确认瑞云维修单未创建，后台正在安全重试" } });
    } catch (error) { next(error); }
  });

  app.get("/api/repairs/my-sync-alerts", async (req, res, next) => {
    try {
      const user = currentUserProvider(req);
      const orders = await receiptStore.listOrdersForUser(user, USER_ROLES);
      for (const order of orders) {
        const preparationError = String(order.recloudRepairPreparation?.lastError?.message || "");
        const preparationErrorCode = String(order.recloudRepairPreparation?.lastError?.code || "");
        const recoverablePreparationFailure =
          /intercepts pointer events|waiting for getByRole\('button'.*改派/s.test(preparationError);
        if (
          order.recloudServiceOrderCreatedAt
          && order.recloudServiceOrderNo
          && order.recloudRepairPreparation?.status === "FAILED"
          && recoverablePreparationFailure
        ) scheduleRecloudServiceOrderSync(order, user);
      }
      const now = Date.now();
      const failureStatuses = new Set(["FAILED", "RESULT_UNKNOWN", "MANUAL_REVIEW"]);
      const activeStatuses = new Set(["PENDING", "SYNCING", "PROCESSING"]);
      const alerts = [];
      const stages = [
        ["RECEIPT", "瑞云签收", "recloudReceiptSyncStatus", "recloudReceiptLastError", "recloudReceiptAttemptedAt", 90_000],
        ["PROJECT", "项目号核对", "recloudProjectVerificationStatus", "recloudProjectVerificationLastError", "recloudProjectVerificationAttemptedAt", 120_000],
        ["RECEIPT_ATTACHMENTS", "签收附件", "recloudReceiptAttachmentSyncStatus", "recloudReceiptAttachmentLastError", "recloudReceiptAttachmentAttemptedAt", 180_000],
        ["DETECTION", "检测提交", "recloudDetectionSyncStatus", "recloudDetectionLastError", "recloudDetectionAttemptedAt", 120_000],
        ["SERVICE_ORDER", "进入维修", "recloudServiceOrderSyncStatus", "recloudServiceOrderLastError", "recloudServiceOrderAttemptedAt", 120_000],
      ];
      for (const order of orders) {
        // Local completion does not prove that the remote steps succeeded.
        if (["CANCELLED", "DELETED"].includes(order.status)) continue;
        for (const [stage, stageLabel, statusKey, errorKey, attemptedAtKey, stalledAfterMs] of stages) {
          const status = stage === "DETECTION" && order.recloudDetectionSubmissionStartedAt && !order.recloudDetectionConfirmedAt
            ? "RESULT_UNKNOWN" : String(order?.[statusKey] || "NOT_STARTED").trim().toUpperCase();
          const attemptedAt = String(order?.[attemptedAtKey] || order?.updatedAt || "").trim();
          const attemptedMs = Date.parse(attemptedAt);
          const stalled = activeStatuses.has(status)
            && Number.isFinite(attemptedMs)
            && now - attemptedMs >= stalledAfterMs;
          if (!failureStatuses.has(status) && !stalled) continue;
          const lastError = order?.[errorKey] || null;
          alerts.push({
            id: `${order.rmaNo}:${stage}`,
            rmaNo: order.rmaNo,
            logisticsNo: order.logisticsNo || "",
            userId: order.technicianId || order.operatorId || "",
            stage,
            stageLabel,
            status: stalled ? "STALLED" : status,
            message: stalled
              ? `${stageLabel}超过${Math.round(stalledAfterMs / 1000)}秒没有完成，请查看同步状态`
              : status === "RESULT_UNKNOWN"
                ? `${stageLabel}结果未知，需核对瑞云，不能重复提交`
                : String(lastError?.message || `${stageLabel}失败，请查看处理`),
            errorCode: String(lastError?.code || ""),
            updatedAt: String(lastError?.at || attemptedAt || order.updatedAt || ""),
          });
        }
        const preparation = order.recloudRepairPreparation;
        if (preparation && failureStatuses.has(String(preparation.status || "").toUpperCase())) {
          alerts.push({
            id: `${order.rmaNo}:REPAIR_PREPARATION`,
            rmaNo: order.rmaNo,
            logisticsNo: order.logisticsNo || "",
            userId: order.technicianId || order.operatorId || "",
            stage: "REPAIR_PREPARATION",
            stageLabel: "维修资料提交",
            status: preparation.status,
            message: String(preparation.lastError?.message || "维修资料提交失败，请查看处理"),
            errorCode: String(preparation.lastError?.code || ""),
            updatedAt: String(preparation.lastError?.at || order.updatedAt || ""),
          });
        }
        const holdStatus = String(order.hold?.status || "").toUpperCase();
        const holdStartedAt = String(order.hold?.updatedAt || order.hold?.createdAt || order.updatedAt || "");
        const holdStartedMs = Date.parse(holdStartedAt);
        const holdStalledAfterMs = 120_000;
        const holdStalled = activeStatuses.has(holdStatus)
          && Number.isFinite(holdStartedMs)
          && now - holdStartedMs >= holdStalledAfterMs;
        if (failureStatuses.has(holdStatus) || holdStalled) {
          alerts.push({
            id: `${order.rmaNo}:HOLD`,
            rmaNo: order.rmaNo,
            logisticsNo: order.logisticsNo || "",
            userId: order.technicianId || order.operatorId || "",
            stage: "HOLD",
            stageLabel: "暂存提交",
            status: holdStalled ? "STALLED" : holdStatus,
            message: holdStalled
              ? "暂存提交超过120秒没有完成，系统正在检查"
              : String(order.hold?.lastError?.message || "暂存提交失败，请查看处理"),
            errorCode: String(order.hold?.lastError?.code || ""),
            updatedAt: String(order.hold?.lastError?.at || holdStartedAt),
          });
        }
      }
      const ownedRmaNos = new Set(orders.map((order) => order.rmaNo));
      const outboxTasks = typeof syncService?.outbox?.readAll === "function"
        ? await syncService.outbox.readAll().catch(() => [])
        : [];
      const latestTaskKeys = new Set();
      for (const task of [...outboxTasks].sort((left, right) =>
        String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")))) {
        if (!ownedRmaNos.has(task.rmaNo)) continue;
        const taskKey = `${task.rmaNo}:${task.nodeType || "RECLOUD_SYNC"}`;
        if (latestTaskKeys.has(taskKey)) continue;
        latestTaskKeys.add(taskKey);
        const status = String(task.status || "").toUpperCase();
        if (!["FAILED", "MANUAL_REVIEW", "RESULT_UNKNOWN"].includes(status)) continue;
        alerts.push({
          id: `outbox:${task.id}`,
          rmaNo: task.rmaNo,
          logisticsNo: task.payload?.logisticsNo || "",
          userId: task.payload?.technicianId || "",
          stage: task.nodeType || "RECLOUD_SYNC",
          stageLabel: task.nodeType === "REPAIR_COMPLETED" ? "完工提交" : "瑞云同步",
          status,
          message: task.reconciliationRequired
            ? "瑞云提交结果未知，系统将核对支持的节点；未确认前不能重复提交"
            : String(task.lastError?.message || task.error?.message || "瑞云同步失败，请查看处理"),
          errorCode: String((typeof task.lastError === "string" ? task.lastError : task.lastError?.code) || task.error?.code || ""),
          updatedAt: String(task.updatedAt || ""),
        });
      }
      alerts.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
      res.json({ success: true, data: alerts.slice(0, 100) });
    } catch (error) { next(error); }
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
      const privileged = hasBusinessRole(user, USER_ROLES.ADMIN, USER_ROLES.WAREHOUSE);
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
      const privileged = hasBusinessRole(user, USER_ROLES.ADMIN, USER_ROLES.WAREHOUSE);
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
      const privileged = hasBusinessRole(user, USER_ROLES.ADMIN, USER_ROLES.WAREHOUSE);
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

  app.post("/api/repairs/inspection/warranty-confirm", async (req, res, next) => {
    try {
      const rmaNo = String(req.body?.rmaNo || "").trim();
      if (!rmaNo) throw createApiError("WARRANTY_DECISION_INVALID", "缺少必填字段：rmaNo", 400);
      const order = (await receiptStore.readAll()).find((item) => item.rmaNo === rmaNo);
      if (!order) throw createApiError("RECEIPT_PREPARATION_NOT_FOUND", "未找到已签收工单", 404);
      const warranty = evaluateWarranty({
        sn: order.sn,
        purchaseDate: order.purchaseDate,
        warrantyYears: order.modelAuthorization?.warrantyYears || 2,
        isOfficialRefurbished: order.modelAuthorization?.isOfficialRefurbished === true,
      });
      if (warranty.status !== "DETERMINED") {
        throw createApiError("WARRANTY_MANUAL_CONFIRMATION_REQUIRED", warranty.reason || "保修状态无法自动判断，需人工确认", 409);
      }
      const technicianWarranty = String(req.body?.technicianWarranty || "").trim();
      if (!["保内", "保外"].includes(technicianWarranty)) {
        throw createApiError("WARRANTY_STATUS_REQUIRED", "请由师傅明确选择保内或保外", 400);
      }
      const conversionRequested = req.body?.conversionRequested === true;
      if (conversionRequested && technicianWarranty !== "保外") {
        throw createApiError("WARRANTY_CONVERSION_NOT_APPLICABLE", "只有当前状态为保外时才能选择保外转保内", 400);
      }
      const data = await receiptStore.saveWarrantyDecision(rmaNo, {
        technicianWarranty,
        conversionRequested,
        warrantyDecision: warranty,
      }, currentUserProvider(req));
      const conversionMessage = conversionRequested ? "，已通知信息员申请并上传凭证" : "";
      res.json({ success: true, data: { ...data, nextStep: "repairDecision", message: `已确认${technicianWarranty}${conversionMessage}，请选择处理方式` } });
    } catch (error) { next(error); }
  });

  app.get("/api/information/warranty-conversions", async (req, res, next) => {
    try {
      const user = currentUserProvider(req);
      if (!hasBusinessRole(user, USER_ROLES.INFORMATION_CLERK, USER_ROLES.ADMIN)) {
        throw createApiError("WARRANTY_CONVERSION_FORBIDDEN", "只有信息员或管理员可以查看保外转保内申请", 403);
      }
      const records = (await receiptStore.readAll())
        .filter((order) => order.manufacturerWarrantyConversion?.requested === true)
        .map((order) => ({
          rmaNo: order.rmaNo, logisticsNo: order.logisticsNo, sn: order.sn,
          productLine: order.productLine || order.specialty || "",
          customerName: order.customerName || "", technicianName: order.technicianName || order.operatorName || "",
          status: order.manufacturerWarrantyConversion.status || "PENDING_APPROVAL",
          requestedAt: order.manufacturerWarrantyConversion.requestedAt || order.warrantyConfirmedAt || "",
          approvalNo: order.manufacturerWarrantyConversion.approvalNo || "",
          proofAttachments: order.manufacturerWarrantyConversion.proofAttachments || [],
        }))
        .sort((left, right) => String(right.requestedAt).localeCompare(String(left.requestedAt)));
      res.json({ success: true, data: records });
    } catch (error) { next(error); }
  });

  app.post("/api/information/warranty-conversions/attachments", async (req, res, next) => {
    try {
      const user = currentUserProvider(req);
      if (!hasBusinessRole(user, USER_ROLES.INFORMATION_CLERK, USER_ROLES.ADMIN)) {
        throw createApiError("WARRANTY_CONVERSION_FORBIDDEN", "只有信息员或管理员可以上传申请凭证", 403);
      }
      const rmaNo = String(req.body?.rmaNo || "").trim();
      const mimeType = String(req.body?.mimeType || "");
      if (!mimeType.startsWith("image/")) throw createApiError("WARRANTY_CONVERSION_PROOF_INVALID", "申请凭证仅支持照片", 400);
      const attachment = await attachmentStore.save(req.body || {});
      const order = await receiptStore.addWarrantyConversionProof(rmaNo, attachment, { approvalNo: req.body?.approvalNo }, user);
      res.json({ success: true, data: { ...order.manufacturerWarrantyConversion, message: "申请凭证已保存，并将自动带入维修附件" } });
    } catch (error) { next(error); }
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
    return hydratePartRecords(order, applications);
  }

  async function hydratePartRecords(order, applications = []) {
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

  async function hydrateFreightWaiverOrder(order) {
    if (!rmaQueryCacheStore?.readAll) return order;
    const cachedOrders = await rmaQueryCacheStore.readAll();
    const cached = cachedOrders
      .find((item) => String(item?.rmaNo || "").trim() === String(order?.rmaNo || "").trim());
    if (!cached) return order;
    const currentPhone = cached.phone || cached.phoneMasked || order.phone || order.phoneMasked || "";
    const currentSn = String(order.sn || cached.sn || "").trim().toUpperCase();
    const sameMachineFullPhone = currentSn
      ? cachedOrders.find((item) => {
        const candidatePhone = String(item?.phone || "").replace(/\D/g, "");
        return String(item?.sn || "").trim().toUpperCase() === currentSn
          && /^1[3-9]\d{9}$/.test(candidatePhone)
          && phoneMatches(currentPhone, candidatePhone);
      })?.phone
      : "";
    return {
      ...order,
      customerName: order.customerName || cached.customerName || "",
      phone: /^1[3-9]\d{9}$/.test(String(currentPhone).replace(/\D/g, ""))
        ? currentPhone
        : sameMachineFullPhone || currentPhone,
      customerAddress:
        order.customerAddress || order.address || order.regionAddress
        || cached.customerAddress || cached.address || cached.regionAddress || "",
      productModel: order.productModel || cached.productModel || order.modelAuthorization?.model || "",
      purchaseDate: order.purchaseDate || cached.purchaseDate || "",
      reportedAt: order.reportedAt || cached.reportedAt || cached.sourceCreatedAt || "",
    };
  }

  async function refreshFreightWaiverApplication(order, operator = {}, options = {}) {
    if (!order || order.treatmentMode !== "ABANDONED" || !receiptStore.saveFreightWaiverApplication) return null;
    if (order.repairCompletion?.outOfWarrantyReliefEnabled !== true) return null;
    if ((options.logisticsChargeMode || order.repairCompletion?.logisticsChargeMode) === "WALK_IN") return null;
    const hydratedOrder = await hydrateFreightWaiverOrder(order);
    const parts = await hydratePartRecords(order, order.abandonedQuoteParts || []);
    const partsPricing = resolvePartsFee(parts);
    const repairPricing = resolveOutOfWarrantyFee(await repairFeesForOrder(order), parts);
    const oneWayLogisticsFee = Number(options.oneWayLogisticsFee ?? order.repairCompletion?.oneWayLogisticsFee ?? 0) || 0;
    const logisticsChargeMode = String(options.logisticsChargeMode || order.repairCompletion?.logisticsChargeMode || "ROUND_TRIP").trim();
    const canPrice = partsPricing.canPrice === true && repairPricing.canPrice === true;
    const pricing = abandonedReturnPricing({
      partsFee: partsPricing.canPrice ? partsPricing.partsFee : 0,
      repairFee: repairPricing.canPrice ? repairPricing.fee : 0,
      oneWayLogisticsFee,
      logisticsChargeMode: logisticsChargeMode === "ONE_WAY" ? "ONE_WAY" : "ROUND_TRIP",
      highestLevel: repairPricing.highestLevel || "无配件",
      canPrice,
    });
    const formData = buildFreightWaiverApplicationData({
      order: hydratedOrder,
      pricing,
      applicant: operator,
      now: options.now || new Date(),
    });
    return receiptStore.saveFreightWaiverApplication(order.rmaNo, {
      status: options.status || (canPrice && oneWayLogisticsFee > 0 ? "READY" : "DRAFT"),
      templateVersion: FREIGHT_WAIVER_TEMPLATE_VERSION,
      formData,
      quoteReady: canPrice,
      freightReady: oneWayLogisticsFee > 0,
      finalizedAttachment: options.finalizedAttachment || null,
    }, operator);
  }

  function scheduleFreightWaiverApplicationRefresh(order, operator, options = {}) {
    setImmediate(() => {
      refreshFreightWaiverApplication(order, operator, options).catch((error) => {
        console.warn(`FREIGHT_WAIVER_APPLICATION_DRAFT: rma=${order?.rmaNo || "unknown"} failed=${error.code || error.message || "UNKNOWN"}`);
      });
    });
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
      if (!hasBusinessRole(user, USER_ROLES.TECHNICIAN, USER_ROLES.ADMIN)) throw createApiError("INVENTORY_ACTION_FORBIDDEN", "只有维修师傅可以申请配件", 403);
      const order = (await receiptStore.readAll()).find((item) => item.rmaNo === rmaNo);
      if (!order || !["RECEIVED_PENDING_INSPECTION", "INSPECTION_COMPLETED_PENDING_REPAIR", "REPAIR_COMPLETION_DRAFT"].includes(order.status)) throw createApiError("PART_APPLICATION_NOT_ALLOWED", "当前工单不能选择维修配件", 409);
      const quoteOnly = order.treatmentMode === "ABANDONED";
      const diagnosticOnly = order.treatmentMode === "INSPECTION_ONLY" && order.inspectionFaultOutcome === "FAULT_REPRODUCED";
      const recordOnly = quoteOnly || diagnosticOnly;
      const selectedParts = quoteOnly
        ? (order.abandonedQuoteParts || [])
        : diagnosticOnly ? (order.diagnosticParts || []) : (order.partApplications || []);
      if (selectedParts.some((item) => item.partCode === partCode)) {
        throw createApiError("PART_ALREADY_APPLIED", "该配件已添加，请直接修改上方数量", 409);
      }
      const projectCode = getSnProjectMatch(order.sn).projectCode;
      const productLine = order.specialty || order.productLine;
      const catalogResult = typeof feishuPartsCatalog.searchWithFallback === "function"
        ? await feishuPartsCatalog.searchWithFallback({ productLine, projectCode, keyword: partCode })
        : { fallbackUsed: false, items: await feishuPartsCatalog.search({ productLine, projectCode, keyword: partCode }) };
      const part = (catalogResult.items || [])
        .find((item) => item.code === partCode);
      if (!part) throw createApiError("PART_NOT_FOUND", "飞书备件表未找到该配件", 404);
      const data = await receiptStore.applyPart(rmaNo, { ...part, stock: recordOnly ? Number.MAX_SAFE_INTEGER : Number(req.body?.quantity) }, req.body?.quantity, user);
      const pricedParts = quoteOnly
        ? (data.order?.abandonedQuoteParts || [])
        : diagnosticOnly ? (data.order?.diagnosticParts || []) : (data.order?.partApplications || []);
      const pricing = buildPricingPreview({
        modelRepairFees: data.order?.modelAuthorization?.repairFees || order.modelAuthorization?.repairFees || {},
        usedParts: pricedParts,
        warrantyStatus: data.order?.technicianWarranty || order.technicianWarranty,
      });
      if (quoteOnly) scheduleFreightWaiverApplicationRefresh(data.order, user);
      return res.json({
        success: true,
        data: {
          ...data,
          pricing,
          message: quoteOnly
            ? "弃修报价配件已记录，仅用于费用明细"
            : diagnosticOnly ? "故障配件已记录，仅用于确认故障，不会添加到瑞云" : "配件已记录到当前工单",
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
      const catalogResult = typeof feishuPartsCatalog.searchWithFallback === "function"
        ? await feishuPartsCatalog.searchWithFallback({ productLine, projectCode, keyword })
        : { fallbackUsed: false, items: await feishuPartsCatalog.search({ productLine, projectCode, keyword }) };
      res.json({
        success: true,
        data: {
          projectCode,
          source: "FEISHU_LIVE",
          queriedAt: new Date().toISOString(),
          fallbackUsed: catalogResult.fallbackUsed === true,
          items: catalogResult.items || [],
        },
      });
    } catch (error) { next(error); }
  });

  app.get("/api/repairs/parts", async (req, res, next) => {
    try {
      const rmaNo = String(req.query.rmaNo || "").trim();
      let order = (await receiptStore.readAll()).find((item) => item.rmaNo === rmaNo);
      if (!order) throw createApiError("RECEIPT_PREPARATION_NOT_FOUND", "未找到当前工单", 404);
      if (!String(order.reportedFault || "").trim()) {
        const sources = [];
        if (rmaQueryCacheStore) sources.push(...await rmaQueryCacheStore.readAll());
        if (pendingReceiptStore) sources.push(...await pendingReceiptStore.readAll());
        order.reportedFault = resolveReportedFault(rmaNo, sources);
        if (order.reportedFault && typeof receiptStore.saveReportedFault === "function") await receiptStore.saveReportedFault(rmaNo, order.reportedFault);
      }
      if (!order.reportedFault) {
        try { order = await loadReportedFault(order); }
        catch (error) { console.warn(`REPORTED_FAULT_REFRESH: ${error.code || 'FAILED'}`); }
      }
      const quoteOnly = order.treatmentMode === "ABANDONED";
      const diagnosticOnly = order.treatmentMode === "INSPECTION_ONLY" && order.inspectionFaultOutcome === "FAULT_REPRODUCED";
      const items = quoteOnly
        ? await hydratePartRecords(order, order.abandonedQuoteParts || [])
        : diagnosticOnly ? await hydratePartRecords(order, order.diagnosticParts || []) : await hydratePartApplications(order);
      const pricing = buildPricingPreview({
        modelRepairFees: order.modelAuthorization?.repairFees || {},
        usedParts: items,
        warrantyStatus: order.technicianWarranty,
      });
      res.json({
        success: true,
        data: {
          items,
          pricing,
          diagnosticPartsConfirmedAt: diagnosticOnly ? order.diagnosticPartsConfirmedAt || null : null,
          reportedFault: protectPreReceiptFaults(order, { restricted: restrictFaultVisibilityForUser(currentUserProvider(req)) }).reportedFault || "",
        },
      });
    } catch (error) { next(error); }
  });

  app.post("/api/repairs/parts/update", async (req, res, next) => {
    try {
      const user = currentUserProvider(req);
      if (!hasBusinessRole(user, USER_ROLES.TECHNICIAN, USER_ROLES.ADMIN)) throw createApiError("INVENTORY_ACTION_FORBIDDEN", "只有维修师傅可以修改配件", 403);
      const data = await receiptStore.updatePartApplication(
        String(req.body?.rmaNo || "").trim(),
        String(req.body?.applicationId || "").trim(),
        { quantity: req.body?.quantity, remove: req.body?.remove === true },
        user
      );
      const quoteOnly = data.order?.treatmentMode === "ABANDONED";
      const diagnosticOnly = data.order?.treatmentMode === "INSPECTION_ONLY" && data.order?.inspectionFaultOutcome === "FAULT_REPRODUCED";
      const pricedParts = quoteOnly
        ? (data.order?.abandonedQuoteParts || [])
        : diagnosticOnly ? (data.order?.diagnosticParts || []) : (data.order?.partApplications || []);
      const pricing = buildPricingPreview({
        modelRepairFees: data.order?.modelAuthorization?.repairFees || {},
        usedParts: pricedParts,
        warrantyStatus: data.order?.technicianWarranty,
      });
      if (quoteOnly) scheduleFreightWaiverApplicationRefresh(data.order, user);
      res.json({ success: true, data: { ...data, pricing, message: req.body?.remove === true ? "配件已删除" : "配件数量已修改" } });
    } catch (error) { next(error); }
  });

  app.post("/api/repairs/parts/confirm", async (req, res, next) => {
    try {
      const user = currentUserProvider(req);
      if (!hasBusinessRole(user, USER_ROLES.TECHNICIAN, USER_ROLES.ADMIN)) throw createApiError("INVENTORY_ACTION_FORBIDDEN", "只有维修师傅可以确认配件", 403);
      const data = await receiptStore.confirmParts(String(req.body?.rmaNo || "").trim(), user);
      if (data.order?.treatmentMode === "ABANDONED") scheduleFreightWaiverApplicationRefresh(data.order, user);
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

  app.get("/api/inventory/technicians", async (req, res, next) => {
    try {
      const user = currentUserProvider(req);
      if (!hasBusinessRole(user, USER_ROLES.ADMIN, USER_ROLES.WAREHOUSE)) throw createApiError("INVENTORY_ACTION_FORBIDDEN", "只有管理员或库房可以选择领用师傅", 403);
      const data = (await accountStore.list()).filter((item) => item.active !== false && !item.deletedAt && item.role === USER_ROLES.TECHNICIAN)
        .map(({ userId, displayName, repairSpecialties }) => ({ userId, displayName, repairSpecialties }));
      res.json({ success: true, data });
    } catch (error) { next(error); }
  });

  app.get("/api/inventory/recloud", async (req, res, next) => {
    try {
      const query = String(req.query?.query || "").trim();
      if (!query) throw createApiError("RECLOUD_PARTS_INVENTORY_QUERY_REQUIRED", "请输入仓库编码或配件编码", 400);
      if (typeof connector.queryPartsInventory !== "function") {
        throw createApiError("RECLOUD_PARTS_INVENTORY_UNAVAILABLE", "当前未启用瑞云备件库存查询", 503);
      }
      const data = await withRecloud(
        connector,
        (page) => connector.queryPartsInventory(page, query),
        { ...foregroundQueryOptions, timeoutMs: 30000, timeoutCode: "RECLOUD_PARTS_INVENTORY_TIMEOUT" }
      );
      res.json({ success: true, data });
    } catch (error) { next(error); }
  });

  app.post("/api/inventory/stock-in", async (req, res, next) => {
    try {
      const user = currentUserProvider(req);
      if (!hasBusinessRole(user, USER_ROLES.ADMIN, USER_ROLES.WAREHOUSE)) throw createApiError("INVENTORY_ACTION_FORBIDDEN", "只有管理员或库房可以登记入库", 403);
      const data = await inventoryStore.receive(req.body?.partCode, req.body?.partName, req.body?.quantity, user);
      res.json({ success: true, data: { ...data, message: "配件入库已记录" } });
    } catch (error) { next(error); }
  });

  app.post("/api/inventory/allocate", async (req, res, next) => {
    try {
      const user = currentUserProvider(req);
      if (!hasBusinessRole(user, USER_ROLES.ADMIN, USER_ROLES.WAREHOUSE)) throw createApiError("INVENTORY_ACTION_FORBIDDEN", "只有管理员或库房可以发放配件", 403);
      const technicianId = String(req.body?.technicianId || "").trim();
      const technician = (await accountStore.list()).find((item) => item.userId === technicianId && item.active !== false && !item.deletedAt && item.role === USER_ROLES.TECHNICIAN);
      if (!technician) throw createApiError("INVENTORY_TECHNICIAN_REQUIRED", "请选择有效的领用师傅账号", 400);
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
      if (!hasBusinessRole(user, USER_ROLES.TECHNICIAN, USER_ROLES.ADMIN)) throw createApiError("INVENTORY_ACTION_FORBIDDEN", "只有维修师傅可以使用配件", 403);
      const data = await inventoryStore.use(await inventoryContext(req), String(req.body?.partCode || ""), req.body?.quantity, user);
      res.json({ success: true, data: { ...data, message: "配件使用已记录" } });
    } catch (error) { next(error); }
  });

  app.post("/api/inventory/returns", async (req, res, next) => {
    try {
      const user = currentUserProvider(req);
      if (!hasBusinessRole(user, USER_ROLES.TECHNICIAN, USER_ROLES.ADMIN)) throw createApiError("INVENTORY_ACTION_FORBIDDEN", "只有维修师傅可以申请退还", 403);
      const data = await inventoryStore.requestReturn(await inventoryContext(req), String(req.body?.partCode || ""), req.body?.quantity, user);
      res.json({ success: true, data: { ...data, message: "退还申请已提交，等待库房确认" } });
    } catch (error) { next(error); }
  });

  app.post("/api/inventory/returns/confirm", async (req, res, next) => {
    try {
      const user = currentUserProvider(req);
      if (!hasBusinessRole(user, USER_ROLES.ADMIN, USER_ROLES.WAREHOUSE)) throw createApiError("INVENTORY_ACTION_FORBIDDEN", "只有管理员或库房可以确认退还", 403);
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
      let order = (await receiptStore.readAll()).find((item) => item.rmaNo === rmaNo);
      if (!order) throw createApiError("RECEIPT_PREPARATION_NOT_FOUND", "未找到待维修工单", 404);
      try { if (req.body?.localOnly !== true) order = await loadReportedFault(order); }
      catch (error) { order = { ...order, reportedFaultError: error.code === 'RECLOUD_LOGIN_REQUIRED'
        ? '瑞云登录已失效，报修描述尚未同步；恢复登录后请点击重新读取描述'
        : error.code === 'REPORTED_FAULT_EMPTY' ? error.message
        : '报修描述读取失败，请点击重新读取描述；可保存草稿，暂不能提交完工' }; }
      if (
        order.recloudDetectionConfirmedAt
        && !order.recloudServiceOrderCreatedAt
        && order.recloudServiceOrderSyncStatus === "FAILED"
        && order.recloudRepairPreparation?.status === "PENDING"
      ) {
        scheduleRecloudServiceOrderSync(order, currentUserProvider(req));
      }
      const hasSavedInspection = Boolean(order.inspectionUpdatedAt && order.faultCategory && order.technicianWarranty);
      if (!["INSPECTION_COMPLETED_PENDING_REPAIR", "REPAIR_COMPLETION_DRAFT"].includes(order.status) && !hasSavedInspection) {
        throw createApiError("REPAIR_COMPLETION_NOT_ALLOWED", "仅已完成检测的工单可以进入维修完工", 409);
      }
      const appliedParts = (await hydratePartApplications(order)).map((part) => ({
        partCode: part.partCode, partName: part.partName, quantity: part.quantity,
        repairLevel: part.repairLevel, retailPrice: part.retailPrice,
        returnRequired: Boolean(part.returnRequired),
      }));
      const usedParts = appliedParts.length ? appliedParts : await inventoryStore.usedPartsForOrder(order.rmaNo, order.sn);
      const abandonedQuoteParts = order.treatmentMode === "ABANDONED"
        ? (await hydratePartRecords(order, order.abandonedQuoteParts || [])).map((part) => ({
          partCode: part.partCode, partName: part.partName, quantity: part.quantity,
          repairLevel: part.repairLevel, retailPrice: part.retailPrice,
          returnRequired: Boolean(part.returnRequired), quoteOnly: true,
        }))
        : [];
      const { noPartsService } = getOutOfWarrantyFeePolicy(order);
      const modelRepairFees = await repairFeesForOrder(order);
      const pricingParts = order.treatmentMode === "ABANDONED" ? abandonedQuoteParts : usedParts;
      const repairPricing = noPartsService && order.treatmentMode !== "ABANDONED"
        ? { status: "NO_PARTS_SERVICE", canPrice: true, highestLevel: "无配件", fee: 0 }
        : resolveOutOfWarrantyFee(modelRepairFees, pricingParts);
      const partsPricing = noPartsService && order.treatmentMode !== "ABANDONED"
        ? { status: "READY", canPrice: true, partsFee: 0 }
        : resolvePartsFee(pricingParts);
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
      const warrantyApprovalAttachments = (order.manufacturerWarrantyConversion?.proofAttachments || [])
        .map((item) => ({ ...item, locked: true, source: "WARRANTY_CONVERSION_APPROVAL" }));
      res.json({ success: true, data: { order, usedParts, abandonedQuoteParts, pricing, warrantyApprovalAttachments, recloudSynced: false } });
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
      let order = (await receiptStore.readAll()).find((item) => item.rmaNo === rmaNo);
      if (!order) throw createApiError("RECEIPT_PREPARATION_NOT_FOUND", "未找到待维修工单", 404);
      if (submit) {
        order = await loadReportedFault(order);
        assertReportedFaultForSubmission(order, req.body?.repairMeasure);
      }
      const conversion = order.manufacturerWarrantyConversion || {};
      if (submit && conversion.requested === true && conversion.status !== "APPROVED") {
        throw createApiError("WARRANTY_CONVERSION_APPROVAL_PENDING", "保外转保内申请凭证尚未上传，请等待信息员处理", 409);
      }
      const proofAttachments = (conversion.proofAttachments || []).map((item) => ({
        ...item, locked: true, source: "WARRANTY_CONVERSION_APPROVAL",
      }));
      const technicianAttachments = Array.isArray(req.body?.attachments)
        ? req.body.attachments.filter((item) => ![
          "WARRANTY_CONVERSION_APPROVAL",
          FREIGHT_WAIVER_APPLICATION_SOURCE,
          "INSPECTION_REPORT",
        ].includes(item?.source))
        : [];
      const mergedAttachments = [...technicianAttachments];
      for (const proof of proofAttachments) {
        if (!mergedAttachments.some((item) => item?.id === proof.id)) mergedAttachments.push(proof);
      }
      const appliedParts = (await hydratePartApplications(order)).map((part) => ({
        partCode: part.partCode, partName: part.partName, quantity: part.quantity,
        repairLevel: part.repairLevel, retailPrice: part.retailPrice,
        returnRequired: Boolean(part.returnRequired),
      }));
      const usedParts = appliedParts.length ? appliedParts : await inventoryStore.usedPartsForOrder(order.rmaNo, order.sn);
      const abandonedQuoteParts = order.treatmentMode === "ABANDONED"
        ? (await hydratePartRecords(order, order.abandonedQuoteParts || [])).map((part) => ({
          partCode: part.partCode, partName: part.partName, quantity: part.quantity,
          repairLevel: part.repairLevel, retailPrice: part.retailPrice,
          returnRequired: Boolean(part.returnRequired), quoteOnly: true,
        }))
        : [];
      const {
        noPartsService,
        isOutOfWarranty,
        requiresOutOfWarrantyFee,
      } = getOutOfWarrantyFeePolicy(order);
      const modelRepairFees = await repairFeesForOrder(order);
      const logisticsChargeMode = order.treatmentMode === "ABANDONED"
        ? String(req.body?.logisticsChargeMode || "ROUND_TRIP").trim()
        : isOutOfWarranty
        ? String(req.body?.logisticsChargeMode || "ROUND_TRIP").trim()
        : "NOT_CHARGED";
      if (order.treatmentMode === "ABANDONED" && !["ROUND_TRIP", "ONE_WAY", "WALK_IN"].includes(logisticsChargeMode)) {
        throw createApiError("LOGISTICS_CHARGE_MODE_INVALID", "弃修免运费申请请选择收取往返运费或只收单边运费", 400);
      }
      const discountEnabled = isOutOfWarranty && req.body?.discountEnabled === true;
      const outOfWarrantyReliefEnabled = order.treatmentMode === "ABANDONED" && req.body?.outOfWarrantyReliefEnabled === true;
      const discountScope = discountEnabled
        ? String(req.body?.discountScope || "ORDER_TOTAL").trim()
        : "ORDER_TOTAL";
      const discountRate = discountEnabled ? req.body?.discountRate : 10;
      const rawOneWayLogisticsFee = req.body?.oneWayLogisticsFee;
      const logisticsFeeIsWaived = ["WAIVED", "WALK_IN"].includes(logisticsChargeMode);
      if (submit && requiresOutOfWarrantyFee && !logisticsFeeIsWaived && (rawOneWayLogisticsFee === "" || rawOneWayLogisticsFee === null || rawOneWayLogisticsFee === undefined)) {
        throw createApiError("LOGISTICS_FEE_REQUIRED", "保外工单必须填写单程物流费", 400);
      }
      const oneWayLogisticsFee = logisticsChargeMode !== "WALK_IN" && (isOutOfWarranty && !logisticsFeeIsWaived || order.treatmentMode === "ABANDONED") && rawOneWayLogisticsFee !== "" && rawOneWayLogisticsFee !== null && rawOneWayLogisticsFee !== undefined
        ? Number(rawOneWayLogisticsFee)
        : 0;
      if (!Number.isFinite(oneWayLogisticsFee) || oneWayLogisticsFee < 0) {
        throw createApiError("LOGISTICS_FEE_INVALID", "单程物流费必须是大于或等于 0 的数字", 400);
      }
      const pricingParts = order.treatmentMode === "ABANDONED" ? abandonedQuoteParts : usedParts;
      const repairPricing = noPartsService && order.treatmentMode !== "ABANDONED"
        ? { status: "NO_PARTS_SERVICE", canPrice: true, highestLevel: "无配件", fee: 0 }
        : resolveOutOfWarrantyFee(modelRepairFees, pricingParts);
      const partsPricing = noPartsService && order.treatmentMode !== "ABANDONED"
        ? { status: "READY", canPrice: true, partsFee: 0 }
        : resolvePartsFee(pricingParts);
      const canPrice = repairPricing.canPrice === true && partsPricing.canPrice === true;
      const partsFee = partsPricing.partsFee;
      if (submit && (isOutOfWarranty || order.treatmentMode === "ABANDONED") && !canPrice) {
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
            discountEnabled,
            discountScope,
            discountRate,
            finalChargeAmount: req.body?.finalChargeAmount,
          });
        } catch (error) {
          if (["LOGISTICS_FEE_INVALID", "LOGISTICS_CHARGE_MODE_INVALID", "DISCOUNT_RATE_INVALID", "DISCOUNT_SCOPE_INVALID", "FINAL_CHARGE_AMOUNT_INVALID"].includes(error.code)) {
            throw createApiError(error.code, error.message, 400);
          }
          throw error;
        }
      }
      const pricing = order.treatmentMode === "ABANDONED"
        ? abandonedReturnPricing({
            partsFee,
            repairFee: repairPricing.fee,
            oneWayLogisticsFee,
            logisticsChargeMode,
            highestLevel: repairPricing.highestLevel,
            canPrice,
            outOfWarrantyReliefEnabled,
          })
        : isOutOfWarranty
          ? {
            ...repairPricing,
            partsFee,
            ...(charge || {
              logisticsChargeMode,
              oneWayLogisticsFee,
              logisticsFee: null,
              logisticsMultiplier: null,
              discountEnabled,
              discountScope,
              discountRate: discountEnabled ? Number(discountRate) : 10,
              discountAmount: null,
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
            discountEnabled: false, discountScope: "ORDER_TOTAL", discountRate: 10, discountAmount: 0,
            primaryRemark: null, secondaryRemark: null, logisticsSource: "NOT_CHARGED",
            };
      const confirmedFaultPath = require('./services/fault-category-path').splitFaultCategoryPath(order.faultCategory);
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
      if (submit && outOfWarrantyReliefEnabled) {
        let generated;
        try {
          const hydratedOrder = await hydrateFreightWaiverOrder(order);
          generated = await freightWaiverApplicationGenerator({
            order: hydratedOrder,
            pricing,
            applicant: currentUserProvider(req),
            now: new Date(),
          });
        } catch (error) {
          throw createApiError(
            "FREIGHT_WAIVER_APPLICATION_RENDER_FAILED",
            `免运费申请单截图生成失败：${error.message || "未知错误"}`,
            500
          );
        }
        if (!Buffer.isBuffer(generated?.buffer) || generated.buffer.length === 0) {
          throw createApiError("FREIGHT_WAIVER_APPLICATION_RENDER_FAILED", "免运费申请单截图生成失败", 500);
        }
        const savedApplication = await attachmentStore.save({
          rmaNo,
          name: `免运费申请单-${rmaNo}.png`,
          mimeType: "image/png",
          data: generated.buffer.toString("base64"),
        });
        const finalizedApplicationAttachment = {
          ...savedApplication,
          locked: true,
          systemGenerated: true,
          source: FREIGHT_WAIVER_APPLICATION_SOURCE,
          templateVersion: generated.applicationData?.templateVersion || FREIGHT_WAIVER_TEMPLATE_VERSION,
        };
        mergedAttachments.push(finalizedApplicationAttachment);
        if (receiptStore.saveFreightWaiverApplication) {
          await receiptStore.saveFreightWaiverApplication(rmaNo, {
            status: "FINALIZED",
            templateVersion: finalizedApplicationAttachment.templateVersion,
            formData: generated.applicationData,
            quoteReady: true,
            freightReady: true,
            finalizedAttachment: finalizedApplicationAttachment,
            finalizedAt: new Date().toISOString(),
          }, currentUserProvider(req));
        }
      }
      const data = await receiptStore.saveRepairCompletion(
        rmaNo,
        {
          ...req.body,
          attachments: mergedAttachments,
          ...confirmedFault,
          responsibilityType,
          usedParts: order.treatmentMode === "ABANDONED" ? [] : usedParts,
          abandonedQuoteParts,
          outOfWarrantyReliefEnabled,
          logisticsChargeMode: pricing.logisticsChargeMode,
          oneWayLogisticsFee,
          logisticsFee: pricing.logisticsFee,
          discountEnabled: pricing.discountEnabled,
          discountScope: pricing.discountScope,
          discountRate: pricing.discountRate,
          finalChargeAmount: charge?.manualTotalFee ?? null,
          primaryRemark: pricing.primaryRemark,
          secondaryRemark: pricing.secondaryRemark,
          pricing,
        },
        currentUserProvider(req),
        submit
      );
      if (!submit && order.treatmentMode === "ABANDONED") {
        scheduleFreightWaiverApplicationRefresh(data, currentUserProvider(req), { oneWayLogisticsFee, logisticsChargeMode });
      }
      if (submit) {
        const queuedTask = await enqueueRecloudNode(
          data,
          "REPAIR_COMPLETED",
          data.repairCompletion?.submittedAt || data.id
        );
        if (!queuedTask) throw createApiError("REPAIR_COMPLETION_QUEUE_FAILED", "完工资料已保存，但同步任务登记失败，请重试提交；不要重复维修操作", 503);
      }
      res.json({
        success: true,
        data: {
          ...data,
          statusLabel: submit && order.treatmentMode === "INSPECTION_ONLY"
            ? "检测已完成"
            : submit ? "维修已完成" : "维修完工草稿",
          message: submit && order.treatmentMode === "INSPECTION_ONLY"
            ? "检测资料已保存并交由后台同步；瑞云仅确认完工，不提交，已通知信息员开检测报告、上传报告、修改地址并提交"
            : submit ? "维修完工已保存，师傅操作已结束，后续发货由后台处理" : "维修完工草稿已保存",
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
      const rows=await receiptStore.listShippingOrders(user, USER_ROLES);
      await returnLogistics.ensureAll(rows);
      res.json({ success: true, data: await returnLogistics.decorate(rows) });
    } catch (error) { next(error); }
  });

  app.post("/api/shipping/context", async (req, res, next) => {
    try {
      const rmaNo = String(req.body?.rmaNo || "").trim();
      const user = currentUserProvider(req);
      const order = (await receiptStore.readAll()).find((item) => item.rmaNo === rmaNo);
      if (!order) throw createApiError("RECEIPT_PREPARATION_NOT_FOUND", "未找到待发货工单", 404);
      if (!hasBusinessRole(user, USER_ROLES.ADMIN, USER_ROLES.INFORMATION_CLERK)) {
        throw createApiError("SHIPPING_ORDER_FORBIDDEN", "只有信息员或管理员可以查看后台发货进度", 403);
      }
      if (!["REPAIR_COMPLETED_PENDING_SHIPMENT", "SHIPPED_PENDING_COMPLETION"].includes(order.status)) {
        throw createApiError("RETURN_SHIPMENT_NOT_ALLOWED", "当前工单不能进入返件发货", 409);
      }
      await returnLogistics.ensure(order);
      const usedParts = await inventoryStore.usedPartsForOrder(order.rmaNo, order.sn);
      res.json({ success: true, data: { order: (await returnLogistics.decorate([order]))[0], usedParts, syncProvider: "RECLOUD", recloudSynced: false } });
    } catch (error) { next(error); }
  });

  app.get("/api/shipping/sync-status", (req, res, next) => {
    try {
      if (!hasBusinessRole(currentUserProvider(req), USER_ROLES.ADMIN, USER_ROLES.INFORMATION_CLERK)) throw createApiError("SHIPPING_ORDER_FORBIDDEN", "无权查看物流同步", 403);
      res.json({success:true,data:returnLogistics.job});
    } catch (error) { next(error); }
  });
  app.post("/api/shipping/sync", async (req, res, next) => {
    try {
      const user=currentUserProvider(req);
      if (!hasBusinessRole(user, USER_ROLES.ADMIN, USER_ROLES.INFORMATION_CLERK)) throw createApiError("SHIPPING_ORDER_FORBIDDEN", "无权同步物流", 403);
      const rows=await receiptStore.listShippingOrders(user, USER_ROLES);
      const rmaNo=String(req.body?.rmaNo || '').trim();
      if (rmaNo) {
        const order=rows.find(row=>row.rmaNo===rmaNo);
        if (!order) throw createApiError("SHIPPING_ORDER_NOT_FOUND", "未找到可查看的返件工单", 404);
        res.json({success:true,data:await returnLogistics.sync(order,true)});
      } else res.status(202).json({success:true,data:returnLogistics.start(rows)});
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
      const privileged = hasBusinessRole(user, USER_ROLES.ADMIN, USER_ROLES.WAREHOUSE);
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
      if (!hasBusinessRole(user, USER_ROLES.ADMIN)) throw createApiError("ORDER_COMPLETION_FORBIDDEN", "只有管理员可以确认完结", 403);
      const data = await receiptStore.confirmCompletion(String(req.body?.rmaNo || "").trim(), user);
      await enqueueRecloudNode(data, "ORDER_COMPLETED", data.completedAt || data.id);
      res.json({ success: true, data: { ...data, statusLabel: "已完结", message: "工单已在 FieldDesk 本地完结", recloudSynced: false } });
    } catch (error) { next(error); }
  });

  app.get("/api/recloud-sync/tasks", async (req, res, next) => {
    try {
      const user = currentUserProvider(req);
      if (!hasBusinessRole(user, USER_ROLES.ADMIN)) throw createApiError("SYNC_TASKS_FORBIDDEN", "只有管理员可以查看瑞云同步任务", 403);
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
      const isAdmin = hasBusinessRole(user, USER_ROLES.ADMIN);
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
      if (!hasBusinessRole(user, USER_ROLES.ADMIN)) throw createApiError("SYNC_DIAGNOSTICS_FORBIDDEN", "只有管理员可以查看瑞云同步诊断", 403);
      res.json({ success: true, data: await syncDiagnostics.inspectAll() });
    } catch (error) { next(error); }
  });

  for (const nodeKey of ["receipt", "inspection", "repair", "shipping", "completion"]) {
    app.get(`/api/recloud-sync/diagnostics/${nodeKey}/inspect`, async (req, res, next) => {
      try {
        const user = currentUserProvider(req);
        if (!hasBusinessRole(user, USER_ROLES.ADMIN)) throw createApiError("SYNC_DIAGNOSTICS_FORBIDDEN", "只有管理员可以查看瑞云同步诊断", 403);
        res.json({ success: true, data: await syncDiagnostics.inspect(nodeKey) });
      } catch (error) { next(error); }
    });
    app.post(`/api/recloud-sync/diagnostics/${nodeKey}/capture`, async (req, res, next) => {
      try {
        const user = currentUserProvider(req);
        if (!hasBusinessRole(user, USER_ROLES.ADMIN)) throw createApiError("SYNC_DIAGNOSTICS_FORBIDDEN", "只有管理员可以采集瑞云同步诊断", 403);
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
      const orders = await receiptStore.listOrdersForUser(user, USER_ROLES);
      // Opening the FieldDesk workbench also heals a receipt whose Recloud
      // sign action completed but whose background attachment phase was
      // interrupted (for example by a stalled lookup or service restart).
      // The uploader is filename-idempotent and the active set prevents
      // duplicate concurrent work.
      for (const order of orders) {
        if (shouldAutoResumeReceipt(order)) {
          scheduleRecloudReceiptSync(order, user, crypto.randomUUID(), { queuePriority: 0 });
        }
        if (shouldAutoResumeDetection(order)) {
          scheduleRecloudDetectionSync(order, user, { queuePriority: 0 });
        }
      }
      res.json({
        success: true,
        data: protectPreReceiptFaults(orders, {
          restricted: restrictFaultVisibilityForUser(user),
        }),
      });
    } catch (error) { next(error); }
  });

  app.get(["/api/finance/payroll", "/api/finance/payroll/export"], async (req, res, next) => {
    res.setHeader("Cache-Control", "private, no-store");
    try {
      if (!canViewPayroll(currentUserProvider(req))) {
        return res.status(403).json({ success: false, code: "PAYROLL_FORBIDDEN", message: "工资核算仅负责人可见" });
      }
      const month = payrollMonth(req.query.month);
      const [orders, accounts] = await Promise.all([receiptStore.readAll(), accountStore.list()]);
      const data = buildPayroll(orders, accounts, { month, includeTest: req.query.includeTest === "true" });
      if (!req.path.endsWith("/export")) return res.json({ success: true, data });
      const filename = `${data.includeTest ? "试算-" : ""}工资表-${month}.xlsx`;
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="payroll-${month}.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`);
      res.send(Buffer.from(await exportPayroll(data)));
    } catch (error) { next(error); }
  });

  app.get(["/api/repairs/monthly-statistics", "/api/repairs/monthly-statistics/export"], async (req, res, next) => {
    try {
      const user = currentUserProvider(req);
      const exporting = req.path.endsWith("/export");
      if ((!canExportMonthly(user) && user?.role !== USER_ROLES.TECHNICIAN) || (exporting && !canExportMonthly(user))) {
        throw createApiError("MONTHLY_STATISTICS_FORBIDDEN", "当前账号无权执行此操作", 403);
      }
      if (req.query.month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(String(req.query.month))) throw createApiError("MONTH_INVALID", "请选择有效月份", 400);
      const [monthlyOrders, monthlyAccounts] = await Promise.all([receiptStore.readAll(), accountStore.list()]);
      const data = monthlyStatistics(require('./shared/monthly-statistics').formalMonthlyOrders(monthlyOrders, monthlyAccounts, user, req.query.includeTest === 'true'), user, { ...req.query, includeDetails: exporting });
      if (!exporting) return res.json({ success: true, data });
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="monthly-${data.month}.xlsx"`);
      res.send(Buffer.from(await exportMonthly(data)));
    } catch (error) { next(error); }
  });

  app.get("/api/repairs/technician-workloads", async (req, res, next) => {
    try {
      const user = currentUserProvider(req);
      if (!hasBusinessRole(user, USER_ROLES.ADMIN, USER_ROLES.INFORMATION_CLERK)) {
        throw createApiError("TECHNICIAN_WORKLOAD_FORBIDDEN", "只有管理员或信息员可以查看师傅工作量", 403);
      }
      const [accounts, orders] = await Promise.all([
        accountStore.list(),
        receiptStore.readAll(),
      ]);
      const technicians = accounts
        .filter((account) => account.role === USER_ROLES.TECHNICIAN && account.active !== false)
        .map((account) => ({
          userId: account.userId,
          displayName: account.displayName || account.userId,
          repairSpecialties: Array.isArray(account.repairSpecialties) ? account.repairSpecialties : [],
        }));
      res.json({
        success: true,
        data: {
          technicians,
          orders: orders.map(technicianWorkloadOrder),
        },
      });
    } catch (error) { next(error); }
  });

  app.post("/api/repairs/resume-step", async (req, res, next) => {
    try {
      const user = currentUserProvider(req);
      if (!hasBusinessRole(user, USER_ROLES.TECHNICIAN, USER_ROLES.ADMIN)) {
        throw createApiError("REPAIR_RESUME_STEP_FORBIDDEN", "只有维修师傅可以更新工单操作位置", 403);
      }
      const data = await receiptStore.setResumeStep(
        String(req.body?.rmaNo || "").trim(),
        String(req.body?.resumeStep || "").trim(),
        user
      );
      res.json({ success: true, data: { resumeStep: data.resumeStep } });
    } catch (error) { next(error); }
  });

  app.post("/api/repairs/receipt/reopen-sn", async (req, res, next) => {
    try {
      const rmaNo = String(req.body?.rmaNo || "").trim();
      if (!rmaNo) throw createApiError("RMA_NO_REQUIRED", "缺少寄修单号", 400);
      const data = await receiptStore.reopenReceiptForSnCorrection(
        rmaNo,
        currentUserProvider(req)
      );
      res.json({
        success: true,
        data: {
          ...data,
          message: "已清除错误 SN 并恢复到签收步骤；原签收照片已保留",
        },
      });
    } catch (error) { next(error); }
  });

  app.post("/api/repairs/admin/reopen-treatment", async (req, res, next) => {
    try {
      const user = currentUserProvider(req);
      if (!hasBusinessRole(user, USER_ROLES.ADMIN)) {
        throw createApiError("TREATMENT_REOPEN_FORBIDDEN", "只有管理员可以恢复工单处理方式", 403);
      }
      const rmaNo = String(req.body?.rmaNo || "").trim();
      if (!rmaNo) throw createApiError("RMA_NO_REQUIRED", "缺少寄修单号", 400);

      const existing = (await receiptStore.readAll()).find((order) => order.rmaNo === rmaNo);
      if (!existing) throw createApiError("RECEIPT_PREPARATION_NOT_FOUND", "未找到需要恢复的维修工单", 404);
      if (!existing.receiptCompletedAt) {
        throw createApiError("TREATMENT_REOPEN_RECEIPT_REQUIRED", "工单尚未完成签收，不能恢复处理方式", 409);
      }
      if (["SHIPPED_PENDING_COMPLETION", "COMPLETED"].includes(existing.status) || existing.returnShipment?.shippedAt) {
        throw createApiError("TREATMENT_REOPEN_SHIPPED", "机器已经返件发货或工单已经完结，不能恢复处理方式", 409);
      }
      if (!existing.treatmentMode && !existing.repairCompletion) {
        throw createApiError("TREATMENT_REOPEN_DUPLICATE", "工单已经处于处理方式选择步骤", 409);
      }

      await syncService.cancelOrderNodes(
        rmaNo,
        ["INSPECTION_COMPLETED", "REPAIR_COMPLETED"],
        { allowApplied: isDryRun(runtimeEnv) }
      );
      const data = await receiptStore.reopenTreatmentDecision(rmaNo, user);
      res.json({
        success: true,
        data: {
          ...data,
          message: "已恢复到处理方式选择，原维修师傅可继续处理",
        },
      });
    } catch (error) { next(error); }
  });

  app.post("/api/repairs/admin/delete-local-order", async (req, res, next) => {
    try {
      const user = currentUserProvider(req);
      if (!hasBusinessRole(user, USER_ROLES.ADMIN)) {
        throw createApiError("LOCAL_ORDER_DELETE_FORBIDDEN", "只有管理员或负责人可以删除误操作工单", 403);
      }
      const rmaNo = String(req.body?.rmaNo || "").trim();
      if (!rmaNo) throw createApiError("RMA_NO_REQUIRED", "缺少寄修单号", 400);

      const existing = (await receiptStore.readAll()).find((order) => order.rmaNo === rmaNo);
      if (!existing) throw createApiError("RECEIPT_PREPARATION_NOT_FOUND", "未找到需要删除的工单", 404);
      if (["REPAIR_COMPLETED_PENDING_SHIPMENT", "SHIPPED_PENDING_COMPLETION", "COMPLETED"].includes(existing.status) || existing.returnShipment?.shippedAt) {
        throw createApiError("LOCAL_ORDER_DELETE_SHIPPED", "已完工、已发货或已完结工单不能删除", 409);
      }

      await syncService.cancelOrderNodes(rmaNo, Object.keys(NODE_METHODS), { allowApplied: isDryRun(runtimeEnv) });
      await receiptAttachmentStore.deleteOrder(rmaNo);
      const deleted = await receiptStore.deleteLocalOrder(rmaNo, user);
      await coordinationStore.clearResourceState(rmaNo);
      await coordinationStore.audit({
        action: "DELETE_LOCAL_WORK_ORDER",
        resourceId: rmaNo,
        user,
        outcome: "SUCCESS",
      });
      res.json({ success: true, data: { rmaNo: deleted.rmaNo, deleted: true } });
    } catch (error) { next(error); }
  });

  app.get("/api/repairs/history", async (req, res, next) => {
    try {
      const user = currentUserProvider(req);
      if (!hasBusinessRole(user, USER_ROLES.TECHNICIAN, USER_ROLES.INFORMATION_CLERK, USER_ROLES.ADMIN)) {
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
      if (!hasBusinessRole(user, USER_ROLES.TECHNICIAN, USER_ROLES.INFORMATION_CLERK, USER_ROLES.ADMIN)) {
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
      if (!hasBusinessRole(user, USER_ROLES.INFORMATION_CLERK, USER_ROLES.ADMIN)) {
        throw createApiError("MACHINE_TRACKING_FORBIDDEN", "只有信息员或管理员可以查询在手机器", 403);
      }
      const keyword = String(req.query?.keyword || "").trim();
      if (keyword && (!/[A-Za-z]/.test(keyword) && keyword.replace(/\D/g, "").length < 4)) {
        throw createApiError("MACHINE_TRACKING_KEYWORD_INVALID", "请输入电话或完整物流单号", 400);
      }
      res.json({ success: true, data: queryMachinesInHand(await receiptStore.readAll(), keyword).slice(0, 100) });
    } catch (error) { next(error); }
  });

  function assertInformationReportAccess(user) {
    if (!hasBusinessRole(user, USER_ROLES.INFORMATION_CLERK, USER_ROLES.ADMIN)) {
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
      : ["repair", "warranty"].includes(category) ? attachmentStore
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

  app.get("/api/home/todos", async (req, res, next) => {
    try {
      const user = currentUserProvider(req);
      if (![USER_ROLES.ADMIN, USER_ROLES.TECHNICIAN, USER_ROLES.INFORMATION_CLERK].includes(user?.role)) throw createApiError("HOME_TODOS_FORBIDDEN", "无权查看待办", 403);
      const [orders, tasks] = await Promise.all([receiptStore.readAll(), syncService.outbox.readAll()]);
      res.json({success:true,data:require('./services/home-todos').buildHomeTodos(orders,tasks,user)});
    } catch(error) { next(error); }
  });

  app.get("/api/information/exceptions", async (req, res, next) => {
    try {
      assertInformationReportAccess(currentUserProvider(req));
      const orders = await receiptStore.readAll();
      if(req.query?.view==='completed') {
        return res.json({success:true,data:require('./services/completed-information-todos').completedInformationTodos(orders,await syncService.outbox.readAll())});
      }
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
      const paymentItems=require('./services/home-todos').buildHomeTodos(orders,[],currentUserProvider(req)).items.filter(i=>i.payment).map(i=>({...i,type:'PAYMENT_FOLLOWUP',severity:'MEDIUM',status:'ON_HOLD'}));
      res.json({ success: true, data: sortExceptions([...orderExceptions.flat(), ...syncExceptions,...paymentItems]) });
    } catch (error) { next(error); }
  });

  app.post("/api/information/parts-shortages/resolve", async (req, res, next) => {
    try {
      const user = currentUserProvider(req);
      if (!hasBusinessRole(user, USER_ROLES.INFORMATION_CLERK, USER_ROLES.ADMIN)) {
        throw createApiError("PARTS_SHORTAGE_RESOLVE_FORBIDDEN", "只有信息员或管理员可以确认瑞云缺件已补录并提交", 403);
      }
      const rmaNo = String(req.body?.rmaNo || "").trim();
      if (!rmaNo) throw createApiError("PARTS_SHORTAGE_RMA_REQUIRED", "缺少寄修单号", 400);
      const data = await receiptStore.resolvePartsShortage(rmaNo, user);
      res.json({ success: true, data: { ...data, message: "缺件待办已完成，可以继续返件流程" } });
    } catch (error) { next(error); }
  });

  app.post('/api/information/payment-followup', async (req,res,next) => {
    try {
      const user=currentUserProvider(req);
      assertInformationReportAccess(user);
      const data=await receiptStore.recordPaymentFollowup(String(req.body?.rmaNo || '').trim(),req.body || {},user);
      res.json({success:true,data:{message:'跟进已保存；备注待同步瑞云',paid:data.paymentFollowup.paid}});
    } catch(error) {next(error);}
  });

  app.post('/api/information/review/confirm',async(req,res,next)=>{
    try {
      const user=currentUserProvider(req);assertInformationReportAccess(user);
      await receiptStore.confirmInformationReview(String(req.body?.rmaNo || '').trim(),req.body || {},user);
      res.json({success:true,data:{message:'已确认处理，记录已移入已完成'}});
    }catch(error){next(error);}
  });

  app.post('/api/information/payment-followup/sync', async (req,res,next) => {
    try {
      const user=currentUserProvider(req);
      assertInformationReportAccess(user);
      const rmaNo=String(req.body?.rmaNo || '').trim();
      const order=(await receiptStore.readAll()).find(o=>o.rmaNo===rmaNo);
      const entry=order?.paymentFollowup?.entries?.find(e=>e.id===req.body?.id);
      if (!entry) throw createApiError('FOLLOWUP_NOT_FOUND','未找到跟进记录',404);
      if (entry.syncStatus==='CONFIRMED') return res.json({success:true,data:{message:'备注已核对同步'}});
      if (!isRecloudHoldWriteEnabled(runtimeEnv) || !isRecloudRmaWriteAllowed(rmaNo,order)) throw createApiError('FOLLOWUP_WRITE_DISABLED','当前工单不允许写入瑞云，跟进记录已保留',409);
      if (activeHoldSyncs.has(rmaNo)) throw createApiError('FOLLOWUP_BUSY','暂存同步正在执行，请稍后同步备注',409);
      activeHoldSyncs.add(rmaNo);
      try {
        const result=await withRecloud(connector,async page=>{
          const detail=await connector.queryRmaByLogisticsNo(page,order.logisticsNo || rmaNo,{preserveDetailPage:true});
          if(detail.rmaNo!==rmaNo) throw new Error('瑞云工单不一致，未追加备注');
          return connector.appendRmaFollowupRemark(page,rmaNo,entry,{writeEnabled:true});
        },{...businessWriteOptions,timeoutCode:'FOLLOWUP_SYNC_TIMEOUT'});
        await receiptStore.confirmPaymentRemark(rmaNo,entry.id,result.remark);
        res.json({success:true,data:{message:'跟进备注已同步并回读确认'}});
      } finally {activeHoldSyncs.delete(rmaNo);}
    } catch(error) {next(error);}
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

  app.get("/api/repairs/:rmaNo/attachments/:category/:attachmentId", async (req, res, next) => {
    try {
      const user = currentUserProvider(req);
      const order = (await receiptStore.readAll()).find((item) => item.rmaNo === String(req.params.rmaNo || "").trim());
      if (!order) throw createApiError("ATTACHMENT_NOT_FOUND", "附件不存在", 404);
      const privileged = hasBusinessRole(user, USER_ROLES.ADMIN, USER_ROLES.INFORMATION_CLERK);
      if (!privileged && (order.technicianId || order.operatorId) !== user.userId) {
        throw createApiError("REPAIR_ATTACHMENT_FORBIDDEN", "只能查看本人负责工单的附件", 403);
      }
      const category = String(req.params.category || "");
      if (!["receipt", "repair", "warranty"].includes(category)) throw createApiError("ATTACHMENT_NOT_FOUND", "附件不存在", 404);
      const attachment = findAttachment(order, category, String(req.params.attachmentId || ""));
      const source = attachmentSource(category);
      if (!attachment || !source) throw createApiError("ATTACHMENT_NOT_FOUND", "附件不存在", 404);
      const data = await source.read(order.rmaNo, attachment);
      res.setHeader("Content-Type", attachment.mimeType || "application/octet-stream");
      res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(attachment.name || "attachment")}`);
      res.setHeader("Content-Length", data.length);
      res.setHeader("Cache-Control", "private, max-age=300");
      res.end(data);
    } catch (error) { next(error); }
  });

  app.post("/api/recloud-sync/tasks/retry", async (req, res, next) => {
    try {
      const user = currentUserProvider(req);
      const taskId = String(req.body?.taskId || "").trim();
      const task = typeof syncService.getTask === "function" ? await syncService.getTask(taskId) : null;
      const ownsRepairTask = task?.nodeType === "REPAIR_COMPLETED"
        && String(task?.payload?.technicianId || "").trim() === String(user?.userId || "").trim();
      if (!hasBusinessRole(user, USER_ROLES.ADMIN) && !ownsRepairTask) {
        throw createApiError("SYNC_TASKS_FORBIDDEN", "只能重试本人负责的维修完工任务", 403);
      }
      res.json({ success: true, data: await syncService.retry(taskId) });
    } catch (error) { next(error); }
  });

  // 保留已有调用方兼容性。
  app.post("/queryRepair", (req, res, next) => {
    req.url = "/api/crm/repairs/query";
    app.handle(req, res, next);
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error?.type === "entity.too.large" || Number(error?.status) === 413) {
      operationalLogger.write("error", { requestId: res.getHeader("X-Request-Id"), method: req.method, path: req.path, code: "REQUEST_BODY_TOO_LARGE", status: 413 });
      return res.status(413).json({
        success: false,
        code: "REQUEST_BODY_TOO_LARGE",
        message: "视频或照片超过 FieldDesk 单文件100MB限制；大视频请等待自动压缩后再上传",
        missingFields: [],
      });
    }
    const loginRequired = error.code === "RECLOUD_LOGIN_REQUIRED";
    const errors = {
      RECLOUD_LOGIN_REQUIRED: {
        status: 502,
        message: "瑞云登录已失效，请重新初始化登录状态",
      },
      RECLOUD_ORDER_NOT_FOUND: {
        status: 404,
        message: "未找到对应工单，请核对单号",
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
      TREATMENT_REOPEN_FORBIDDEN: {
        status: 403,
        message: error.message,
      },
      TREATMENT_REOPEN_ADMIN_REQUIRED: {
        status: 403,
        message: error.message,
      },
      TREATMENT_REOPEN_RECEIPT_REQUIRED: {
        status: 409,
        message: error.message,
      },
      TREATMENT_REOPEN_SHIPPED: {
        status: 409,
        message: error.message,
      },
      TREATMENT_REOPEN_DUPLICATE: {
        status: 409,
        message: error.message,
      },
      TREATMENT_REOPEN_SYNC_APPLIED: {
        status: 409,
        message: error.message,
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
      RECLOUD_RECEIPT_RESULT_UNKNOWN: {
        status: 409,
        message: "瑞云确认已触发但结果未能核实，禁止重复签收，请管理员人工核对",
      },
      RECLOUD_RECEIPT_RECONCILIATION_REQUIRED: {
        status: 409,
        message: "瑞云签收结果待人工核对，禁止重复提交",
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
      REPAIR_COMPLETION_QUEUE_FAILED: { status: 503, message: "完工资料已保存，但同步任务登记失败，请重试提交；不要重复维修操作" },
      REPORTED_FAULT_REQUIRED: { status: 409, message: "报修描述尚未同步，请重新进入维修页面读取原文；可先保存草稿，暂不能提交完工" },
      REPORTED_FAULT_MISMATCH: { status: 409, message: "维修措施中的报修描述与同步原文不一致，请重新进入维修页面生成后再提交" },
      REPORTED_FAULT_EMPTY: { status: 409, message: "已读取瑞云，但报修描述为空，请核实原文；可先保存草稿" },
      REPORTED_FAULT_ORDER_MISMATCH: { status: 409, message: "瑞云返回的工单不一致，未保存描述，请重新读取" },
      REPAIR_COMPLETION_ALREADY_SUBMITTED: { status: 409, message: "已提交完工的资料不能覆盖为草稿" },
      LOCAL_DATA_CORRUPT: { status: 503, message: "本地工单记录异常，暂不能提交。请保留当前资料，联系负责人恢复记录" },
      FEISHU_MODEL_NETWORK_FAILED: { status: 502, message: "飞书机型表暂时无法连接，机型核验未完成。请保留照片，稍后重试" },
      FEISHU_AUTH_FAILED: { status: 502, message: "飞书机型表认证失败，请联系负责人检查配置" },
      FEISHU_MODEL_READ_FAILED: { status: 502, message: "读取飞书机型表失败，机型核验未完成。请保留照片，稍后重试" },
      PAYROLL_MONTH_INVALID: { status: 400, message: "请选择有效月份" },
      PRINT_ADMIN_REQUIRED: { status: 403, message: "只有负责人或管理员可以配置打印终端" },
      PRINT_AGENT_AUTH_INVALID: { status: 401, message: "打印终端认证失败" },
      PRINT_TERMINAL_INVALID: { status: 400, message: error.message },
      PRINT_TERMINAL_REQUIRED: { status: 400, message: "请选择测试打印终端" },
      PRINT_TERMINAL_FORBIDDEN: { status: 403, message: "当前账号不能使用该打印终端" },
      PRINT_TERMINAL_MEMBER_DUPLICATE: { status: 409, message: error.message },
      PRINT_TERMINAL_NOT_FOUND: { status: 404, message: error.message },
      PRINT_JOB_NOT_FOUND: { status: 404, message: "打印任务不存在" },
    };
    const mapped = errors[error.code];
    // Keep diagnostic type/location, never raw messages, request bodies or tokens.
    const errorName = /^[A-Za-z]{1,40}$/.test(error.name || "") ? error.name : "Error";
    const rawCauseCode = error.cause?.cause?.code || error.cause?.code || "";
    const causeCode = /^[A-Z0-9_]{1,60}$/.test(rawCauseCode) ? rawCauseCode : "";
    const locations = String(error.stack || "").split("\n").slice(1, 4)
      .map(line => line.match(/([A-Za-z0-9_.-]+\.js:\d+:\d+)/)?.[1]).filter(Boolean);
    operationalLogger.write("error", { requestId: res.getHeader("X-Request-Id"), method: req.method, path: req.path, code: error.code || "INTERNAL_ERROR", status: mapped?.status || error.status || 502, errorName, causeCode, locations });
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
    ), {
      background: true,
      channel: "background-supervision",
      timeoutMs: 30000,
      timeoutCode: "RECLOUD_SUPERVISION_READ_TIMEOUT",
    }),
  });
  const pendingReceiptStore = new PendingReceiptStore();
  const rmaQueryCacheStore = new RmaQueryCacheStore();
  const rmaQueryIndexSync = new RmaQueryIndexSync({
    store: rmaQueryCacheStore,
    intervalMs: rmaQueryIndexSyncInterval(process.env),
    readOrders: (context) => withRecloud(
      recloudConnector,
      (page, queue) => recloudConnector.readRecentRmaOrders(page, {
        ...context,
        dateFrom: process.env.RMA_QUERY_INDEX_FROM || recentRmaIndexStart(7),
        listOnly: true,
        maxRecords: Number(process.env.RMA_QUERY_CACHE_CAPACITY || 10000),
        maxPages: Number(process.env.RMA_QUERY_INDEX_MAX_PAGES || 350),
        pageDelay: Number(process.env.RMA_QUERY_INDEX_PAGE_DELAY_MS || 120),
        // This read-only index has its own channel and saves one page at a
        // time. Continuous foreground traffic must not starve all syncing.
        shouldYield: () => false,
      }),
      {
        background: true,
        channel: "background-query-index",
        timeoutMs: 120000,
        timeoutCode: "RECLOUD_QUERY_INDEX_TIMEOUT",
      }
    ),
  });
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
          {
            background: true,
            channel: "background-backfill",
            timeoutMs: 120000,
            timeoutCode: "RECLOUD_BACKFILL_TIMEOUT",
          }
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
        listOnly: true,
        shouldYield: queue.shouldYield,
      }),
      {
        background: true,
        channel: "background-receipts",
        timeoutMs: 120000,
        timeoutCode: "RECLOUD_PENDING_RECEIPTS_TIMEOUT",
      }
    ),
  });
  const printJobStore = new PrintJobStore();
  const app = createApp(recloudConnector, businessStores.receiptStore, {
    recloudWriteAdmissions: new (require('./services/recloud-write-admissions').RecloudWriteAdmissions)(
      path.join(process.env.FIELDDESK_DATA_DIRECTORY || path.join(__dirname, 'database/data'), 'recloud-write-admissions.json')
    ),
    businessStores,
    printJobStore,
    supervisionMonitor,
    pendingReceiptStore,
    rmaQueryCacheStore,
    // The watchdog performs the same recovery in bounded low-priority batches.
    // Keep the legacy one-shot scanners disabled to avoid a restart storm.
    resumePendingRecloudReceipts: false,
    resumePendingRecloudDetections: false,
    resumePendingRecloudServiceOrders: false,
    recloudRecoveryWatchdogEnabled:
      String(process.env.RECLOUD_RECOVERY_WATCHDOG_ENABLED || "true").toLowerCase() !== "false",
    recloudRepairPageAdapterFactory: createRecloudRepairPageAdapter,
    recloudRepairAdapterProvider: {
      run: (task, work) => withRecloud(recloudConnector, async (page) => require('./services/recloud-phase-timing').withRecloudTimingContext(task, async () => {
        const operationStartedAt = Date.now();
        const opened = await require('./services/recloud-phase-timing').timeRecloudPhase(task.rmaNo, 'completion_open_service_order', () => recloudConnector.openExistingRepairServiceOrder(page, {
          rmaNo: task.rmaNo,
          logisticsNo: task.logisticsNo,
          serviceOrderNo: task.payload?.serviceOrderNo,
        }));
        console.info(
          `RECLOUD_REPAIR_TIMING: rma=${task.rmaNo} phase=open_service_order ms=${Date.now() - operationStartedAt} direct=${Boolean(task.payload?.serviceOrderNo)} alreadyOpen=${opened.alreadyOpen === true}`
        );
        const pageText = String(await page.locator("body").innerText().catch(() => ""));
        if (!pageText.includes(String(task.rmaNo || ""))) {
          const error = new Error("瑞云当前页面不是待完工的对应服务单");
          error.code = "RECLOUD_REPAIR_ORDER_MISMATCH";
          error.permanent = true;
          throw error;
        }
        const workStartedAt = Date.now();
        const result = await work(createRecloudRepairPageAdapter(page, {
          rmaNo: task.rmaNo,
          logisticsNo: task.logisticsNo,
          sn: task.sn,
          payload: task.payload,
          printJobStore,
        }));
        console.info(
          `RECLOUD_REPAIR_TIMING: rma=${task.rmaNo} phase=complete_work ms=${Date.now() - workStartedAt} totalMs=${Date.now() - operationStartedAt}`
        );
        return result;
      }), {
        background: true,
        channel: "business-write",
        priority: true,
        affinityKey: task.rmaNo,
        concurrency: recloudBusinessWriteConcurrency(process.env),
        timeoutMs: recloudBusinessWriteTimeoutMs(process.env),
        idleReleaseMs: recloudIdleChannelReleaseMs(process.env),
        timeoutCode: "RECLOUD_REPAIR_COMPLETION_TIMEOUT",
        resultUnknownOnTimeout: true,
      }),
    },
  });
  const tlsOptions = loadTlsOptions(runtimeConfig);
  const server = tlsOptions ? https.createServer(tlsOptions, app) : http.createServer(app);
  server.listen(port, process.env.HOST || undefined, () => {
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
    if (session && rmaQueryIndexSyncEnabled(process.env)) {
      rmaQueryIndexSync.start(true);
    }
    // 批量补全会长时间占用同一个瑞云页面。默认关闭自动补全，保证师傅的
    // 到店查询始终优先；需要维护历史缓存时再显式开启或运行独立脚本。
    if (session && String(process.env.RMA_QUERY_BACKFILL_ENABLED || "false").toLowerCase() === "true") {
      scheduleRmaQueryBackfill(5000);
    }
    if (session?.channel) {
      recloudConnector.releaseRecloudChannel?.(session.channel, {
        idleMs: recloudIdleChannelReleaseMs(process.env),
      });
    }
  }).finally(() => {
    // 监测服务必须持续运行；即使启动时瑞云尚未登录，也要定时重试，
    // 登录恢复后即可自动取得并展示真实督办内容。
    if (monitorEnabled(process.env)) supervisionMonitor.start();
  });
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (process.connected) process.disconnect();
    app.locals.stopRecloudRecoveryWatchdog?.();
    supervisionMonitor.stop();
    pendingReceiptSync.stop();
    rmaQueryIndexSync.stop();
    if (rmaQueryBackfillTimer) clearTimeout(rmaQueryBackfillTimer);
    server.close();
    await recloudConnector.closeRecloud?.();
    await closeFreightWaiverApplicationRenderer().catch(() => {});
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  // When owned by the guardian, do not leave an orphan backend after guardian exit.
  if (process.send) process.once("disconnect", shutdown);
}

module.exports = {
  createRecloudRmaWriteGuard,
  isExpectedRmaStillOpen,
  readReceiptDetailWithReuse,
  readReceiptProjectIdentityWithRetry,
  createApp,
  normalizeLogisticsNo,
  withRecloud,
  isDryRun,
  isRecloudWriteEnabled,
  isRecloudCompletionWriteEnabled,
  isRecloudReceiptWriteEnabled,
  initializeRecloudSession,
  monitorEnabled,
  monitorInterval,
  normalizeMaskedPhone,
  getAllowedRepairSpecialties,
  abandonedReturnPricing,
  getOutOfWarrantyFeePolicy,
  resolveReceiptSpecialty,
  resolvePersistedProjectAuthorization,
  validateReceiptSn,
  recloudBusinessWriteConcurrency,
  recloudBusinessWriteTimeoutMs,
  recloudIdleChannelReleaseMs,
  shouldAutoResumeReceipt,
  shouldAutoResumeDetection,
  shouldAutoResumeServiceOrder,
  recloudRecoverySweepIntervalMs,
  recloudRecoverySweepBatchSize,
};
