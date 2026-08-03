const crypto = require("crypto");
const path = require("path");
const { createDocumentBackend } = require("./storage-backend");

class WorkCoordinationStore {
  constructor(options = {}) {
    this.now = options.now || (() => Date.now());
    const driver = options.driver || process.env.FIELDDESK_STORAGE_DRIVER || "json";
    this.backend = options.backend || createDocumentBackend({
      driver,
      filePath: options.filePath || (driver === "sqlite"
        ? process.env.FIELDDESK_SQLITE_FILE || path.join(__dirname, "data", "fielddesk.sqlite")
        : path.join(__dirname, "data", "coordination.json")),
      namespace: "coordination",
      initialValue: { locks: {}, idempotency: {}, audits: [] },
    });
  }
  acquire(resourceId, user, ttlMs = 10 * 60 * 1000) {
    if (!resourceId) throw Object.assign(new Error("缺少工单号"), { code: "ORDER_ID_REQUIRED", status: 400 });
    return this.backend.update((data) => {
      const current = data.locks[resourceId];
      if (current && current.expiresAt > this.now() && current.ownerId !== user.userId) throw Object.assign(new Error("工单正在由其他人员处理"), { code: "ORDER_LOCKED", status: 409 });
      const lock = { lockId: current?.ownerId === user.userId ? current.lockId : crypto.randomUUID(), resourceId, ownerId: user.userId, ownerName: user.displayName, acquiredAt: new Date(this.now()).toISOString(), expiresAt: this.now() + ttlMs };
      data.locks[resourceId] = lock;
      return lock;
    });
  }
  release(resourceId, user) {
    if (!resourceId) throw Object.assign(new Error("缺少工单号"), { code: "ORDER_ID_REQUIRED", status: 400 });
    return this.backend.update((data) => {
      const current = data.locks[resourceId];
      if (current && current.ownerId !== user.userId && user.role !== "ADMIN") throw Object.assign(new Error("不能释放其他人员的工单锁"), { code: "ORDER_LOCK_OWNER_REQUIRED", status: 403 });
      delete data.locks[resourceId];
      return { released: Boolean(current) };
    });
  }
  async assertAvailable(resourceId, user) {
    if (!resourceId) return;
    const data = await this.backend.read();
    const lock = data.locks[resourceId];
    if (lock && lock.expiresAt > this.now() && lock.ownerId !== user.userId) throw Object.assign(new Error("工单正在由其他人员处理"), { code: "ORDER_LOCKED", status: 409 });
  }
  executeIdempotent(key, user, work) {
    if (!key) return work();
    return this.backend.update(async (data) => {
      const scopedKey = `${user.userId}:${key}`;
      if (data.idempotency[scopedKey]) return data.idempotency[scopedKey].result;
      const result = await work();
      data.idempotency[scopedKey] = { result, createdAt: new Date(this.now()).toISOString() };
      return result;
    });
  }
  claimIdempotency(key, user) {
    return this.backend.update((data) => {
      const scopedKey = `${user.userId}:${key}`;
      const existing = data.idempotency[scopedKey];
      if (existing?.state === "SUCCESS") return { duplicate: true, response: existing.response };
      if (existing?.state === "PROCESSING") throw Object.assign(new Error("相同请求正在处理中"), { code: "DUPLICATE_SUBMISSION_IN_PROGRESS", status: 409 });
      data.idempotency[scopedKey] = { state: "PROCESSING", createdAt: new Date(this.now()).toISOString() };
      return { duplicate: false, scopedKey };
    });
  }
  finishIdempotency(scopedKey, response) {
    return this.backend.update((data) => {
      if (data.idempotency[scopedKey]) data.idempotency[scopedKey] = { ...data.idempotency[scopedKey], state: "SUCCESS", response, completedAt: new Date(this.now()).toISOString() };
    });
  }
  failIdempotency(scopedKey) {
    return this.backend.update((data) => { delete data.idempotency[scopedKey]; });
  }
  audit(event) {
    return this.backend.update((data) => {
      const record = { id: crypto.randomUUID(), action: event.action, resourceType: event.resourceType || "WORK_ORDER", resourceId: event.resourceId || "", operatorId: event.user?.userId || "", operatorName: event.user?.displayName || "", outcome: event.outcome || "SUCCESS", createdAt: new Date(this.now()).toISOString() };
      data.audits.push(record);
      return record;
    });
  }
  async listAudits() { return (await this.backend.read()).audits; }
}

module.exports = { WorkCoordinationStore };
