const fs = require("fs/promises");
const path = require("path");

const DEFAULT_FILE = path.join(__dirname, "data", "recloud-repair-checkpoints.json");
const ALLOWED_STATUS = new Set([
  "MANUAL_REVIEW", "RUNNING", "READY_TO_COMPLETE", "WAITING_SUBMIT_READY", "SUCCESS",
]);
const ALLOWED_STEPS = new Set([
  "PARTS_VERIFIED", "FIELDS_VERIFIED", "ATTACHMENTS_VERIFIED",
  "COMPLETE_CLICKED", "SUBMIT_READY", "SUBMIT_VERIFIED",
]);

function safeCheckpoint(input = {}) {
  const orderKey = String(input.orderKey || "").trim();
  if (!orderKey || orderKey.length > 80) {
    throw Object.assign(new Error("瑞云维修断点缺少有效工单号"), {
      code: "RECLOUD_REPAIR_CHECKPOINT_ORDER_INVALID",
    });
  }
  return {
    orderKey,
    fingerprint: /^[a-f0-9]{64}$/i.test(String(input.fingerprint || "")) ? String(input.fingerprint).toLowerCase() : "",
    status: ALLOWED_STATUS.has(input.status) ? input.status : "RUNNING",
    completedSteps: [...new Set((input.completedSteps || []).filter((step) => ALLOWED_STEPS.has(step)))],
    reviewSteps: [...new Set((input.reviewReasons || []).map((item) => String(item?.step || "")).filter(Boolean))].slice(0, 10),
    updatedAt: new Date().toISOString(),
  };
}

class JsonRecloudRepairCheckpointStore {
  constructor(filePath = DEFAULT_FILE) {
    this.filePath = filePath;
    this.queue = Promise.resolve();
  }

  async readAll() {
    try {
      const value = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch (error) {
      if (error.code === "ENOENT") return {};
      throw error;
    }
  }

  async writeAll(value) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, this.filePath);
  }

  async load(orderKey) {
    const key = String(orderKey || "").trim();
    return (await this.readAll())[key] || null;
  }

  save(input) {
    const checkpoint = safeCheckpoint(input);
    const operation = this.queue.then(async () => {
      const records = await this.readAll();
      records[checkpoint.orderKey] = checkpoint;
      await this.writeAll(records);
      return checkpoint;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}

module.exports = { DEFAULT_FILE, safeCheckpoint, JsonRecloudRepairCheckpointStore };
