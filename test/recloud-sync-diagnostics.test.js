const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { JsonRecloudSyncDiagnosticsStore } = require("../database/recloud-sync-diagnostics-store");
const {
  RecloudSyncDiagnosticsService,
  sanitizeEnumStatusValues,
  sanitizeNames,
  sanitizePathTemplate,
} = require("../services/recloud-sync-diagnostics-service");

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fielddesk-sync-diagnostics-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return new RecloudSyncDiagnosticsService(
    new JsonRecloudSyncDiagnosticsStore(path.join(directory, "diagnostics.json"))
  );
}

function completeCapture() {
  return {
    entryFeatures: ["服务管理", "节点表单"],
    httpMethod: "POST",
    urlPathTemplate: "/api/rma/JXTH1234567890/complete?token=must-not-save",
    requestFieldNames: ["rmaNo", "status", "invalid=value"],
    responseStatus: 200,
    responseFieldNames: ["code", "data.status"],
    successCriteriaFieldNames: ["data.status"],
    idempotencyFieldNames: ["rmaNo", "status"],
    enumStatusValues: ["PENDING", "SUCCESS"],
  };
}

test("all five nodes start waiting for capture with explicit missing fields", async (t) => {
  const service = await fixture(t);
  const nodes = await service.inspectAll();
  assert.deepEqual(nodes.map((node) => node.nodeKey), ["receipt", "inspection", "repair", "shipping", "completion"]);
  assert.ok(nodes.every((node) => node.status === "WAITING_CAPTURE"));
  assert.ok(nodes.every((node) => node.missingFields.includes("urlPathTemplate")));
});

test("capture stores only sanitized metadata names and reaches ready status", async (t) => {
  const service = await fixture(t);
  const result = await service.capture("receipt", completeCapture());
  assert.equal(result.status, "READY");
  assert.equal(result.capture.urlPathTemplate, "/api/rma/{id}/complete");
  assert.deepEqual(result.capture.requestFieldNames, ["rmaNo", "status"]);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /must-not-save|JXTH1234567890|invalid=value/);
  assert.doesNotMatch(serialized, /customerName|phone|cookie|token/i);
});

test("partial capture is marked captured and reports missing configuration", async (t) => {
  const service = await fixture(t);
  const result = await service.capture("inspection", {
    entryFeatures: ["检测节点"], httpMethod: "POST",
  });
  assert.equal(result.status, "CAPTURED");
  assert.ok(result.missingFields.includes("urlPathTemplate"));
  assert.ok(result.missingFields.includes("responseFieldNames"));
});

test("sanitizers reject values and remove URL parameters", () => {
  assert.deepEqual(sanitizeNames(["status", "phone=13800000000", "data.result"]), ["status", "data.result"]);
  assert.equal(sanitizePathTemplate("/api/order/123456789?access_token=secret"), "/api/order/{id}");
  assert.equal(sanitizePathTemplate("https://example.com/api"), "");
  assert.deepEqual(
    sanitizeEnumStatusValues(["PENDING", "待检测", "13800138000", "JXTH123456"]),
    ["PENDING", "待检测"]
  );
});

test("diagnostic failure uses fixed safe error code", async (t) => {
  const service = await fixture(t);
  const failed = await service.recordFailure("repair", "raw remote response");
  assert.equal(failed.status, "FAILED");
  assert.equal(failed.capture.diagnosticError, "SYNC_DIAGNOSTIC_CAPTURE_FAILED");
});

test("admin page shows all diagnostic statuses and server routes do not invoke Recloud", async () => {
  const page = await fs.readFile(path.join(__dirname, "../frontend/src/pages/SyncDiagnostics.jsx"), "utf8");
  for (const label of ["未配置", "待采集", "已采集", "可联调", "联调失败"]) assert.match(page, new RegExp(label));
  const server = await fs.readFile(path.join(__dirname, "../server.js"), "utf8");
  const start = server.indexOf('app.get("/api/recloud-sync/diagnostics"');
  const end = server.indexOf('app.post("/api/recloud-sync/tasks/retry"');
  const block = server.slice(start, end);
  assert.match(block, /diagnostics\/\$\{nodeKey\}\/inspect/);
  assert.match(block, /diagnostics\/\$\{nodeKey\}\/capture/);
  assert.doesNotMatch(block, /withRecloud|openRecloud|queryRma|page\./);
});
