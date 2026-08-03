const { TASK_STATUS } = require("../database/recloud-sync-outbox");

const NODE_METHODS = Object.freeze({
  RECEIPT: "syncReceipt",
  INSPECTION_COMPLETED: "syncInspectionCompleted",
  REPAIR_COMPLETED: "syncRepairCompleted",
  RETURN_SHIPPED: "syncReturnShipped",
  ORDER_COMPLETED: "syncOrderCompleted",
});

function safeError(error) {
  const allowed = new Set(["RECLOUD_SYNC_NOT_ENABLED", "SYNC_NODE_UNSUPPORTED"]);
  return allowed.has(error?.code) ? error.code : "RECLOUD_SYNC_FAILED";
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
    });
    if (task.status === TASK_STATUS.PENDING) {
      this.scheduler(() => this.processTask(task.id).catch(() => {}));
    }
    return task;
  }

  async processTask(taskId) {
    const task = await this.outbox.get(taskId);
    if (!task || ![TASK_STATUS.PENDING, TASK_STATUS.FAILED].includes(task.status)) return task;
    const method = NODE_METHODS[task.nodeType];
    if (!method || typeof this.adapter[method] !== "function") {
      const error = Object.assign(new Error("不支持的同步节点"), { code: "SYNC_NODE_UNSUPPORTED", permanent: true });
      return this.fail(task, error);
    }
    await this.outbox.update(task.id, { status: TASK_STATUS.PROCESSING, lastError: "" });
    try {
      await this.adapter[method](task);
      return this.outbox.update(task.id, { status: TASK_STATUS.SUCCESS, lastError: "" });
    } catch (error) {
      return this.fail(task, error);
    }
  }

  fail(task, error) {
    const retryCount = Number(task.retryCount || 0) + 1;
    return this.outbox.update(task.id, {
      status: error?.permanent || retryCount >= this.maxRetries
        ? TASK_STATUS.MANUAL_REVIEW
        : TASK_STATUS.FAILED,
      retryCount,
      lastError: safeError(error),
    });
  }

  async retry(taskId) {
    const task = await this.outbox.get(taskId);
    if (!task) throw Object.assign(new Error("同步任务不存在"), { code: "SYNC_TASK_NOT_FOUND", status: 404 });
    if (![TASK_STATUS.FAILED, TASK_STATUS.MANUAL_REVIEW].includes(task.status)) {
      throw Object.assign(new Error("仅失败或待人工处理任务可以重试"), { code: "SYNC_TASK_RETRY_NOT_ALLOWED", status: 409 });
    }
    const pending = await this.outbox.update(taskId, { status: TASK_STATUS.PENDING, lastError: "" });
    this.scheduler(() => this.processTask(taskId).catch(() => {}));
    return pending;
  }
}

module.exports = { NODE_METHODS, RecloudSyncService, safeError };
