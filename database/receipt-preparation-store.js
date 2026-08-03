const path = require("path");
const crypto = require("crypto");
const { JsonDocumentBackend } = require("./storage-backend");

const ACTIVE_RECEIPT_STATUSES = new Set([
  "RECEIPT_PREPARED",
  "RECEIVED_PENDING_INSPECTION",
  "INSPECTION_IN_PROGRESS",
  "INSPECTION_COMPLETED_PENDING_REPAIR",
  "REPAIR_COMPLETION_DRAFT",
]);
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

function timelineEvent(type, label, operator = {}, at = new Date().toISOString()) {
  return {
    id: crypto.randomUUID(), type, label, at,
    operatorId: normalizeRequired(operator.userId),
    operatorName: normalizeRequired(operator.displayName) || "本地测试用户",
  };
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
    regionAddress: normalizeRequired(input.regionAddress),
    reportedFault: normalizeRequired(input.reportedFault),
    phoneMasked: normalizeRequired(input.phoneMasked),
    status: "RECEIPT_PREPARED",
    operatorId: normalizeRequired(input.operatorId),
    operatorName:
      normalizeRequired(input.operatorName) || "本地测试用户",
    operatorTemporary: true,
    technicianId: existing?.technicianId || normalizeRequired(input.operatorId),
    technicianName: existing?.technicianName || normalizeRequired(input.operatorName) || "本地测试用户",
    timeline: existing?.timeline || [
      timelineEvent("CRM_QUERIED", "物流单查询完成", { userId: input.operatorId, displayName: input.operatorName }, timestamp),
      timelineEvent("RECEIPT_PREPARED", "签收资料已准备", { userId: input.operatorId, displayName: input.operatorName }, timestamp),
    ],
    createdAt: existing?.createdAt || timestamp,
    updatedAt: timestamp,
  };
}

class JsonReceiptPreparationStore {
  constructor(filePath = DEFAULT_DATA_FILE) {
    this.filePath = typeof filePath === "string" ? filePath : DEFAULT_DATA_FILE;
    this.backend = typeof filePath === "object"
      ? filePath
      : new JsonDocumentBackend(this.filePath, []);
    this.writeQueue = Promise.resolve();
  }

  async readAll() {
    const parsed = await this.backend.read();
    return Array.isArray(parsed) ? parsed : [];
  }

