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
  if (error?.resultUnknown === true || /(?:RESULT_UNKNOWN|PROCESS_INTERRUPTED)$/.test(String(error?.code || ""))) {
    return { category: "RESULT_UNKNOWN", retryable: false, safeCode: "RECLOUD_SYNC_RESULT_UNKNOWN" };
  }
  const classifications = {
    RECLOUD_SYNC_NOT_ENABLED: ["DISABLED", false],
    RECLOUD_SYNC_DIAGNOSTICS_NOT_READY: ["DIAGNOSTICS", false],
    RECLOUD_SYNC_COMMAND_NOT_IMPLEMENTED: ["DISABLED", false],
    RECLOUD_SYNC_VALIDATION_FAILED: ["VALIDATION", false],
    SYNC_NODE_UNSUPPORTED: ["VALIDATION", false],
    RECLOUD_LOGIN_REQUIRED: ["AUTH", false],
    RECLOUD_SCHEMA_CHANGED: ["SCHEMA_CHANGED", false],
    RECLOUD_QUERY_TIMEOUT: ["TIMEOUT", true],
    RECLOUD_RATE_LIMITED: ["RATE_LIMIT", true],
    RECLOUD_NETWORK_ERROR: ["NETWORK", true],
  };
  if (classifications[error?.code]) {
    const [category, retryable] = classifications[error.code];
    return { category, retryable, safeCode: error.code };
  }
  if (/^RECLOUD_REPAIR_[A-Z0-9_]+$/.test(String(error?.code || ""))) {
    return {
      category: String(error?.phase || "REPAIR").replace(/[^A-Z0-9_]/g, "").slice(0, 40) || "REPAIR",
      retryable: error?.permanent !== true,
      safeCode: error.code,
    };
  }
  return { category: "UNKNOWN", retryable: true, safeCode: "RECLOUD_SYNC_FAILED" };
}

class RecloudSyncService {
  constructor(outbox, adapter, options = {}) {
    this.outbox = outbox;
    this.adapter = adapter;
    this.maxRetries = options.maxRetries || 3;
    this.scheduler = options.scheduler || ((work) => setImmediate(work));
    this.retryDelaysMs = Array.isArray(options.retryDelaysMs) && options.retryDelaysMs.length
      ? options.retryDelaysMs.map((value) => Math.max(0, Number(value) || 0))
      : [1000, 3000, 10000];
    this.retryScheduler = options.retryScheduler || ((work, delayMs) => {
      const timer = setTimeout(work, delayMs);
      timer.unref?.();
      return timer;
    });
    this.onRepairPartsShortage = options.onRepairPartsShortage || null;
    this.onInspectionOnlyAwaitingInformation = options.onInspectionOnlyAwaitingInformation || null;
    this.refreshTaskPayload = options.refreshTaskPayload || null;
    this.canProcessTask = typeof options.canProcessTask === "function" ? options.canProcessTask : null;
    this.dependencyPollMs = Math.max(250, Number(options.dependencyPollMs || 1000));
    this.taskFilter = typeof options.taskFilter === "function" ? options.taskFilter : () => true;
    this.staleProcessingMs = Number(options.staleProcessingMs || 45_000);
    this.activeTaskIds = new Set();
    this.scheduledTaskIds = new Set();
    this.resumeQueue = Promise.resolve();
  }

  scheduleTask(taskId, scheduler = this.scheduler) {
    if (this.scheduledTaskIds.has(taskId)) return false;
    this.scheduledTaskIds.add(taskId);
    try {
      scheduler(() => this.processTask(taskId).catch(() => {}));
    } catch (error) {
      this.scheduledTaskIds.delete(taskId);
      throw error;
    }
    return true;
  }

  async enqueueOrderNode(order, nodeType, localBusinessRecordId) {
    const task = await this.outbox.enqueue({
      workOrderNo: order.id || order.rmaNo,
      rmaNo: order.rmaNo,
      logisticsNo: order.logisticsNo,
      sn: order.sn,
      nodeType,
      localBusinessRecordId,
      idempotencyKey: `${nodeType}:${order.id || order.rmaNo}:${String(localBusinessRecordId || "").trim()}`,
      mappingVersion: MAPPING_VERSION,
      payload: buildNodePayload(order, nodeType),
    });
    if (task.status === TASK_STATUS.PENDING) {
      if (this.taskFilter(task)) this.scheduleTask(task.id);
    }
    return task;
  }

  resumePendingTasks(options = {}) {
    const operation = this.resumeQueue.then(() => this.resumePendingTasksOnce(options));
    this.resumeQueue = operation.catch(() => {});
    return operation;
  }

