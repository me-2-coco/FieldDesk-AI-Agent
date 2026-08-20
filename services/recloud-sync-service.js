const { TASK_STATUS } = require("../database/recloud-sync-outbox");
const { MAPPING_VERSION, buildNodePayload } = require("../connectors/recloud-sync-mapping");

const NODE_METHODS = Object.freeze({
  RECEIPT: "syncReceipt",
  INSPECTION_COMPLETED: "syncInspectionCompleted",
  REPAIR_COMPLETED: "syncRepairCompleted",
  RETURN_SHIPPED: "syncReturnShipped",
  ORDER_COMPLETED: "syncOrderCompleted",
});

function classifyError(error) {
  const classifications = {
    RECLOUD_SYNC_NOT_ENABLED: ["DISABLED", false],
    RECLOUD_SYNC_VALIDATION_FAILED: ["VALIDATION", false],
    SYNC_NODE_UNSUPPORTED: ["VALIDATION", false],
    RECLOUD_LOGIN_REQUIRED: ["AUTH", false],
    RECLOUD_SCHEMA_CHANGED: ["SCHEMA_CHANGED", false],
    RECLOUD_QUERY_TIMEOUT: ["TIMEOUT", true],
    RECLOUD_RATE_LIMITED: ["RATE_LIMIT", true],
    RECLOUD_NETWORK_ERROR: ["NETWORK", true],
  };
  const [category, retryable] = classifications[error?.code] || ["UNKNOWN", true];
  return { category, retryable, safeCode: classifications[error?.code] ? error.code : "RECLOUD_SYNC_FAILED" };
}

class RecloudSyncService {
  constructor(outbox, adapter, options = {}) {
    this.outbox = outbox;
    this.adapter = adapter;
    this.maxRetries = options.maxRetries || 3;
    this.scheduler = options.scheduler || ((work) => setImmediate(work));
  }

  async enqueueOrderNode(order, nodeType, localBusinessRecordId) {
    const task = await this.outbox.enqueue({
      workOrderNo: order.id || order.rmaNo,
      rmaNo: order.rmaNo,
      logisticsNo: order.logisticsNo,
      sn: order.sn,
      nodeType,
      localBusinessRecordId,
      idempotencyKey: `${nodeType}:${order.id || order.rmaNo}`,
      mappingVersion: MAPPING_VERSION,
      payload: buildNodePayload(order, nodeType),
    });
    if (task.status === TASK_STATUS.PENDING) {
      this.scheduler(() => this.processTask(task.id).catch(() => {}));
    }
    return task;
  }

  async processTask(taskId) {
    const task = await this.outbox.get(taskId);
    if (!task || ![TASK_STATUS.PENDING, TASK_STATUS.FAILED].includes(task.status)) return task;
    await this.outbox.transition(task.id, TASK_STATUS.PROCESSING, { lastError: "", errorCategory: "" });
    const method = NODE_METHODS[task.nodeType];
    if (!method || typeof this.adapter[method] !== "function") {
      const error = Object.assign(new Error("不支持的同步节点"), { code: "SYNC_NODE_UNSUPPORTED", permanent: true });
      return this.fail(task, error);
    }
    try {
      await this.adapter[method](task);
      return this.outbox.transition(task.id, TASK_STATUS.SUCCESS, { lastError: "", errorCategory: "" });
    } catch (error) {
      return this.fail(task, error);
    }
  }

  fail(task, error) {
    const retryCount = Number(task.retryCount || 0) + 1;
    const classification = classifyError(error);
    const nextStatus = error?.permanent || !classification.retryable || retryCount >= this.maxRetries
      ? TASK_STATUS.MANUAL_REVIEW
      : TASK_STATUS.FAILED;
    return this.outbox.transition(task.id, nextStatus, {
      retryCount,
      lastError: classification.safeCode,
      errorCategory: classification.category,
    });
  }

  async retry(taskId) {
    const task = await this.outbox.get(taskId);
    if (!task) throw Object.assign(new Error("同步任务不存在"), { code: "SYNC_TASK_NOT_FOUND", status: 404 });
    if (![TASK_STATUS.FAILED, TASK_STATUS.MANUAL_REVIEW].includes(task.status)) {
      throw Object.assign(new Error("仅失败或待人工处理任务可以重试"), { code: "SYNC_TASK_RETRY_NOT_ALLOWED", status: 409 });
    }
    const pending = await this.outbox.transition(taskId, TASK_STATUS.PENDING, { lastError: "", errorCategory: "" });
    this.scheduler(() => this.processTask(taskId).catch(() => {}));
    return pending;
  }
}

module.exports = { NODE_METHODS, RecloudSyncService, classifyError };
