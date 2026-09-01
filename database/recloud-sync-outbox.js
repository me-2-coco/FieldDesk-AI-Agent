const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const DEFAULT_FILE = path.join(__dirname, "data", "recloud-sync-outbox.json");
const TASK_STATUS = Object.freeze({
  PENDING: "PENDING",
  PROCESSING: "PROCESSING",
  SUCCESS: "SUCCESS",
  FAILED: "FAILED",
  MANUAL_REVIEW: "MANUAL_REVIEW",
  READY_DRY_RUN: "READY_DRY_RUN",
  AWAITING_FINAL_CONFIRM: "AWAITING_FINAL_CONFIRM",
});
const TASK_TRANSITIONS = Object.freeze({
  PENDING: [TASK_STATUS.PROCESSING],
  PROCESSING: [TASK_STATUS.SUCCESS, TASK_STATUS.FAILED, TASK_STATUS.MANUAL_REVIEW, TASK_STATUS.READY_DRY_RUN, TASK_STATUS.AWAITING_FINAL_CONFIRM],
  FAILED: [TASK_STATUS.PENDING, TASK_STATUS.PROCESSING, TASK_STATUS.MANUAL_REVIEW],
  MANUAL_REVIEW: [TASK_STATUS.PENDING],
  READY_DRY_RUN: [TASK_STATUS.PENDING, TASK_STATUS.PROCESSING],
  AWAITING_FINAL_CONFIRM: [TASK_STATUS.SUCCESS, TASK_STATUS.MANUAL_REVIEW],
  SUCCESS: [],
});

class JsonRecloudSyncOutbox {
  constructor(filePath = DEFAULT_FILE) {
    this.filePath = filePath;
    this.queue = Promise.resolve();
  }

  async readAll() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  async writeAll(tasks) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(tasks, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, this.filePath);
  }

  run(work) {
    const operation = this.queue.then(async () => {
      const tasks = await this.readAll();
      const result = await work(tasks);
      await this.writeAll(tasks);
      return result;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  enqueue(input) {
    return this.run((tasks) => {
      const idempotencyKey = String(input.idempotencyKey || "").trim();
      const existing = tasks.find((task) => task.idempotencyKey === idempotencyKey);
      if (existing) return existing;
      const now = new Date().toISOString();
      const task = {
        id: crypto.randomUUID(),
        workOrderNo: String(input.workOrderNo || "").trim(),
        rmaNo: String(input.rmaNo || "").trim(),
        logisticsNo: String(input.logisticsNo || "").trim(),
        sn: String(input.sn || "").trim().toUpperCase(),
        nodeType: String(input.nodeType || "").trim(),
        localBusinessRecordId: String(input.localBusinessRecordId || "").trim(),
        idempotencyKey,
        createdAt: now,
        updatedAt: now,
        status: TASK_STATUS.PENDING,
        retryCount: 0,
        lastError: "",
        errorCategory: "",
        mappingVersion: String(input.mappingVersion || "v1"),
        payload: input.payload && typeof input.payload === "object" ? input.payload : {},
      };
      tasks.push(task);
      return task;
    });
  }

  update(taskId, fields) {
    return this.run((tasks) => {
      const task = tasks.find((item) => item.id === taskId);
      if (!task) throw Object.assign(new Error("同步任务不存在"), { code: "SYNC_TASK_NOT_FOUND", status: 404 });
      Object.assign(task, fields, { updatedAt: new Date().toISOString() });
      return task;
    });
  }

  transition(taskId, nextStatus, fields = {}) {
    return this.run((tasks) => {
      const task = tasks.find((item) => item.id === taskId);
      if (!task) throw Object.assign(new Error("同步任务不存在"), { code: "SYNC_TASK_NOT_FOUND", status: 404 });
      const allowed = TASK_TRANSITIONS[task.status] || [];
      if (!allowed.includes(nextStatus)) {
        throw Object.assign(new Error("同步任务状态流转不合法"), {
          code: "SYNC_TASK_TRANSITION_INVALID", status: 409,
        });
      }
      Object.assign(task, fields, { status: nextStatus, updatedAt: new Date().toISOString() });
      return task;
    });
  }

  async get(taskId) {
    return (await this.readAll()).find((item) => item.id === taskId) || null;
  }
}

module.exports = { DEFAULT_FILE, JsonRecloudSyncOutbox, TASK_STATUS, TASK_TRANSITIONS };
