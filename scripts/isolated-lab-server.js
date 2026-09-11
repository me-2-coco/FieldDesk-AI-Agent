const path = require("node:path");
const fs = require("node:fs");
const root = path.resolve(__dirname, "..");
if (JSON.parse(fs.readFileSync(path.join(root, "lab-manifest.json"), "utf8")).kind !== "fielddesk-isolated-lab") {
  throw new Error("Not an isolated lab snapshot");
}
process.chdir(root);
const env = {
  NODE_ENV: "development", DRY_RUN: "true", FIELDDESK_AUTH_MODE: "accounts",
  FIELDDESK_LOCAL_USER_ID: "LOCAL-ADMIN", FIELDDESK_STORAGE_DRIVER: "json",
  FIELDDESK_DATA_DIRECTORY: path.join(root, "database/data"), LOG_DIRECTORY: path.join(root, "logs"),
  RECLOUD_WRITE_ENABLED: "false", RECLOUD_RECEIPT_WRITE_ENABLED: "false",
  RECLOUD_INSPECTION_WRITE_ENABLED: "false", RECLOUD_COMPLETION_WRITE_ENABLED: "false",
  RECLOUD_HOLD_WRITE_ENABLED: "false", RECLOUD_LOGIN_AUTOFILL_ENABLED: "false",
  FRONTEND_ORIGIN: "http://127.0.0.1:4174", PORT: "4174",
};
// The launcher gives us a minimal environment. Explicit values also protect
// a manual restart from inheriting write switches from another terminal.
Object.assign(process.env, env);
const crypto = require("node:crypto");
const dataDir = env.FIELDDESK_DATA_DIRECTORY;
fs.mkdirSync(dataDir, { recursive: true });
const accountsFile = path.join(dataDir, "accounts.json");
if (!fs.existsSync(accountsFile)) {
  const password = crypto.randomBytes(9).toString("base64url");
  const passwordHash = crypto.createHash("sha256").update(password).digest("hex");
  const users = [
    ["lab-admin", "隔离测试管理员", "ADMIN"],
    ["lab-tech", "模拟师傅甲", "TECHNICIAN"],
    ["lab-tech2", "模拟师傅乙", "TECHNICIAN"],
  ].map(([userId, displayName, role]) => ({ userId, displayName, role,
    repairSpecialties: ["扫地机", "洗地机"], active: true, allowBearer: false,
    passwordHash, mustChangePassword: false, recloudAssignmentMode: "DIRECT",
  }));
  fs.writeFileSync(accountsFile, JSON.stringify({ users }), { mode: 0o600 });
  fs.writeFileSync(path.join(root, "lab-login.json"), JSON.stringify({ accounts: users.map(u => u.userId), password }), { mode: 0o600 });
  console.log(`LAB_ACCOUNTS=lab-admin,lab-tech,lab-tech2 LAB_PASSWORD=${password}`);
}
const ordersFile = path.join(dataDir, "receipt-preparations.json");
if (!fs.existsSync(ordersFile)) {
  const { createReceiptPreparation } = require("../database/receipt-preparation-store");
  const orders = [1, 2, 3].map(n => createReceiptPreparation({
    rmaNo: `LAB-RMA-000${n}`, logisticsNo: n === 2 ? "" : `LAB-EXPRESS-000${n}`,
    sn: `LABSYNTHETIC000${n}`, customerName: `模拟客户${n}（非真实）`,
    productLine: n === 3 ? "洗地机" : "扫地机", specialty: n === 3 ? "洗地机" : "扫地机",
    productModel: "LAB-模拟机型", reportedFault: "模拟故障，仅用于隔离测试",
    operatorId: n === 3 ? "lab-tech2" : "lab-tech", operatorName: n === 3 ? "模拟师傅乙" : "模拟师傅甲",
  }));
  fs.writeFileSync(ordersFile, JSON.stringify(orders), { mode: 0o600 });
}
const express = require("express");
const { createApp } = require("../server");
const blocked = () => { throw Object.assign(new Error("隔离测试环境禁止连接瑞云或飞书，请使用模拟数据"), {
  code: "ISOLATED_LAB_EXTERNAL_ACCESS_DISABLED", status: 503, permanent: true,
}); };
const connector = new Proxy({}, { get: (_target, key) => key === "then" ? undefined : blocked });
const app = express();
app.use((_req, res, next) => { res.setHeader("X-FieldDesk-Environment", "isolated-lab"); next(); });
app.get("/api/lab-status", (_req, res) => res.json({
  success: true, environment: "isolated-lab", root, externalConnectors: "disabled",
  customerDataCopied: false, syntheticOnly: true,
}));
const api = createApp(connector, null, {
  env, feishuModelCatalog: connector, feishuPartsCatalog: connector,
  recloudRecoveryWatchdogEnabled: false,
  resumePendingRecloudReceipts: false, resumePendingRecloudDetections: false,
  resumePendingRecloudServiceOrders: false,
});
// API security headers deliberately forbid scripts. Do not apply them to
// the same-origin frontend document, which must load its own JS and CSS.
app.use((req, res, next) => req.path.startsWith("/api/") ? api(req, res, next) : next());
app.use((_req, res, next) => {
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; object-src 'none'; base-uri 'self'");
  res.setHeader("X-Content-Type-Options", "nosniff");
  next();
});
const publicDir = path.join(root, "frontend/dist");
const html = fs.readFileSync(path.join(publicDir, "index.html"), "utf8")
  .replace(/<title>.*?<\/title>/, "<title>FieldDesk · 隔离测试</title>")
  .replace("<body>", '<body><div style="position:fixed;top:0;left:0;right:0;z-index:999999;background:#922;color:white;text-align:center;font:14px sans-serif;padding:7px;pointer-events:none">隔离测试环境 · 无真实客户数据 · 瑞云/飞书连接关闭</div>');
app.get(["/", "/index.html"], (_req, res) => res.type("html").send(html));
app.use(express.static(publicDir, { index: false }));
app.use((req, res) => req.path.startsWith("/api/")
  ? res.status(404).json({ success: false, code: "LAB_ROUTE_NOT_FOUND" })
  : res.type("html").send(html));
const server = app.listen(4174, "127.0.0.1", () => console.log("ISOLATED_LAB_URL=http://127.0.0.1:4174"));
server.on("error", error => { console.error(error.message); process.exitCode = 1; });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
