const {
  DIAGNOSTIC_STATUS,
  REQUIRED_CAPTURE_FIELDS,
  RECLOUD_SYNC_NODE_TEMPLATES,
} = require("../config/recloud-sync-node-templates");

const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_.\[\]-]{0,80}$/;
const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

function sanitizePathTemplate(value) {
  const path = String(value || "").split(/[?#]/, 1)[0].trim();
  if (!path.startsWith("/") || path.includes("..")) return "";
  return `/${path.split("/").filter(Boolean).map((segment) => {
    if (/^\{[A-Za-z][A-Za-z0-9_]*\}$/.test(segment)) return segment;
    if (/^\d{5,}$/.test(segment) || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(segment)) return "{id}";
    if (segment.length >= 8 && /[A-Za-z]/.test(segment) && /\d/.test(segment)) return "{id}";
    return segment.replace(/[^A-Za-z0-9_.~{}-]/g, "");
  }).filter(Boolean).join("/")}`;
}

function sanitizeNames(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || "").trim()).filter((value) => FIELD_NAME.test(value)))];
}

function sanitizeFeatures(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || "").trim()).filter((value) => value && value.length <= 80 && !/[=@?]/.test(value)))];
}

class RecloudSyncDiagnosticsService {
  constructor(store) { this.store = store; }

  template(nodeKey) {
    const template = RECLOUD_SYNC_NODE_TEMPLATES[nodeKey];
    if (!template) throw Object.assign(new Error("未知瑞云同步节点"), { code: "SYNC_DIAGNOSTIC_NODE_UNKNOWN", status: 404 });
    return template;
  }

  missingFields(capture) {
    if (!capture) return [...REQUIRED_CAPTURE_FIELDS];
    return REQUIRED_CAPTURE_FIELDS.filter((field) => {
      const value = capture[field];
      return Array.isArray(value) ? value.length === 0 : value === "" || value === null || value === undefined;
    });
  }

  async inspect(nodeKey) {
    const template = this.template(nodeKey);
    const saved = (await this.store.read())[nodeKey] || null;
    const missingFields = this.missingFields(saved);
    return {
      nodeKey, nodeType: template.nodeType, label: template.label,
      status: saved?.diagnosticError
        ? DIAGNOSTIC_STATUS.FAILED
        : !saved
          ? DIAGNOSTIC_STATUS.WAITING_CAPTURE
          : missingFields.length ? DIAGNOSTIC_STATUS.CAPTURED : DIAGNOSTIC_STATUS.READY,
      capture: saved,
      missingFields,
      unresolvedRules: template.unresolvedRules,
      requiredBusinessFields: template.requiredBusinessFields,
    };
  }

  async inspectAll() {
    return Promise.all(Object.keys(RECLOUD_SYNC_NODE_TEMPLATES).map((key) => this.inspect(key)));
  }

  async capture(nodeKey, input = {}) {
    this.template(nodeKey);
    const capture = {
      entryFeatures: sanitizeFeatures(input.entryFeatures),
      httpMethod: HTTP_METHODS.has(String(input.httpMethod || "").toUpperCase()) ? String(input.httpMethod).toUpperCase() : "",
      urlPathTemplate: sanitizePathTemplate(input.urlPathTemplate),
      requestFieldNames: sanitizeNames(input.requestFieldNames),
      responseStatus: Number.isInteger(Number(input.responseStatus)) && Number(input.responseStatus) >= 100 && Number(input.responseStatus) <= 599 ? Number(input.responseStatus) : null,
      responseFieldNames: sanitizeNames(input.responseFieldNames),
      successCriteriaFieldNames: sanitizeNames(input.successCriteriaFieldNames),
      idempotencyFieldNames: sanitizeNames(input.idempotencyFieldNames),
      capturedAt: new Date().toISOString(),
      captureMode: "READ_ONLY_METADATA",
      diagnosticError: "",
    };
    await this.store.save(nodeKey, capture);
    return this.inspect(nodeKey);
  }

  async recordFailure(nodeKey, errorCode = "SYNC_DIAGNOSTIC_CAPTURE_FAILED") {
    this.template(nodeKey);
    await this.store.save(nodeKey, {
      diagnosticError: ["SYNC_DIAGNOSTIC_CAPTURE_FAILED", "SYNC_DIAGNOSTIC_VALIDATION_FAILED"].includes(errorCode)
        ? errorCode : "SYNC_DIAGNOSTIC_CAPTURE_FAILED",
      capturedAt: new Date().toISOString(),
      captureMode: "READ_ONLY_METADATA",
    });
    return this.inspect(nodeKey);
  }
}

module.exports = { RecloudSyncDiagnosticsService, sanitizeFeatures, sanitizeNames, sanitizePathTemplate };