  async writeAll(records) {
    await this.backend.write(records);
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

  async completeReceipt(rmaNo, operator = {}) {
    const operation = this.writeQueue.then(async () => {
      const records = await this.readAll();
      const existing = records.find((record) => record.rmaNo === rmaNo);
      if (!existing) {
        const error = new Error("未找到本地签收准备记录");
        error.code = "RECEIPT_PREPARATION_NOT_FOUND";
        error.status = 404;
        throw error;
      }
      const timestamp = new Date().toISOString();
      const updated = {
        ...existing,
        status: "RECEIVED_PENDING_INSPECTION",
        receiptCompletedAt: existing.receiptCompletedAt || timestamp,
        operatorId: normalizeRequired(operator.userId),
        operatorName:
          normalizeRequired(operator.displayName) || "本地测试用户",
        operatorTemporary: true,
        updatedAt: timestamp,
        timeline: [
          ...(existing.timeline || []),
          timelineEvent("RECEIPT_COMPLETED", "本地签收完成", operator, timestamp),
        ],
      };
      await this.writeAll(
        records.map((record) => record.rmaNo === rmaNo ? updated : record)
      );
      return updated;
    });
    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  async saveInspection(rmaNo, input = {}, operator = {}) {
    const operation = this.writeQueue.then(async () => {
      const records = await this.readAll();
      const existing = records.find((record) => record.rmaNo === rmaNo);
      if (!existing) {
        const error = new Error("未找到待检测工单");
        error.code = "RECEIPT_PREPARATION_NOT_FOUND";
        error.status = 404;
        throw error;
      }
      if (
        ![
          "RECEIVED_PENDING_INSPECTION",
          "INSPECTION_IN_PROGRESS",
          "INSPECTION_COMPLETED_PENDING_REPAIR",
        ].includes(
          existing.status
        )
      ) {
        const error = new Error("当前工单尚未完成本地签收");
        error.code = "INSPECTION_NOT_ALLOWED";
        error.status = 409;
        throw error;
      }
      const inspectionResult = normalizeRequired(input.inspectionResult);
      if (!inspectionResult) {
        const error = new Error("检测结果不能为空");
        error.code = "INSPECTION_RESULT_REQUIRED";
        error.status = 400;
        throw error;
      }
      const updated = {
        ...existing,
        status: "INSPECTION_COMPLETED_PENDING_REPAIR",
        inspectionResult,
        inspectionRemark: normalizeRequired(input.inspectionRemark),
        inspectionUpdatedAt: new Date().toISOString(),
        operatorId: normalizeRequired(operator.userId),
        operatorName:
          normalizeRequired(operator.displayName) || "本地测试用户",
        operatorTemporary: true,
        updatedAt: new Date().toISOString(),
        timeline: [
          ...(existing.timeline || []),
          timelineEvent("INSPECTION_COMPLETED", "检测登记完成", operator),
        ],
      };
      await this.writeAll(
        records.map((record) => record.rmaNo === rmaNo ? updated : record)
      );
      return updated;
    });
    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  async applyPart(rmaNo, part, quantity, operator = {}) {
    const operation = this.writeQueue.then(async () => {
      const records = await this.readAll();
      const existing = records.find((record) => record.rmaNo === rmaNo);
      if (!existing) {
        const error = new Error("未找到待维修工单");
        error.code = "RECEIPT_PREPARATION_NOT_FOUND";
        error.status = 404;
        throw error;
      }
      if (existing.status !== "INSPECTION_COMPLETED_PENDING_REPAIR") {
        const error = new Error("工单尚未完成检测，不能申请配件");
        error.code = "PART_APPLICATION_NOT_ALLOWED";
        error.status = 409;
        throw error;
      }
      const requestedQuantity = Number(quantity);
      if (!Number.isInteger(requestedQuantity) || requestedQuantity < 1) {
        const error = new Error("申请数量必须是正整数");
        error.code = "PART_QUANTITY_INVALID";
        error.status = 400;
        throw error;
      }
      if (part.stock < 1 || requestedQuantity > part.stock) {
        const error = new Error("库存不足，无法申请");
        error.code = "PART_OUT_OF_STOCK";
        error.status = 409;
        throw error;
      }
      const timestamp = new Date().toISOString();
      const application = {
        id: crypto.randomUUID(),
        partCode: normalizeRequired(part.code),
        partName: normalizeRequired(part.name),
        quantity: requestedQuantity,
        stockSnapshot: part.stock,
        sn: existing.sn,
        status: "PART_APPLICATION_RECORDED",
        operatorId: normalizeRequired(operator.userId),
        operatorName:
          normalizeRequired(operator.displayName) || "本地测试用户",
        createdAt: timestamp,
      };
      const updated = {
        ...existing,
        partApplications: [
          ...(Array.isArray(existing.partApplications)
            ? existing.partApplications
            : []),
          application,
        ],
        updatedAt: timestamp,
        timeline: [
          ...(existing.timeline || []),
          timelineEvent("PART_APPLICATION", "配件申请已记录", operator, timestamp),
        ],
      };
      await this.writeAll(
        records.map((record) => record.rmaNo === rmaNo ? updated : record)
      );
      return { order: updated, application };
    });
    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  async saveRepairCompletion(rmaNo, input = {}, operator = {}, submit = false) {
    const operation = this.writeQueue.then(async () => {
      const records = await this.readAll();
      const existing = records.find((record) => record.rmaNo === rmaNo);
      if (!existing) {
        throw Object.assign(new Error("未找到待维修工单"), {
          code: "RECEIPT_PREPARATION_NOT_FOUND", status: 404,
        });
      }
      if (!["INSPECTION_COMPLETED_PENDING_REPAIR", "REPAIR_COMPLETION_DRAFT"].includes(existing.status)) {
        throw Object.assign(new Error("仅已完成检测的工单可以进入维修完工"), {
          code: "REPAIR_COMPLETION_NOT_ALLOWED", status: 409,
        });
      }
      const faultLevel1 = normalizeRequired(input.faultLevel1);
      const faultLevel2 = normalizeRequired(input.faultLevel2);
      const faultLevel3 = normalizeRequired(input.faultLevel3);
      const responsibilityType = normalizeRequired(input.responsibilityType);
      const repairMeasure = normalizeRequired(input.repairMeasure);
      if (submit) {
        const missingFields = [];
        if (!existing.sn) missingFields.push("sn");
        if (!faultLevel1 || !faultLevel2 || !faultLevel3) missingFields.push("faultClassification");
        if (!responsibilityType) missingFields.push("responsibilityType");
        if (!repairMeasure) missingFields.push("repairMeasure");
        if (missingFields.length) {
          const error = new Error(`缺少必填字段：${missingFields.join(", ")}`);
          error.code = "REPAIR_COMPLETION_INVALID";
          error.status = 400;
          error.missingFields = missingFields;
          throw error;
        }
      }
      const timestamp = new Date().toISOString();
      const updated = {
        ...existing,
        status: submit ? "REPAIR_COMPLETED_PENDING_SHIPMENT" : "REPAIR_COMPLETION_DRAFT",
        repairCompletion: {
          faultLevel1, faultLevel2, faultLevel3,
          responsibilityType,
          speechTemplate: normalizeRequired(input.speechTemplate),
          repairMeasure,
          usedParts: Array.isArray(input.usedParts) ? input.usedParts : [],
          attachments: Array.isArray(input.attachments) ? input.attachments : [],
          savedAt: timestamp,
          submittedAt: submit ? timestamp : null,
          operatorId: normalizeRequired(operator.userId),
          operatorName: normalizeRequired(operator.displayName) || "本地测试用户",
        },
        updatedAt: timestamp,
        timeline: submit
          ? [...(existing.timeline || []), timelineEvent("REPAIR_COMPLETED", "维修完成", operator, timestamp)]
          : existing.timeline || [],
      };
      await this.writeAll(records.map((record) => record.rmaNo === rmaNo ? updated : record));
      return updated;
    });
    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  async addTimelineEvent(rmaNo, type, label, operator = {}) {
    const operation = this.writeQueue.then(async () => {
      const records = await this.readAll();
      const existing = records.find((record) => record.rmaNo === rmaNo);
      if (!existing) throw Object.assign(new Error("未找到本地工单"), { code: "RECEIPT_PREPARATION_NOT_FOUND", status: 404 });
      const updated = {
        ...existing,
        timeline: [...(existing.timeline || []), timelineEvent(type, label, operator)],
        updatedAt: new Date().toISOString(),
      };
      await this.writeAll(records.map((record) => record.rmaNo === rmaNo ? updated : record));
      return updated;
    });
    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  async listShippingOrders(user = {}, roles = {}) {
    const records = await this.readAll();
    const allowedStatuses = new Set(["REPAIR_COMPLETED_PENDING_SHIPMENT", "SHIPPED_PENDING_COMPLETION"]);
    return records.filter((record) => {
      if (!allowedStatuses.has(record.status)) return false;
      if ([roles.ADMIN, roles.WAREHOUSE].includes(user.role)) return true;
      return (record.technicianId || record.operatorId) === user.userId;
    });
  }

  async listOrdersForUser(user = {}, roles = {}) {
    const records = await this.readAll();
    if (user.role === roles.ADMIN) return records;
    if (user.role === roles.TECHNICIAN) {
      return records.filter((record) =>
        (record.technicianId || record.operatorId) === user.userId
      );
    }
    return [];
  }

  async submitReturnShipment(rmaNo, input = {}, operator = {}) {
    const operation = this.writeQueue.then(async () => {
      const records = await this.readAll();
      const existing = records.find((record) => record.rmaNo === rmaNo);
      if (!existing) throw Object.assign(new Error("未找到待发货工单"), { code: "RECEIPT_PREPARATION_NOT_FOUND", status: 404 });
      if (existing.status === "SHIPPED_PENDING_COMPLETION" || existing.status === "COMPLETED") {
        throw Object.assign(new Error("该工单已经发货，不能重复提交"), { code: "RETURN_SHIPMENT_DUPLICATE", status: 409 });
      }
      if (existing.status !== "REPAIR_COMPLETED_PENDING_SHIPMENT") {
        throw Object.assign(new Error("仅维修完成待发货工单可以返件发货"), { code: "RETURN_SHIPMENT_NOT_ALLOWED", status: 409 });
      }
      const logisticsCompany = normalizeRequired(input.logisticsCompany);
      const trackingNo = normalizeRequired(input.trackingNo).toUpperCase();
      if (!logisticsCompany || !trackingNo) {
        const missingFields = [!logisticsCompany && "logisticsCompany", !trackingNo && "trackingNo"].filter(Boolean);
        const error = new Error(`缺少必填字段：${missingFields.join(", ")}`);
        error.code = "RETURN_SHIPMENT_INVALID"; error.status = 400; error.missingFields = missingFields;
        throw error;
      }
      const timestamp = new Date().toISOString();
      const updated = {
        ...existing,
        status: "SHIPPED_PENDING_COMPLETION",
        returnShipment: {
          logisticsCompany, trackingNo, shippedAt: timestamp,
          operatorId: normalizeRequired(operator.userId),
          operatorName: normalizeRequired(operator.displayName) || "本地测试用户",
          attachments: Array.isArray(input.attachments) ? input.attachments : [],
          recloudSynced: false,
        },
        timeline: [...(existing.timeline || []), timelineEvent("RETURN_SHIPPED", "返件已发货", operator, timestamp)],
        updatedAt: timestamp,
      };
      await this.writeAll(records.map((record) => record.rmaNo === rmaNo ? updated : record));
      return updated;
    });
    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  async confirmCompletion(rmaNo, operator = {}) {
    const operation = this.writeQueue.then(async () => {
      const records = await this.readAll();
      const existing = records.find((record) => record.rmaNo === rmaNo);
      if (!existing) throw Object.assign(new Error("未找到待完结工单"), { code: "RECEIPT_PREPARATION_NOT_FOUND", status: 404 });
      if (existing.status === "COMPLETED") throw Object.assign(new Error("工单已经完结，不能重复操作"), { code: "ORDER_COMPLETION_DUPLICATE", status: 409 });
      if (existing.status !== "SHIPPED_PENDING_COMPLETION") throw Object.assign(new Error("工单尚未发货，不能完结"), { code: "ORDER_COMPLETION_NOT_ALLOWED", status: 409 });
      const timestamp = new Date().toISOString();
      const updated = {
        ...existing, status: "COMPLETED", completedAt: timestamp,
        completedBy: { operatorId: normalizeRequired(operator.userId), operatorName: normalizeRequired(operator.displayName) || "本地测试用户" },
        timeline: [...(existing.timeline || []), timelineEvent("ORDER_COMPLETED", "管理员确认完结", operator, timestamp)],
        updatedAt: timestamp,
      };
      await this.writeAll(records.map((record) => record.rmaNo === rmaNo ? updated : record));
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