  async resumePendingTasksOnce(options = {}) {
    const allTasks = await this.outbox.readAll();
    const now = Date.now();
    const minFailedAgeMs = Math.max(0, Number(options.minFailedAgeMs || 0));
    const maxTasks = Number.isFinite(Number(options.maxTasks))
      ? Math.max(0, Math.floor(Number(options.maxTasks)))
      : Infinity;
    const stoppedNormalRepairs = allTasks.filter((task) =>
      this.taskFilter(task)
      && task.nodeType === "REPAIR_COMPLETED"
      && task.status === TASK_STATUS.SUCCESS
      && task.resultStatus === "AWAITING_INFORMATION_CLERK"
      && String(task.payload?.treatmentMode || "").trim() !== "INSPECTION_ONLY"
    ).slice(0, maxTasks);
    for (const task of stoppedNormalRepairs) {
      await this.outbox.reopenStoppedHandoff(task.id, {
        lastError: "",
        errorCategory: "RECOVERY",
      });
    }
    const staleProcessingTasks = allTasks.filter((task) =>
      !this.activeTaskIds.has(task.id)
      && !this.scheduledTaskIds.has(task.id)
      && this.taskFilter(task)
      && task.status === TASK_STATUS.PROCESSING
      && Number.isFinite(Date.parse(task.updatedAt))
      && now - Date.parse(task.updatedAt) >= this.staleProcessingMs
    );
    for (const task of staleProcessingTasks) {
      await this.outbox.transition(task.id, TASK_STATUS.MANUAL_REVIEW, {
        lastError: "RECLOUD_SYNC_PROCESS_INTERRUPTED",
        errorCategory: "RESULT_UNKNOWN",
        reconciliationRequired: true,
      });
    }
    const tasks = (await this.outbox.readAll()).filter((task) =>
      !this.activeTaskIds.has(task.id) && !this.scheduledTaskIds.has(task.id) && this.taskFilter(task) && (
        task.status === TASK_STATUS.PENDING
        || (task.status === TASK_STATUS.FAILED
          && Number(task.retryCount || 0) < this.maxRetries
          && now - Date.parse(task.updatedAt || 0) >= minFailedAgeMs)
      )
    ).sort((left, right) => String(left.updatedAt || "").localeCompare(String(right.updatedAt || "")))
      .slice(0, maxTasks);
    for (const task of tasks) {
      this.scheduleTask(task.id);
    }
    return tasks.length;
  }

  async processTask(taskId) {
    this.scheduledTaskIds.delete(taskId);
    if (this.activeTaskIds.has(taskId)) return this.outbox.get(taskId);
    this.activeTaskIds.add(taskId);
    try {
      return await this.processTaskOnce(taskId);
    } finally {
      this.activeTaskIds.delete(taskId);
    }
  }

  async processTaskOnce(taskId) {
    let task = await this.outbox.get(taskId);
    if (!task || ![TASK_STATUS.PENDING, TASK_STATUS.FAILED].includes(task.status)) return task;
    if (!this.taskFilter(task)) return task;
    // Completion can be submitted in FieldDesk before the independent Recloud
    // repair-preparation job has finished. Keep it pending without consuming a
    // retry or opening a competing browser flow until that dependency is ready.
    if (this.canProcessTask && !(await this.canProcessTask(task))) {
      this.scheduleTask(task.id, (work) => this.retryScheduler(work, this.dependencyPollMs));
      return task;
    }
    // A retry may happen minutes after the task was first queued.  Always rebuild
    // failed-task payloads from the current order so recovery sees preparation,
    // attachments and fee changes made after the original attempt.
    if (task.status === TASK_STATUS.FAILED && typeof this.refreshTaskPayload === "function") {
      const refreshed = await this.refreshTaskPayload(task);
      if (refreshed?.payload || refreshed?.mappingVersion) {
        task = await this.outbox.update(task.id, {
          ...(refreshed?.payload ? { payload: refreshed.payload } : {}),
          ...(refreshed?.mappingVersion ? { mappingVersion: refreshed.mappingVersion } : {}),
        });
      }
    }
    await this.outbox.transition(task.id, TASK_STATUS.PROCESSING, { lastError: "", errorCategory: "" });
    const method = NODE_METHODS[task.nodeType];
    if (!method || typeof this.adapter[method] !== "function") {
      const error = Object.assign(new Error("不支持的同步节点"), { code: "SYNC_NODE_UNSUPPORTED", permanent: true });
      return this.fail(task, error);
    }
    try {
      const result = await this.adapter[method](task);
      const resultStatus = String(result?.status || "");
      if (task.nodeType === "REPAIR_COMPLETED" && resultStatus === "AWAITING_PARTS") {
        if (typeof this.onRepairPartsShortage === "function") {
          await this.onRepairPartsShortage(task, result);
        }
        return this.outbox.transition(task.id, TASK_STATUS.SUCCESS, {
          lastError: "",
          errorCategory: "",
          resultStatus,
          missingParts: Array.isArray(result.missingParts) ? result.missingParts : [],
          completedSteps: Array.isArray(result.completedSteps) ? result.completedSteps.slice(0, 20) : [],
        });
      }
      if (task.nodeType === "REPAIR_COMPLETED" && resultStatus === "AWAITING_INFORMATION_CLERK") {
        if (typeof this.onInspectionOnlyAwaitingInformation === "function") {
          await this.onInspectionOnlyAwaitingInformation(task, result);
        }
        return this.outbox.transition(task.id, TASK_STATUS.SUCCESS, {
          lastError: "",
          errorCategory: "",
          resultStatus,
          completedSteps: Array.isArray(result.completedSteps) ? result.completedSteps.slice(0, 20) : [],
        });
      }
      if (task.nodeType === "REPAIR_COMPLETED" && resultStatus === "MANUAL_REVIEW") {
        return this.outbox.transition(task.id, TASK_STATUS.MANUAL_REVIEW, {
          lastError: "RECLOUD_REPAIR_MANUAL_REVIEW",
          errorCategory: "BUSINESS_CONFLICT",
          resultStatus,
          reviewSteps: [...new Set((Array.isArray(result.reviewReasons) ? result.reviewReasons : [])
            .map((item) => String(item?.step || "").trim())
            .filter(Boolean))].slice(0, 10),
        });
      }
      if (task.nodeType === "REPAIR_COMPLETED" && resultStatus === "READY_DRY_RUN") {
        return this.outbox.transition(task.id, TASK_STATUS.READY_DRY_RUN, {
          lastError: "",
          errorCategory: "",
          resultStatus,
        });
      }
      if (task.nodeType === "REPAIR_COMPLETED" && resultStatus === "AWAITING_FINAL_CONFIRM") {
        return this.outbox.transition(task.id, TASK_STATUS.AWAITING_FINAL_CONFIRM, {
          lastError: "",
          errorCategory: "",
          resultStatus,
          completedSteps: Array.isArray(result.completedSteps) ? result.completedSteps.slice(0, 20) : [],
        });
      }
      return this.outbox.transition(task.id, TASK_STATUS.SUCCESS, { lastError: "", errorCategory: "", resultStatus: resultStatus || "SUCCESS" });
    } catch (error) {
      return this.fail(task, error);
    }
  }

