const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { validateRuntimeConfig } = require("../config/runtime-config");
const { createRateLimiter, RotatingJsonLogger } = require("../services/operational-security");
const { LocalRepairAttachmentStore, DEFAULT_MAX_FILE_BYTES } = require("../database/repair-attachment-store");
const { MemoryDocumentBackend } = require("../database/storage-backend");
const { WorkCoordinationStore } = require("../database/work-coordination-store");

test("production configuration rejects unsafe switches, weak secrets and local accounts", () => {
  const safe = { NODE_ENV: "production", DRY_RUN: "true", RECLOUD_WRITE_ENABLED: "false", RECLOUD_REVEAL_PHONE_ENABLED: "false", FIELDDESK_AUTH_MODE: "accounts", FIELDDESK_BOOTSTRAP_ADMIN_TOKEN: "a".repeat(40), FRONTEND_ORIGIN: "https://fielddesk.example.com" };
  assert.equal(validateRuntimeConfig(safe).production, true);
  assert.throws(() => validateRuntimeConfig({ ...safe, RECLOUD_WRITE_ENABLED: "true" }), { code: "PRODUCTION_CONFIG_INVALID" });
  assert.throws(() => validateRuntimeConfig({ ...safe, FIELDDESK_BOOTSTRAP_ADMIN_TOKEN: "password" }), { code: "PRODUCTION_CONFIG_INVALID" });
  assert.throws(() => validateRuntimeConfig({ ...safe, FIELDDESK_BOOTSTRAP_ADMIN_TOKEN: "REPLACE_WITH_A_LONG_DEFAULT_SECRET_VALUE" }), { code: "PRODUCTION_CONFIG_INVALID" });
  assert.throws(() => validateRuntimeConfig({ ...safe, FIELDDESK_LOCAL_USER_ID: "LOCAL-ADMIN" }), { code: "PRODUCTION_CONFIG_INVALID" });
});

test("rate limiter rejects excess requests without logging request data", () => {
  const limiter = createRateLimiter({ limit: 1 });
  const req = { ip: "127.0.0.1", socket: {} };
  let status = 0; let payload;
  const res = { status(value) { status = value; return this; }, json(value) { payload = value; return value; } };
  limiter(req, res, () => {});
  limiter(req, res, () => assert.fail("second request must not pass"));
  assert.equal(status, 429);
  assert.equal(payload.code, "RATE_LIMITED");
});

test("rotating logger writes structured safe records and rotates by size", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fielddesk-logs-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const logger = new RotatingJsonLogger({ directory, maxBytes: 1, retention: 2 });
  logger.write("application", { method: "GET", path: "/api/health", status: 200 });
  logger.write("application", { method: "GET", path: "/api/ready", status: 200 });
  const files = await fs.readdir(directory);
  assert.ok(files.some((name) => name.startsWith("application.log.")));
  assert.doesNotMatch((await fs.readFile(path.join(directory, "application.log"), "utf8")), /cookie|token|password/i);
});

test("attachment storage enforces type, extension, file and capacity limits", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fielddesk-upload-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new LocalRepairAttachmentStore(directory, { maxFileBytes: 4, maxStorageBytes: 4, allowedMimeTypes: ["image/png"] });
  await store.save({ rmaNo: "RMA-1", name: "proof.png", mimeType: "image/png", data: Buffer.from("1234").toString("base64") });
  await assert.rejects(() => store.save({ rmaNo: "RMA-1", name: "proof.jpg", mimeType: "image/png", data: "MQ==" }), { code: "REPAIR_ATTACHMENT_INVALID" });
  await assert.rejects(() => store.save({ rmaNo: "RMA-1", name: "next.png", mimeType: "image/png", data: "MQ==" }), { code: "ATTACHMENT_STORAGE_LIMIT" });
});

test("attachment storage accepts compressed WebM video up to 100MB", async () => {
  assert.equal(DEFAULT_MAX_FILE_BYTES, 100_000_000);
  const store = new LocalRepairAttachmentStore("/tmp/not-used", { maxStorageBytes: 200_000_000 });
  assert.equal(store.allowedMimeTypes.has("video/webm"), true);
});

test("deployment assets keep secrets and runtime data outside images and Git", async () => {
  const root = path.join(__dirname, "..");
  const files = ["Dockerfile", "docker-compose.yml", "deploy/nginx/fielddesk.conf", "deploy/systemd/fielddesk.service", "docs/OPERATIONS_RUNBOOK.md"];
  for (const file of files) assert.ok((await fs.stat(path.join(root, file))).isFile());
  const ignore = await fs.readFile(path.join(root, ".gitignore"), "utf8");
  for (const value of ["logs/", "backups/", "*.sqlite", "certs/"]) assert.match(ignore, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("audit retention removes expired records and caps stored entries", async () => {
  let now = Date.now();
  const backend = new MemoryDocumentBackend({ locks: {}, idempotency: {}, audits: [{ createdAt: new Date(now - 3 * 86400_000).toISOString() }] });
  const store = new WorkCoordinationStore({ backend, now: () => now, auditRetentionDays: 1, auditMaxEntries: 2 });
  await store.audit({ action: "one" });
  await store.audit({ action: "two" });
  assert.deepEqual((await store.listAudits()).map((item) => item.action), ["one", "two"]);
});

test("server exposes liveness, readiness and operational security middleware", async () => {
  const source = await fs.readFile(path.join(__dirname, "../server.js"), "utf8");
  assert.match(source, /\/api\/health/);
  assert.match(source, /\/api\/ready/);
  assert.match(source, /securityHeaders/);
  assert.match(source, /createRateLimiter/);
  assert.match(source, /loadTlsOptions/);
});
