const fs = require("fs");

const WEAK_SECRETS = new Set(["password", "admin", "123456", "changeme", "secret", "test"]);

function boolean(value, fallback) {
  if (value === undefined || value === "") return fallback;
  return String(value).toLowerCase() === "true";
}

function validateRuntimeConfig(env = process.env) {
  const environment = String(env.NODE_ENV || "development");
  const production = environment === "production";
  const errors = [];
  const secret = String(env.FIELDDESK_BOOTSTRAP_ADMIN_TOKEN || "");
  if (production) {
    if (!boolean(env.DRY_RUN, true)) errors.push("生产环境当前必须保持 DRY_RUN=true");
    if (boolean(env.RECLOUD_WRITE_ENABLED, false)) errors.push("生产环境当前禁止启用瑞云写入");
    if (boolean(env.RECLOUD_REVEAL_PHONE_ENABLED, false)) errors.push("生产环境当前禁止显示完整电话");
    if (String(env.FIELDDESK_AUTH_MODE || "") !== "accounts") errors.push("生产环境必须启用正式账号模式");
    if (secret && (secret.length < 32 || WEAK_SECRETS.has(secret.toLowerCase()) || /replace|changeme|example/i.test(secret))) errors.push("管理员引导密钥长度至少为 32 位且不能使用默认或弱密钥");
    if (String(env.FIELDDESK_LOCAL_USER_ID || "").startsWith("LOCAL-")) errors.push("生产环境禁止使用本地测试管理员或测试账号");
    if (!String(env.FRONTEND_ORIGIN || "").startsWith("https://")) errors.push("生产环境 FRONTEND_ORIGIN 必须使用 HTTPS");
    if (boolean(env.TLS_ENABLED, false) && (!env.TLS_CERT_FILE || !env.TLS_KEY_FILE)) errors.push("启用 TLS 时必须配置证书和私钥路径");
  }
  if (errors.length) throw Object.assign(new Error("生产配置校验失败"), { code: "PRODUCTION_CONFIG_INVALID", details: errors });
  return {
    environment, production,
    port: Number(env.PORT || 3000),
    trustProxy: env.TRUST_PROXY || (production ? "loopback" : false),
    frontendOrigins: String(env.FRONTEND_ORIGIN || "http://localhost:5173,http://127.0.0.1:5173").split(",").map((item) => item.trim()).filter(Boolean),
    tls: {
      enabled: boolean(env.TLS_ENABLED, false),
      certFile: env.TLS_CERT_FILE || "",
      keyFile: env.TLS_KEY_FILE || "",
    },
  };
}

function loadTlsOptions(config) {
  if (!config.tls.enabled) return null;
  return { cert: fs.readFileSync(config.tls.certFile), key: fs.readFileSync(config.tls.keyFile) };
}

module.exports = { validateRuntimeConfig, loadTlsOptions };
