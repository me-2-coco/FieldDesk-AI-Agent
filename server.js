const express = require("express");
if (require.main === module) {
  try {
    process.loadEnvFile?.();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
const recloudConnector = require("./connectors/recloud");
const {
  JsonReceiptPreparationStore,
  normalizeSn,
} = require("./database/receipt-preparation-store");
const {
  USER_ROLES,
  getLocalCurrentUser,
} = require("./config/local-users");

const SUPPORTED_REPAIR_SPECIALTIES = Object.freeze(["扫地机", "洗地机"]);

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

async function withRecloud(connector, operation) {
  const previous = withRecloud.queues.get(connector) || Promise.resolve();
  const current = previous.catch(() => {}).then(async () => {
    const session = await connector.openRecloud();
    return await operation(session.page);
  });
  withRecloud.queues.set(connector, current);
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
  receiptStore = new JsonReceiptPreparationStore(),
  options = {}
) {
  const currentUserProvider =
    options.getCurrentUser || (() => getLocalCurrentUser());
  const app = express();
  app.use(express.json({ limit: "100kb" }));

  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", process.env.FRONTEND_ORIGIN || "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  app.get("/api/health", (req, res) => {
    res.json({
      success: true,
      service: "fielddesk-api",
      dryRun: isDryRun(),
      recloudWriteEnabled: isRecloudWriteEnabled(),
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

  app.post("/api/crm/repairs/query", async (req, res, next) => {
    const logisticsNo = normalizeLogisticsNo(req.body?.logisticsNo);
    if (!logisticsNo) {
      return res.status(400).json({ success: false, message: "缺少物流单号" });
    }

    try {
      const data = await withRecloud(connector, (page) =>
        connector.queryRmaByLogisticsNo(page, logisticsNo)
      );
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
          await connector.queryRmaByLogisticsNo(page, logisticsNo);
          return connector.simulateReceiptForm(page, sn, remark, {
            dryRun: true,
            writeEnabled: false,
          });
        });
        return res.json({ success: true, data });
      } catch (error) {
        return next(error);
      }
    }
  );

  app.post("/api/crm/repairs/receive", async (req, res, next) => {
    if (!isRecloudWriteEnabled()) {
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
        await connector.scanSign(page, logisticsNo);
        const detail = await connector.getRepairDetail(page, logisticsNo);
        const sn = requestedSn || detail.sn;
        if (!sn) throw new Error("CRM 工单没有 SN，请手动提供 SN");
        const receipt = await connector.confirmSign(
          page,
          sn,
          detail.productType,
          requestedRemark,
          { dryRun: isDryRun() }
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
      const data = await receiptStore.prepare({
        logisticsNo,
        rmaNo,
        sn,
        specialty,
        remark,
        productLine,
        customerName: String(req.body?.customerName || "").trim(),
        reportedFault: String(req.body?.reportedFault || "").trim(),
        phoneMasked: normalizeMaskedPhone(req.body?.phoneMasked),
        operatorId: currentUser.userId,
        operatorName: currentUser.displayName,
      });
      return res.json({
        success: true,
        data: {
          ...data,
          message: "签收资料已准备，尚未同步瑞云",
          dryRun: true,
          recloudSynced: false,
        },
      });
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
      code: loginRequired ? "RECLOUD_LOGIN_REQUIRED" : error.code || "RECLOUD_ERROR",
      message: mapped?.message || error.message || "瑞云 CRM 请求失败",
      missingFields: Array.isArray(error.missingFields)
        ? error.missingFields
        : [],
      inspection: error.inspection || undefined,
      simulation: error.simulation || undefined,
    });
  });

  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const app = createApp();
  const server = app.listen(port, () => {
    console.log(`FieldDesk API 启动成功 http://localhost:${port}`);
    console.log(
      isDryRun()
        ? "安全模式：DRY_RUN=true，禁止最终确认签收"
        : "警告：DRY_RUN=false，允许最终确认签收"
    );
  });
  initializeRecloudSession(recloudConnector);
  const shutdown = async () => {
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
  normalizeMaskedPhone,
  getAllowedRepairSpecialties,
  resolveReceiptSpecialty,
  validateReceiptSn,
};