  async fail(task, error) {
    const retryCount = Number(task.retryCount || 0) + 1;
    const classification = classifyError(error);
    const nextStatus = error?.permanent || !classification.retryable || retryCount >= this.maxRetries
      ? TASK_STATUS.MANUAL_REVIEW
      : TASK_STATUS.FAILED;
    console.error(
      `RECLOUD_SYNC_TASK_FAILED: node=${task.nodeType} rma=${task.rmaNo} code=${error?.code || "UNKNOWN"} phase=${error?.phase || "UNKNOWN"}`,
      JSON.stringify({ name: error?.name || "Error", message: String(error?.message || "").slice(0, 1000) })
    );
    const failed = await this.outbox.transition(task.id, nextStatus, {
      retryCount,
      lastError: classification.safeCode,
      errorCategory: classification.category,
      reconciliationRequired: classification.category === "RESULT_UNKNOWN",
    });
    if (nextStatus === TASK_STATUS.FAILED) {
      const delayMs = this.retryDelaysMs[Math.min(retryCount - 1, this.retryDelaysMs.length - 1)];
      this.scheduleTask(task.id, (work) => this.retryScheduler(work, delayMs));
    }
    return failed;
  }

  async retry(taskId) {
    const task = await this.outbox.get(taskId);
    if (!task) throw Object.assign(new Error("同步任务不存在"), { code: "SYNC_TASK_NOT_FOUND", status: 404 });
    if (task.reconciliationRequired || task.errorCategory === "RESULT_UNKNOWN") {
      throw Object.assign(new Error("上次提交结果未知，必须先核对瑞云实际结果，禁止直接重复提交"), {
        code: "SYNC_TASK_RECONCILIATION_REQUIRED", status: 409,
      });
    }
    const canReconcileStoppedHandoff = task.status === TASK_STATUS.SUCCESS
      && ["AWAITING_PARTS", "AWAITING_INFORMATION_CLERK"].includes(task.resultStatus);
    if (![TASK_STATUS.FAILED, TASK_STATUS.MANUAL_REVIEW, TASK_STATUS.READY_DRY_RUN].includes(task.status) && !canReconcileStoppedHandoff) {
      throw Object.assign(new Error("仅失败、待人工处理或演练就绪任务可以重新执行"), { code: "SYNC_TASK_RETRY_NOT_ALLOWED", status: 409 });
    }
    const refreshed = typeof this.refreshTaskPayload === "function"
      ? await this.refreshTaskPayload(task)
      : null;
    const retryFields = {
      lastError: "",
      errorCategory: "",
      ...(refreshed?.payload ? { payload: refreshed.payload } : {}),
      ...(refreshed?.mappingVersion ? { mappingVersion: refreshed.mappingVersion } : {}),
    };
    const pending = canReconcileStoppedHandoff
      ? await this.outbox.reopenStoppedHandoff(taskId, retryFields)
      : await this.outbox.transition(taskId, TASK_STATUS.PENDING, retryFields);
    // An explicit retry should not wait behind an older backoff timer. The
    // active-task guard still prevents both callbacks from writing together.
    this.scheduledTaskIds.delete(taskId);
    this.scheduleTask(taskId);
    return pending;
  }

  async getTask(taskId) {
    return this.outbox.get(taskId);
  }

  cancelOrderNodes(rmaNo, nodeTypes, options = {}) {
    return this.outbox.cancelForOrder(rmaNo, nodeTypes, options);
  }
}

module.exports = { NODE_METHODS, RecloudSyncService, classifyError };
