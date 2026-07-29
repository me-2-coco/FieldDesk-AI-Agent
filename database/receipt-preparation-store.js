const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const ACTIVE_RECEIPT_STATUSES = new Set(["RECEIPT_PREPARED"]);
const DEFAULT_DATA_FILE = path.join(
  __dirname,
  "data",
  "receipt-preparations.json"
);

function normalizeSn(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizeRequired(value) {
  return String(value || "").trim();
}

function createReceiptPreparation(input, existing = null, now = new Date()) {
  const timestamp = now.toISOString();
  return {
    id: existing?.id || crypto.randomUUID(),
    logisticsNo: normalizeRequired(input.logisticsNo),
    rmaNo: normalizeRequired(input.rmaNo),
    sn: normalizeSn(input.sn),
    specialty: normalizeRequired(input.specialty),
    remark: normalizeRequired(input.remark),
    productLine: normalizeRequired(input.productLine),
    customerName: normalizeRequired(input.customerName),
    reportedFault: normalizeRequired(input.reportedFault),
    phoneMasked: normalizeRequired(input.phoneMasked),
    status: "RECEIPT_PREPARED",
    operatorId: normalizeRequired(input.operatorId),
    operatorName:
      normalizeRequired(input.operatorName) || "本地测试用户",
    operatorTemporary: true,
    createdAt: existing?.createdAt || timestamp,
    updatedAt: timestamp,
  };
}

class JsonReceiptPreparationStore {
  constructor(filePath = DEFAULT_DATA_FILE) {
    this.filePath = filePath;
    this.writeQueue = Promise.resolve();
  }

  async readAll() {
    try {
      const content = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(content);
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  async writeAll(records) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(
      temporaryPath,
      `${JSON.stringify(records, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
    await fs.rename(temporaryPath, this.filePath);
  }

  async prepare(input) {
    const operation = this.writeQueue.then(async () => {
      const records = await this.readAll();
      const normalizedInput = {
        ...input,
        rmaNo: normalizeRequired(input.rmaNo),
        sn: normalizeSn(input.sn),
      };
      const existing = records.find(
        (record) => record.rmaNo === normalizedInput.rmaNo
      );
      const conflict = records.find(
        (record) =>
          record.rmaNo !== normalizedInput.rmaNo &&
          record.sn === normalizedInput.sn &&
          ACTIVE_RECEIPT_STATUSES.has(record.status)
      );
      if (conflict) {
        const error = new Error("该 SN 已绑定其他未完成工单");
        error.code = "SN_ALREADY_BOUND";
        error.status = 409;
        throw error;
      }

      const prepared = createReceiptPreparation(normalizedInput, existing);
      const nextRecords = existing
        ? records.map((record) =>
            record.rmaNo === normalizedInput.rmaNo ? prepared : record
          )
        : [...records, prepared];
      await this.writeAll(nextRecords);
      return prepared;
    });
    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  async cancel(rmaNo, operator = {}) {
    const operation = this.writeQueue.then(async () => {
      const records = await this.readAll();
      const existing = records.find((record) => record.rmaNo === rmaNo);
      if (!existing) {
        const error = new Error("未找到待签收准备记录");
        error.code = "RECEIPT_PREPARATION_NOT_FOUND";
        error.status = 404;
        throw error;
      }
      const updated = {
        ...existing,
        status: "RECEIPT_PREPARATION_CANCELLED",
        operatorId: normalizeRequired(operator.userId),
        operatorName:
          normalizeRequired(operator.displayName) || "本地测试用户",
        operatorTemporary: true,
        updatedAt: new Date().toISOString(),
      };
      await this.writeAll(
        records.map((record) => record.rmaNo === rmaNo ? updated : record)
      );
      return updated;
    });
    this.writeQueue = operation.catch(() => {});
    return operation;
  }
}

module.exports = {
  ACTIVE_RECEIPT_STATUSES,
  DEFAULT_DATA_FILE,
  JsonReceiptPreparationStore,
  createReceiptPreparation,
  normalizeSn,
};
