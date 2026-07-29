const express = require("express");
const recloudConnector = require("./connectors/recloud");

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

async function withRecloud(connector, operation) {
  const session = await connector.openRecloud();
  try {
    return await operation(session.page);
  } finally {
    await session.browser.close().catch(() => {});
  }
}

function createApp(connector = recloudConnector) {
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
    });
  });

  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  createApp().listen(port, () => {
    console.log(`FieldDesk API 启动成功 http://localhost:${port}`);
    console.log(
      isDryRun()
        ? "安全模式：DRY_RUN=true，禁止最终确认签收"
        : "警告：DRY_RUN=false，允许最终确认签收"
    );
  });
}

module.exports = {
  createApp,
  normalizeLogisticsNo,
  withRecloud,
  isDryRun,
  isRecloudWriteEnabled,
};
