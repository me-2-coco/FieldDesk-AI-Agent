const express = require("express");
const recloudConnector = require("./connectors/recloud");

function normalizeLogisticsNo(value) {
  return String(value || "").trim();
}

function isDryRun(env = process.env) {
  // 安全默认：仅显式设置 DRY_RUN=false 才允许最终确认。
  return String(env.DRY_RUN ?? "true").toLowerCase() !== "false";
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
    });
  });

  app.post("/api/crm/repairs/query", async (req, res, next) => {
    const logisticsNo = normalizeLogisticsNo(req.body?.logisticsNo);
    if (!logisticsNo) {
      return res.status(400).json({ success: false, message: "缺少物流单号" });
    }

    try {
      const data = await withRecloud(connector, async (page) => {
        await connector.scanSign(page, logisticsNo);
        return connector.getRepairDetail(page, logisticsNo);
      });
      return res.json({ success: true, data });
    } catch (error) {
      return next(error);
    }
  });

  app.post("/api/crm/repairs/receive", async (req, res, next) => {
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
    console.error("CRM request failed:", error.message);
    if (res.headersSent) return next(error);
    const loginRequired =
      error.code === "RECLOUD_LOGIN_REQUIRED" ||
      /auth4\.recloud\.com\.cn/i.test(String(error.message || ""));
    return res.status(502).json({
      success: false,
      message: loginRequired
        ? "请重新初始化瑞云登录状态"
        : error.message || "瑞云 CRM 请求失败",
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

module.exports = { createApp, normalizeLogisticsNo, withRecloud, isDryRun };
