const path = require("path");
const crypto = require("crypto");
const { JsonDocumentBackend } = require("./storage-backend");

const ACTIVE_RECEIPT_STATUSES = new Set([
  "RECEIPT_PREPARED",
  "TRANSFER_TO_HEADQUARTERS_PENDING",
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

function validateReceiptCompletion(existing) {
  if (!existing) {
    const error = new Error("未找到本地签收准备记录");
    error.code = "RECEIPT_PREPARATION_NOT_FOUND";
    error.status = 404;
    throw error;
  }
  if (
    existing.modelAuthorization?.repairability !== "SUPPORTED"
    && existing.modelAuthorization?.localWorkflowAllowed !== true
  ) {
    const error = new Error("该机器尚未通过下放机型校验，不能进入检测");
    error.code = "MODEL_AUTHORIZATION_REQUIRED";
    error.status = 409;
    throw error;
  }
  if (existing.recloudReceiptRequired !== false && !(existing.receiptAttachments || []).length) {
    const error = new Error("请先拍摄并上传至少一张签收照片");
    error.code = "RECEIPT_ATTACHMENT_REQUIRED";
    error.status = 409;
    throw error;
  }
  return existing;
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
    recloudProjectCode: normalizeRequired(input.recloudProjectCode),
    recloudOrderStatus: normalizeRequired(input.recloudOrderStatus),
    recloudReceiptStatus: normalizeRequired(input.recloudReceiptStatus),
    recloudReceiptSignedAt: normalizeRequired(input.recloudReceiptSignedAt),
    recloudReceiptRequired: typeof input.recloudReceiptRequired === "boolean"
      ? input.recloudReceiptRequired
      : existing?.recloudReceiptRequired ?? null,
    customerName: normalizeRequired(input.customerName),
    regionAddress: normalizeRequired(input.regionAddress),
    reportedFault: normalizeRequired(input.reportedFault),
    manufacturerWarrantyConversion: existing?.manufacturerWarrantyConversion || {
      requested: false,
      approved: false,
      approvalNo: "",
      status: "NOT_REQUIRED",
      proofAttachments: [],
    },
    phoneMasked: normalizeRequired(input.phoneMasked),
    status: "RECEIPT_PREPARED",
    operatorId: normalizeRequired(input.operatorId),
    operatorName:
      normalizeRequired(input.operatorName) || "本地测试用户",
    operatorTemporary: true,
    technicianId: existing?.technicianId || normalizeRequired(input.operatorId),
    technicianName: existing?.technicianName || normalizeRequired(input.operatorName) || "本地测试用户",
    receiptAttachments: existing?.receiptAttachments || [],
    recloudReceiptSyncStatus: existing?.recloudReceiptSyncStatus || "NOT_STARTED",
    recloudReceiptAttemptId: existing?.recloudReceiptAttemptId || "",
    recloudReceiptAttemptedAt: existing?.recloudReceiptAttemptedAt || "",
    recloudReceiptConfirmedAt: existing?.recloudReceiptConfirmedAt || "",
    recloudReceiptResult: existing?.recloudReceiptResult || null,
    recloudReceiptLastError: existing?.recloudReceiptLastError || null,
    recloudReceiptAttachmentSyncStatus:
      existing?.recloudReceiptAttachmentSyncStatus || "NOT_STARTED",
    recloudReceiptAttachmentAttemptedAt:
      existing?.recloudReceiptAttachmentAttemptedAt || "",
    recloudReceiptAttachmentConfirmedAt:
      existing?.recloudReceiptAttachmentConfirmedAt || "",
    recloudReceiptAttachmentResult:
      existing?.recloudReceiptAttachmentResult || null,
    recloudReceiptAttachmentLastError:
      existing?.recloudReceiptAttachmentLastError || null,
    recloudDetectionSyncStatus: existing?.recloudDetectionSyncStatus || "NOT_STARTED",
    recloudDetectionAttemptedAt: existing?.recloudDetectionAttemptedAt || "",
    recloudDetectionConfirmedAt: existing?.recloudDetectionConfirmedAt || "",
    recloudDetectionLastError: existing?.recloudDetectionLastError || null,
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
      if (existing?.recloudReceiptConfirmedAt) return existing;
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

  async markModelAuthorization(rmaNo, authorization = {}, operator = {}) {
    const operation = this.writeQueue.then(async () => {
      const records = await this.readAll();
      const existing = records.find((record) => record.rmaNo === rmaNo);
      if (!existing) {
        const error = new Error("未找到签收准备记录");
        error.code = "RECEIPT_PREPARATION_NOT_FOUND";
        error.status = 404;
        throw error;
      }
      const supported = authorization.repairability === "SUPPORTED";
      const unsupported = authorization.repairability === "UNSUPPORTED";
      const timestamp = new Date().toISOString();
      const updated = {
        ...existing,
        status: supported ? "RECEIPT_PREPARED" : unsupported ? "TRANSFER_TO_HEADQUARTERS_PENDING" : "MODEL_AUTHORIZATION_REVIEW",
        modelAuthorization: { ...authorization, checkedAt: timestamp },
        updatedAt: timestamp,
        timeline: [
          ...(existing.timeline || []),
          timelineEvent(
            supported ? "MODEL_SUPPORTED" : unsupported ? "TRANSFER_REQUIRED" : "MODEL_REVIEW_REQUIRED",
            supported ? "下放机型，可以维修" : unsupported ? "未下放机型，需转寄总部" : "机型数据异常，需人工确认",
            operator,
            timestamp
          ),
        ],
      };
      await this.writeAll(records.map((record) => record.rmaNo === rmaNo ? updated : record));
      return updated;
    });
    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  async transferToHeadquarters(rmaNo, operator = {}) {
    const operation = this.writeQueue.then(async () => {
      const records = await this.readAll();
      const existing = records.find((record) => record.rmaNo === rmaNo);
      if (!existing) {
        const error = new Error("未找到待转寄工单");
        error.code = "RECEIPT_PREPARATION_NOT_FOUND";
        error.status = 404;
        throw error;
      }
      const signedWorkflowStatuses = new Set([
        "RECEIVED_PENDING_INSPECTION", "INSPECTION_IN_PROGRESS",
        "INSPECTION_COMPLETED_PENDING_REPAIR", "REPAIR_COMPLETION_DRAFT",
      ]);
      if (existing.modelAuthorization?.repairability !== "UNSUPPORTED" && !signedWorkflowStatuses.has(existing.status)) {
        const error = new Error("当前工单不能转寄总部");
        error.code = "TRANSFER_NOT_ALLOWED";
        error.status = 409;
        throw error;
      }
      const timestamp = new Date().toISOString();
      const updated = {
        ...existing,
        status: "TRANSFERRED_TO_HEADQUARTERS",
        treatmentMode: "TRANSFER_TO_HEADQUARTERS",
        treatmentLabel: "转寄总部",
        skipsParts: true,
        transferredToHeadquartersAt: timestamp,
        updatedAt: timestamp,
        timeline: [...(existing.timeline || []), timelineEvent("TRANSFERRED_TO_HEADQUARTERS", "已登记转寄总部，流程结束", operator, timestamp)],
      };
      await this.writeAll(records.map((record) => record.rmaNo === rmaNo ? updated : record));
      return updated;
    });
    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  async completeReceipt(rmaNo, operator = {}) {
    const operation = this.writeQueue.then(async () => {
      const records = await this.readAll();
      const existing = records.find((record) => record.rmaNo === rmaNo);
      validateReceiptCompletion(existing);
      if (existing.receiptCompletedAt) return existing;
      const timestamp = new Date().toISOString();
      const updated = {
        ...existing,
        status: "RECEIVED_PENDING_INSPECTION",
        resumeStep: "repairWarranty",
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

  async markRecloudReceiptConfirmed(rmaNo, input = {}) {
    const operation = this.writeQueue.then(async () => {
      const records = await this.readAll();
      const existing = records.find((record) => record.rmaNo === rmaNo);
      if (!existing) {
        const error = new Error("未找到本地签收准备记录");
        error.code = "RECEIPT_PREPARATION_NOT_FOUND";
        error.status = 404;
        throw error;
      }
      if (existing.recloudReceiptConfirmedAt) return existing;
      const timestamp = new Date().toISOString();
      const operator = input.operator || {};
      const updated = {
        ...existing,
        recloudReceiptSyncStatus: "CONFIRMED",
        recloudReceiptConfirmedAt: timestamp,
        recloudReceiptResult: {
          confirmed: true,
          skipped: input.skipped === true,
          message: normalizeRequired(input.receipt?.message) || (input.skipped ? "瑞云已签收，跳过重复签收" : "签收完成"),
        },
        updatedAt: timestamp,
        timeline: [
          ...(existing.timeline || []),
          timelineEvent(
            input.skipped ? "RECLOUD_RECEIPT_ALREADY_COMPLETED" : "RECLOUD_RECEIPT_CONFIRMED",
            input.skipped ? "瑞云已签收，FieldDesk 已跳过重复签收" : "瑞云签收完成",
            operator,
            timestamp
          ),
        ],
      };
      await this.writeAll(records.map((record) => record.rmaNo === rmaNo ? updated : record));
      return updated;
    });
    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  async resetFalseSkippedRecloudReceipt(rmaNo, operator = {}) {
    const operation = this.writeQueue.then(async () => {
      const records = await this.readAll();
      const existing = records.find((record) => record.rmaNo === rmaNo);
      if (!existing) {
        throw Object.assign(new Error("未找到本地签收准备记录"), {
          code: "RECEIPT_PREPARATION_NOT_FOUND", status: 404,
        });
      }
      const wasSkipped = existing.recloudReceiptResult?.skipped === true
        && (existing.timeline || []).some((event) => event.type === "RECLOUD_RECEIPT_ALREADY_COMPLETED");
      if (!wasSkipped) {
        throw Object.assign(new Error("该工单不是误跳过的瑞云签收记录，禁止重置"), {
          code: "RECLOUD_RECEIPT_FALSE_SKIP_REQUIRED", status: 409,
        });
      }
      const timestamp = new Date().toISOString();
      const updated = {
        ...existing,
        recloudReceiptSyncStatus: "PENDING",
        recloudReceiptAttemptId: "",
        recloudReceiptAttemptedAt: "",
        recloudReceiptConfirmedAt: "",
        recloudReceiptResult: null,
        recloudReceiptLastError: null,
        recloudReceiptAttachmentSyncStatus: (existing.receiptAttachments || []).length ? "PENDING" : "NOT_STARTED",
        recloudReceiptAttachmentAttemptedAt: "",
        recloudReceiptAttachmentConfirmedAt: "",
        recloudReceiptAttachmentResult: null,
        recloudReceiptAttachmentLastError: null,
        updatedAt: timestamp,
        timeline: [
          ...(existing.timeline || []),
          timelineEvent(
            "RECLOUD_RECEIPT_FALSE_SKIP_RESET",
            "已撤销错误的瑞云签收跳过结果，等待安全重试",
            operator,
            timestamp
          ),
        ],
      };
      await this.writeAll(records.map((record) => record.rmaNo === rmaNo ? updated : record));
      return updated;
    });
    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  async markRecloudReceiptSyncing(rmaNo, input = {}) {
    const operation = this.writeQueue.then(async () => {
      const records = await this.readAll();
      const existing = records.find((record) => record.rmaNo === rmaNo);
      if (!existing) {
        throw Object.assign(new Error("未找到本地签收准备记录"), {
          code: "RECEIPT_PREPARATION_NOT_FOUND", status: 404,
        });
      }
      if (existing.recloudReceiptConfirmedAt) return existing;
      if (existing.recloudReceiptSyncStatus === "RESULT_UNKNOWN") {
        throw Object.assign(new Error("瑞云签收结果待人工核对，禁止重复提交"), {
          code: "RECLOUD_RECEIPT_RECONCILIATION_REQUIRED", status: 409,
        });
      }
      const timestamp = new Date().toISOString();
      const updated = {
        ...existing,
        recloudReceiptSyncStatus: "SYNCING",
        recloudReceiptAttemptId: normalizeRequired(input.attemptId) || crypto.randomUUID(),
        recloudReceiptAttemptedAt: timestamp,
        recloudReceiptLastError: null,
        updatedAt: timestamp,
      };
      await this.writeAll(records.map((record) => record.rmaNo === rmaNo ? updated : record));
      return updated;
    });
    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  async markRecloudReceiptFailed(rmaNo, input = {}) {
    const operation = this.writeQueue.then(async () => {
      const records = await this.readAll();
      const existing = records.find((record) => record.rmaNo === rmaNo);
      if (!existing || existing.recloudReceiptConfirmedAt) return existing;
      const timestamp = new Date().toISOString();
      const resultUnknown = input.resultUnknown === true;
      const updated = {
        ...existing,
        recloudReceiptSyncStatus: resultUnknown ? "RESULT_UNKNOWN" : "FAILED",
        recloudReceiptLastError: {
          code: normalizeRequired(input.code) || "RECLOUD_RECEIPT_FAILED",
          message: resultUnknown
            ? "瑞云签收请求结果未知，需要管理员人工核对"
            : "瑞云签收失败，可以安全重试",
          at: timestamp,
        },
        updatedAt: timestamp,
        timeline: resultUnknown
          ? [
              ...(existing.timeline || []),
              timelineEvent(
                "RECLOUD_RECEIPT_RESULT_UNKNOWN",
                "瑞云签收结果待人工核对",
                input.operator || {},
                timestamp
              ),
            ]
          : existing.timeline || [],
      };
      await this.writeAll(records.map((record) => record.rmaNo === rmaNo ? updated : record));
      return updated;
    });
    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  async markRecloudReceiptAttachmentsSyncing(rmaNo) {
    const operation = this.writeQueue.then(async () => {
      const records = await this.readAll();
      const existing = records.find((record) => record.rmaNo === rmaNo);
      if (!existing) {
        throw Object.assign(new Error("未找到本地签收准备记录"), {
          code: "RECEIPT_PREPARATION_NOT_FOUND", status: 404,
        });
      }
      if (existing.recloudReceiptAttachmentConfirmedAt) return existing;
      const timestamp = new Date().toISOString();
      const updated = {
        ...existing,
        recloudReceiptAttachmentSyncStatus: "SYNCING",
        recloudReceiptAttachmentAttemptedAt: timestamp,
        recloudReceiptAttachmentLastError: null,
        updatedAt: timestamp,
      };
      await this.writeAll(records.map((record) => record.rmaNo === rmaNo ? updated : record));
      return updated;
    });
    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  async markRecloudReceiptAttachmentsConfirmed(rmaNo, input = {}) {
    const operation = this.writeQueue.then(async () => {
      const records = await this.readAll();
      const existing = records.find((record) => record.rmaNo === rmaNo);
      if (!existing) {
        throw Object.assign(new Error("未找到本地签收准备记录"), {
          code: "RECEIPT_PREPARATION_NOT_FOUND", status: 404,
        });
      }
      if (existing.recloudReceiptAttachmentConfirmedAt) return existing;
      const timestamp = new Date().toISOString();
      const uploaded = Array.isArray(input.result?.uploaded)
        ? input.result.uploaded.map(normalizeRequired).filter(Boolean)
        : [];
      const updated = {
        ...existing,
        recloudReceiptAttachmentSyncStatus: "CONFIRMED",
        recloudReceiptAttachmentConfirmedAt: timestamp,
        recloudReceiptAttachmentResult: { uploaded },
        recloudReceiptAttachmentLastError: null,
        updatedAt: timestamp,
        timeline: [
          ...(existing.timeline || []),
          timelineEvent(
            "RECLOUD_RECEIPT_ATTACHMENTS_CONFIRMED",
            `瑞云签收照片同步完成（${uploaded.length} 张）`,
            input.operator || {},
            timestamp
          ),
        ],
      };
      await this.writeAll(records.map((record) => record.rmaNo === rmaNo ? updated : record));
      return updated;
    });
    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  async markRecloudReceiptAttachmentsFailed(rmaNo, input = {}) {
    const operation = this.writeQueue.then(async () => {
      const records = await this.readAll();
      const existing = records.find((record) => record.rmaNo === rmaNo);
      if (!existing || existing.recloudReceiptAttachmentConfirmedAt) return existing;
      const timestamp = new Date().toISOString();
      const resultUnknown = input.resultUnknown === true;
      const updated = {
        ...existing,
        recloudReceiptAttachmentSyncStatus: resultUnknown ? "RESULT_UNKNOWN" : "FAILED",
        recloudReceiptAttachmentLastError: {
          code: normalizeRequired(input.code) || "RECLOUD_RECEIPT_ATTACHMENT_UPLOAD_FAILED",
          message: resultUnknown
            ? "瑞云照片上传结果未知，需要管理员核对后再重试"
            : "瑞云签收照片同步失败，可以单独重试照片",
          at: timestamp,
        },
        updatedAt: timestamp,
      };
      await this.writeAll(records.map((record) => record.rmaNo === rmaNo ? updated : record));
      return updated;
    });
    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  async addReceiptAttachment(rmaNo, attachment, operator = {}) {
    const operation = this.writeQueue.then(async () => {
      const records = await this.readAll();
      const existing = records.find((record) => record.rmaNo === rmaNo);
      if (!existing) {
        throw Object.assign(new Error("未找到本地签收准备记录"), {
          code: "RECEIPT_PREPARATION_NOT_FOUND", status: 404,
        });
      }
      const canAttachDuringLocalSimulation = existing.status === "MODEL_AUTHORIZATION_REVIEW"
        && existing.modelAuthorization?.localWorkflowAllowed === true;
      if (existing.status !== "RECEIPT_PREPARED" && !canAttachDuringLocalSimulation) {
        throw Object.assign(new Error("当前工单状态不能补充签收照片"), {
          code: "RECEIPT_ATTACHMENT_NOT_ALLOWED", status: 409,
        });
      }
      const timestamp = new Date().toISOString();
      const updated = {
        ...existing,
        receiptAttachments: [...(existing.receiptAttachments || []), attachment],
        recloudReceiptAttachmentSyncStatus: "PENDING",
        recloudReceiptAttachmentConfirmedAt: "",
        recloudReceiptAttachmentResult: null,
        recloudReceiptAttachmentLastError: null,
        updatedAt: timestamp,
        timeline: [...(existing.timeline || []), timelineEvent("RECEIPT_ATTACHMENT_UPLOADED", "已上传签收照片", operator, timestamp)],
      };
      await this.writeAll(records.map((record) => record.rmaNo === rmaNo ? updated : record));
      return updated;
    });
    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  async recordManufacturerWarrantyConversion(rmaNo, input = {}, operator = {}) {
    const operation = this.writeQueue.then(async () => {
      const records = await this.readAll();
      const existing = records.find((record) => record.rmaNo === rmaNo);
      if (!existing) {
        throw Object.assign(new Error("未找到本地工单"), {
          code: "RECEIPT_PREPARATION_NOT_FOUND", status: 404,
        });
      }
      const approved = input.approved === true;
      const approvalNo = normalizeRequired(input.approvalNo);
      if (approved && !approvalNo) {
        throw Object.assign(new Error("厂家保外转保内必须有特殊申请单号"), {
          code: "WARRANTY_CONVERSION_APPROVAL_REQUIRED", status: 400,
        });
      }
      const timestamp = new Date().toISOString();
      const updated = {
        ...existing,
        manufacturerWarrantyConversion: { approved, approvalNo: approved ? approvalNo : "" },
        updatedAt: timestamp,
        timeline: [...(existing.timeline || []), timelineEvent(
          "MANUFACTURER_WARRANTY_CONVERSION_RECORDED",
          approved ? "已记录厂家保外转保内特殊申请" : "已确认非保外转保内",
          operator,
          timestamp
        )],
      };
      await this.writeAll(records.map((record) => record.rmaNo === rmaNo ? updated : record));
      return updated;
    });
    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  async saveTreatmentDecision(rmaNo, input = {}, operator = {}) {
    const operation = this.writeQueue.then(async () => {
      const records = await this.readAll();
      const existing = records.find((record) => record.rmaNo === rmaNo);
      if (!existing) throw Object.assign(new Error("未找到已签收工单"), { code: "RECEIPT_PREPARATION_NOT_FOUND", status: 404 });
      if (!["RECEIVED_PENDING_INSPECTION", "INSPECTION_IN_PROGRESS", "INSPECTION_COMPLETED_PENDING_REPAIR", "REPAIR_COMPLETION_DRAFT"].includes(existing.status)) {
        throw Object.assign(new Error("当前工单不能选择维修处理方式"), { code: "TREATMENT_DECISION_NOT_ALLOWED", status: 409 });
      }
      const treatmentMode = normalizeRequired(input.treatmentMode);
      const labels = {
        REPAIR: "维修",
        ABANDONED: "弃修",
        INSPECTION_ONLY: "只检测不维修",
        DEBUGGING: "调试",
      };
      if (!labels[treatmentMode]) throw Object.assign(new Error("请选择有效的维修处理方式"), { code: "TREATMENT_MODE_INVALID", status: 400 });
      const technicianWarranty = normalizeRequired(input.technicianWarranty) || existing.technicianWarranty || "";
      if (!technicianWarranty) {
        throw Object.assign(new Error("请先确认保修状态，再选择处理方式"), { code: "WARRANTY_STATUS_REQUIRED", status: 409 });
      }
      if (treatmentMode === "ABANDONED" && technicianWarranty !== "保外") {
        throw Object.assign(new Error("弃修仅适用于保外机器；保内机器无需付费，不能选择弃修"), { code: "IN_WARRANTY_ABANDONMENT_NOT_ALLOWED", status: 409 });
      }
      const skipsParts = treatmentMode !== "REPAIR";
      const hasSavedInspection = existing.status === "INSPECTION_COMPLETED_PENDING_REPAIR"
        || Boolean(existing.inspectionUpdatedAt && existing.faultCategory && existing.technicianWarranty);
      const timestamp = new Date().toISOString();
      const updated = {
        ...existing,
        treatmentMode,
        treatmentLabel: labels[treatmentMode],
        skipsParts,
        status: hasSavedInspection ? "INSPECTION_COMPLETED_PENDING_REPAIR" : "RECEIVED_PENDING_INSPECTION",
        resumeStep: skipsParts ? "repairProcess" : "partsApplication",
        inspectionResult: normalizeRequired(input.detectionResult),
        detectionResult: normalizeRequired(input.detectionResult),
        technicianWarranty,
        warrantyDecision: input.warrantyDecision || existing.warrantyDecision || null,
        treatmentDecidedAt: timestamp,
        inspectionUpdatedAt: existing.inspectionUpdatedAt,
        updatedAt: timestamp,
        timeline: [
          ...(existing.timeline || []),
          timelineEvent("TREATMENT_DECIDED", `维修处理方式：${labels[treatmentMode]}`, operator, timestamp),
        ],
      };
      await this.writeAll(records.map((record) => record.rmaNo === rmaNo ? updated : record));
      return updated;
    });
    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  async saveWarrantyDecision(rmaNo, input = {}, operator = {}) {
    const operation = this.writeQueue.then(async () => {
      const records = await this.readAll();
      const existing = records.find((record) => record.rmaNo === rmaNo);
      if (!existing) throw Object.assign(new Error("未找到已签收工单"), { code: "RECEIPT_PREPARATION_NOT_FOUND", status: 404 });
      if (!["RECEIVED_PENDING_INSPECTION", "INSPECTION_IN_PROGRESS"].includes(existing.status)) {
        throw Object.assign(new Error("当前工单不能确认保修状态"), { code: "WARRANTY_DECISION_NOT_ALLOWED", status: 409 });
      }
      const technicianWarranty = normalizeRequired(input.technicianWarranty);
      if (!["保内", "保外"].includes(technicianWarranty)) {
        throw Object.assign(new Error("保修状态尚未明确"), { code: "WARRANTY_STATUS_REQUIRED", status: 409 });
      }
      const systemWarranty = normalizeRequired(input.warrantyDecision?.warrantyStatus || existing.warrantyDecision?.warrantyStatus);
      const conversionRequested = input.conversionRequested === true;
      if (conversionRequested && technicianWarranty !== "保外") {
        throw Object.assign(new Error("只有当前状态为保外时才能选择保外转保内"), { code: "WARRANTY_CONVERSION_NOT_APPLICABLE", status: 400 });
      }
      const timestamp = new Date().toISOString();
      const previousConversion = existing.manufacturerWarrantyConversion || {};
      const manufacturerWarrantyConversion = conversionRequested ? {
        requested: true,
        approved: previousConversion.approved === true && (previousConversion.proofAttachments || []).length > 0,
        approvalNo: previousConversion.approvalNo || "",
        status: previousConversion.approved === true && (previousConversion.proofAttachments || []).length > 0 ? "APPROVED" : "PENDING_APPROVAL",
        requestedAt: previousConversion.requestedAt || timestamp,
        requestedBy: previousConversion.requestedBy || normalizeRequired(operator.userId),
        requestedByName: previousConversion.requestedByName || normalizeRequired(operator.displayName) || "本地测试用户",
        proofAttachments: previousConversion.proofAttachments || [],
      } : {
        requested: false, approved: false, approvalNo: "", status: "NOT_REQUIRED", proofAttachments: [],
        decidedAt: timestamp,
      };
      const updated = {
        ...existing,
        technicianWarranty,
        warrantyDecision: input.warrantyDecision || existing.warrantyDecision || null,
        warrantyOverridden: Boolean(systemWarranty && systemWarranty !== technicianWarranty),
        manufacturerWarrantyConversion,
        warrantyConfirmedAt: timestamp,
        resumeStep: "repairDecision",
        updatedAt: timestamp,
        timeline: [...(existing.timeline || []), timelineEvent("WARRANTY_CONFIRMED", `保修状态：${technicianWarranty}；保外转保内：${conversionRequested ? "是，待信息员上传凭证" : "否"}`, operator, timestamp)],
      };
      await this.writeAll(records.map((record) => record.rmaNo === rmaNo ? updated : record));
      return updated;
    });
    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  async addWarrantyConversionProof(rmaNo, attachment, input = {}, operator = {}) {
    const operation = this.writeQueue.then(async () => {
      const records = await this.readAll();
      const existing = records.find((record) => record.rmaNo === rmaNo);
      if (!existing) throw Object.assign(new Error("未找到本地工单"), { code: "RECEIPT_PREPARATION_NOT_FOUND", status: 404 });
      if (existing.manufacturerWarrantyConversion?.requested !== true) {
        throw Object.assign(new Error("该工单未申请保外转保内"), { code: "WARRANTY_CONVERSION_NOT_REQUESTED", status: 409 });
      }
      const timestamp = new Date().toISOString();
      const proof = { ...attachment, locked: true, source: "WARRANTY_CONVERSION_APPROVAL", uploadedByRole: "INFORMATION_CLERK" };
      const proofAttachments = [...(existing.manufacturerWarrantyConversion.proofAttachments || []), proof];
      const updated = {
        ...existing,
        manufacturerWarrantyConversion: {
          ...existing.manufacturerWarrantyConversion,
          approved: true,
          approvalNo: normalizeRequired(input.approvalNo) || existing.manufacturerWarrantyConversion.approvalNo || "凭证已上传",
          status: "APPROVED",
          approvedAt: timestamp,
          approvedBy: normalizeRequired(operator.userId),
          approvedByName: normalizeRequired(operator.displayName) || "信息员",
          proofAttachments,
        },
        updatedAt: timestamp,
        timeline: [...(existing.timeline || []), timelineEvent("WARRANTY_CONVERSION_PROOF_UPLOADED", "信息员已上传保外转保内申请凭证", operator, timestamp)],
      };
      await this.writeAll(records.map((record) => record.rmaNo === rmaNo ? updated : record));
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
          // Recovery for orders that an older FieldDesk build advanced before
          // the asynchronous Recloud detection was actually confirmed.
          ...(existing.recloudServiceOrderCreatedAt ? [] : ["REPAIR_COMPLETION_DRAFT"]),
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
      const updated = {
        ...existing,
        status: "INSPECTION_COMPLETED_PENDING_REPAIR",
        resumeStep: "repairProcess",
        inspectionResult,
        inspectionRemark: normalizeRequired(input.inspectionRemark),
        faultCategory: normalizeRequired(input.faultCategory),
        technicianWarranty: normalizeRequired(input.technicianWarranty),
        warrantyDecision: input.warrantyDecision || null,
        customerReasonConsistent: "是",
        detectionResult: normalizeRequired(input.detectionResult) || inspectionResult,
        inspectionAbnormal: "否",
        productFunctionDecision: normalizeRequired(input.productFunctionDecision) || "功能问题",
        originalConsumables: "是",
        consumableName: "",
        dismantled: "是",
        inspectionUpdatedAt: new Date().toISOString(),
        recloudDetectionConfirmedAt: input.recloudDetectionConfirmedAt || existing.recloudDetectionConfirmedAt || "",
        recloudDetectionSyncStatus: input.recloudDetectionConfirmedAt
          ? "CONFIRMED"
          : normalizeRequired(input.recloudDetectionSyncStatus)
            || existing.recloudDetectionSyncStatus
            || "NOT_STARTED",
        recloudDetectionLastError: null,
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

  async markRecloudDetectionSyncing(rmaNo) {
    const operation = this.writeQueue.then(async () => {
      const records = await this.readAll();
      const existing = records.find((record) => record.rmaNo === rmaNo);
      if (!existing) throw Object.assign(new Error("未找到待检测工单"), { code: "RECEIPT_PREPARATION_NOT_FOUND", status: 404 });
      if (existing.recloudDetectionConfirmedAt) return existing;
      if (existing.recloudDetectionSyncStatus === "RESULT_UNKNOWN") {
        throw Object.assign(new Error("瑞云检测结果待人工核对，禁止重复提交"), { code: "RECLOUD_DETECTION_RECONCILIATION_REQUIRED", status: 409 });
      }
      const timestamp = new Date().toISOString();
      const updated = {
        ...existing,
        recloudDetectionSyncStatus: "SYNCING",
        recloudDetectionAttemptedAt: timestamp,
        recloudDetectionLastError: null,
        updatedAt: timestamp,
      };
      await this.writeAll(records.map((record) => record.rmaNo === rmaNo ? updated : record));
      return updated;
    });
    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  async markRecloudDetectionConfirmed(rmaNo, input = {}) {
    const operation = this.writeQueue.then(async () => {
      const records = await this.readAll();
      const existing = records.find((record) => record.rmaNo === rmaNo);
      if (!existing) throw Object.assign(new Error("未找到待检测工单"), { code: "RECEIPT_PREPARATION_NOT_FOUND", status: 404 });
      if (existing.recloudDetectionConfirmedAt) return existing;
      const timestamp = new Date().toISOString();
      const updated = {
        ...existing,
        recloudDetectionSyncStatus: "CONFIRMED",
        recloudDetectionConfirmedAt: timestamp,
        recloudDetectionLastError: null,
        updatedAt: timestamp,
        timeline: [
          ...(existing.timeline || []),
          timelineEvent("RECLOUD_DETECTION_CONFIRMED", "瑞云寄修单检测完成", input.operator || {}, timestamp),
        ],
      };
      await this.writeAll(records.map((record) => record.rmaNo === rmaNo ? updated : record));
      return updated;
    });
    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  async markRecloudDetectionFailed(rmaNo, input = {}) {
    const operation = this.writeQueue.then(async () => {
      const records = await this.readAll();
      const existing = records.find((record) => record.rmaNo === rmaNo);
      if (!existing || existing.recloudDetectionConfirmedAt) return existing;
      const timestamp = new Date().toISOString();
      const resultUnknown = input.resultUnknown === true;
      const updated = {
        ...existing,
        recloudDetectionSyncStatus: resultUnknown ? "RESULT_UNKNOWN" : "FAILED",
        recloudDetectionLastError: {
          code: normalizeRequired(input.code) || "RECLOUD_DETECTION_FAILED",
          message: resultUnknown
            ? "瑞云检测结果未知，需要管理员核对"
            : "瑞云检测同步失败，可在后台单独重试",
          at: timestamp,
        },
        updatedAt: timestamp,
      };
      await this.writeAll(records.map((record) => record.rmaNo === rmaNo ? updated : record));
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
      if (!["RECEIVED_PENDING_INSPECTION", "INSPECTION_COMPLETED_PENDING_REPAIR", "REPAIR_COMPLETION_DRAFT"].includes(existing.status)) {
        const error = new Error("当前工单不能选择维修配件");
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
      const existingApplication = (existing.partApplications || []).find((item) => item.partCode === part.code);
      if (existingApplication) {
        const error = new Error("该配件已添加，请直接修改已申请数量");
        error.code = "PART_ALREADY_APPLIED";
        error.status = 409;
        throw error;
      }
      if (part.stock < 1 || requestedQuantity > part.stock) {
        const error = new Error("库存不足，无法申请");
        error.code = "PART_OUT_OF_STOCK";
        error.status = 409;
        throw error;
      }
      const timestamp = new Date().toISOString();
      const rawRetailPrice = part.retailPrice;
      const normalizedRetailPrice = rawRetailPrice === null || rawRetailPrice === undefined || rawRetailPrice === ""
        ? null
        : Number(rawRetailPrice);
      const application = {
        id: crypto.randomUUID(),
        partCode: normalizeRequired(part.code),
        partName: normalizeRequired(part.name),
        quantity: requestedQuantity,
        stockSnapshot: part.stock,
        retailPrice: Number.isFinite(normalizedRetailPrice) && normalizedRetailPrice >= 0 ? normalizedRetailPrice : null,
        repairLevel: normalizeRequired(part.repairLevel),
        returnRequired: Boolean(part.returnRequired),
        projectCode: normalizeRequired(part.projectCode),
        sn: existing.sn,
        status: "PART_APPLICATION_RECORDED",
        operatorId: normalizeRequired(operator.userId),
        operatorName:
          normalizeRequired(operator.displayName) || "本地测试用户",
        createdAt: timestamp,
      };
      const updated = {
        ...existing,
        partApplications: [...(Array.isArray(existing.partApplications) ? existing.partApplications : []), application],
        resumeStep: "partsApplication",
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

  async updatePartApplication(rmaNo, applicationId, input = {}, operator = {}) {
    const operation = this.writeQueue.then(async () => {
      const records = await this.readAll();
      const existing = records.find((record) => record.rmaNo === rmaNo);
      if (!existing) throw Object.assign(new Error("未找到待维修工单"), { code: "RECEIPT_PREPARATION_NOT_FOUND", status: 404 });
      if (!["RECEIVED_PENDING_INSPECTION", "INSPECTION_COMPLETED_PENDING_REPAIR", "REPAIR_COMPLETION_DRAFT"].includes(existing.status)) {
        throw Object.assign(new Error("当前工单不能修改配件"), { code: "PART_APPLICATION_NOT_ALLOWED", status: 409 });
      }
      const current = (existing.partApplications || []).find((item) => item.id === applicationId);
      if (!current) throw Object.assign(new Error("未找到该配件记录"), { code: "PART_APPLICATION_NOT_FOUND", status: 404 });
      const remove = input.remove === true;
      const amount = Number(input.quantity);
      if (!remove && (!Number.isInteger(amount) || amount < 1)) {
        throw Object.assign(new Error("配件数量必须是正整数"), { code: "PART_QUANTITY_INVALID", status: 400 });
      }
      const timestamp = new Date().toISOString();
      const application = remove ? null : { ...current, quantity: amount, updatedAt: timestamp };
      const updated = {
        ...existing,
        partApplications: remove
          ? (existing.partApplications || []).filter((item) => item.id !== applicationId)
          : (existing.partApplications || []).map((item) => item.id === applicationId ? application : item),
        resumeStep: "partsApplication",
        updatedAt: timestamp,
        timeline: [...(existing.timeline || []), timelineEvent("PART_APPLICATION_UPDATED", remove ? "已删除误选配件" : "已修改配件数量", operator, timestamp)],
      };
      await this.writeAll(records.map((record) => record.rmaNo === rmaNo ? updated : record));
      return { order: updated, application };
    });
    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  async confirmParts(rmaNo, operator = {}) {
    const operation = this.writeQueue.then(async () => {
      const records = await this.readAll();
      const existing = records.find((record) => record.rmaNo === rmaNo);
      if (!existing) throw Object.assign(new Error("未找到待维修工单"), { code: "RECEIPT_PREPARATION_NOT_FOUND", status: 404 });
      if (!["RECEIVED_PENDING_INSPECTION", "INSPECTION_IN_PROGRESS", "INSPECTION_COMPLETED_PENDING_REPAIR", "REPAIR_COMPLETION_DRAFT"].includes(existing.status)) {
        throw Object.assign(new Error("当前工单不能确认维修配件"), { code: "PART_CONFIRMATION_NOT_ALLOWED", status: 409 });
      }
      if (!(existing.partApplications || []).length) {
        throw Object.assign(new Error("请先添加维修配件"), { code: "PART_CONFIRMATION_EMPTY", status: 409 });
      }
      const timestamp = new Date().toISOString();
      const updated = {
        ...existing,
        resumeStep: "repairProcess",
        partsConfirmedAt: timestamp,
        updatedAt: timestamp,
        timeline: [...(existing.timeline || []), timelineEvent("PARTS_CONFIRMED", "维修配件已确认，进入维修完工", operator, timestamp)],
      };
      await this.writeAll(records.map((record) => record.rmaNo === rmaNo ? updated : record));
      return { order: updated, nextStep: "repairProcess" };
    });
    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  async startRepair(rmaNo, input = {}, operator = {}) {
    const operation = this.writeQueue.then(async () => {
      const records = await this.readAll();
      const existing = records.find((record) => record.rmaNo === rmaNo);
      if (!existing) throw Object.assign(new Error("未找到待维修工单"), { code: "RECEIPT_PREPARATION_NOT_FOUND", status: 404 });
      if (!existing.inspectionUpdatedAt || !existing.recloudDetectionConfirmedAt && input.recloudSynced === true) {
        throw Object.assign(new Error("请先完成检测，再进入维修"), { code: "INSPECTION_REQUIRED", status: 409 });
      }
      if (existing.recloudServiceOrderCreatedAt) return existing;
      const timestamp = new Date().toISOString();
      const updated = {
        ...existing,
        status: "REPAIR_COMPLETION_DRAFT",
        resumeStep: "repairCompletion",
        recloudServiceOrderSyncStatus: input.recloudSynced === true
          ? "CONFIRMED"
          : normalizeRequired(input.recloudSyncStatus) || existing.recloudServiceOrderSyncStatus || "NOT_STARTED",
        recloudServiceOrderLastError: null,
        recloudServiceOrderCreatedAt: input.recloudSynced === true ? timestamp : existing.recloudServiceOrderCreatedAt || "",
        recloudRepairPreparation: input.repairPreparation
          ? { ...input.repairPreparation, status: input.recloudSynced === true ? "CONFIRMED" : "PENDING" }
          : existing.recloudRepairPreparation || null,
        repairStartedAt: timestamp,
        updatedAt: timestamp,
        timeline: [...(existing.timeline || []), timelineEvent("REPAIR_STARTED", "已进入维修", operator, timestamp)],
      };
      await this.writeAll(records.map((record) => record.rmaNo === rmaNo ? updated : record));
      return updated;
    });
    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  async markRecloudServiceOrderSyncing(rmaNo) {
    const operation = this.writeQueue.then(async () => {
      const records = await this.readAll();
      const existing = records.find((record) => record.rmaNo === rmaNo);
      if (!existing) throw Object.assign(new Error("未找到待维修工单"), { code: "RECEIPT_PREPARATION_NOT_FOUND", status: 404 });
      if (existing.recloudServiceOrderCreatedAt) return existing;
      if (existing.recloudServiceOrderSyncStatus === "RESULT_UNKNOWN") {
        throw Object.assign(new Error("瑞云服务单创建结果待人工核对，禁止重复提交"), { code: "RECLOUD_SERVICE_ORDER_RECONCILIATION_REQUIRED", status: 409 });
      }
      const timestamp = new Date().toISOString();
      const updated = {
        ...existing,
        recloudServiceOrderSyncStatus: "SYNCING",
        recloudServiceOrderAttemptedAt: timestamp,
        recloudServiceOrderLastError: null,
        updatedAt: timestamp,
      };
      await this.writeAll(records.map((record) => record.rmaNo === rmaNo ? updated : record));
      return updated;
    });
    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  async markRecloudServiceOrderConfirmed(rmaNo, operator = {}) {
    const operation = this.writeQueue.then(async () => {
      const records = await this.readAll();
      const existing = records.find((record) => record.rmaNo === rmaNo);
      if (!existing) throw Object.assign(new Error("未找到待维修工单"), { code: "RECEIPT_PREPARATION_NOT_FOUND", status: 404 });
      if (existing.recloudServiceOrderCreatedAt) return existing;
      const timestamp = new Date().toISOString();
      const updated = {
        ...existing,
        recloudServiceOrderSyncStatus: "CONFIRMED",
        recloudServiceOrderCreatedAt: timestamp,
        recloudServiceOrderLastError: null,
        updatedAt: timestamp,
        timeline: [
          ...(existing.timeline || []),
          timelineEvent("RECLOUD_SERVICE_ORDER_CREATED", "瑞云维修服务单已创建", operator, timestamp),
        ],
      };
      await this.writeAll(records.map((record) => record.rmaNo === rmaNo ? updated : record));
      return updated;
    });
    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  async markRecloudServiceOrderFailed(rmaNo, input = {}) {
    const operation = this.writeQueue.then(async () => {
      const records = await this.readAll();
      const existing = records.find((record) => record.rmaNo === rmaNo);
      if (!existing || existing.recloudServiceOrderCreatedAt) return existing;
      const timestamp = new Date().toISOString();
      const resultUnknown = input.resultUnknown === true;
      const updated = {
        ...existing,
        recloudServiceOrderSyncStatus: resultUnknown ? "RESULT_UNKNOWN" : "FAILED",
        recloudServiceOrderLastError: {
          code: normalizeRequired(input.code) || "RECLOUD_SERVICE_ORDER_FAILED",
          message: resultUnknown
            ? "瑞云服务单创建结果未知，需要管理员核对"
            : "瑞云服务单创建失败，可在后台单独重试",
          at: timestamp,
        },
        updatedAt: timestamp,
      };
      await this.writeAll(records.map((record) => record.rmaNo === rmaNo ? updated : record));
      return updated;
    });
    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  async markRecloudRepairPreparationConfirmed(rmaNo, input = {}, operator = {}) {
    const operation = this.writeQueue.then(async () => {
      const records = await this.readAll();
      const existing = records.find((record) => record.rmaNo === rmaNo);
      if (!existing) throw Object.assign(new Error("未找到待维修工单"), { code: "RECEIPT_PREPARATION_NOT_FOUND", status: 404 });
      const timestamp = new Date().toISOString();
      const updated = {
        ...existing,
        recloudRepairPreparation: {
          ...(existing.recloudRepairPreparation || {}),
          status: "CONFIRMED",
          completedAt: timestamp,
          completedSteps: Array.isArray(input.completedSteps) ? input.completedSteps : [],
        },
        updatedAt: timestamp,
        timeline: [
          ...(existing.timeline || []),
          timelineEvent("RECLOUD_REPAIR_PREPARATION_CONFIRMED", "瑞云已完成改派、保外转保内确认和配件添加", operator, timestamp),
        ],
      };
      await this.writeAll(records.map((record) => record.rmaNo === rmaNo ? updated : record));
      return updated;
    });
    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  async markRecloudRepairPreparationFailed(rmaNo, input = {}) {
    const operation = this.writeQueue.then(async () => {
      const records = await this.readAll();
      const existing = records.find((record) => record.rmaNo === rmaNo);
      if (!existing) throw Object.assign(new Error("未找到待维修工单"), { code: "RECEIPT_PREPARATION_NOT_FOUND", status: 404 });
      const timestamp = new Date().toISOString();
      const updated = {
        ...existing,
        recloudRepairPreparation: {
          ...(existing.recloudRepairPreparation || {}),
          status: "FAILED",
          failedAt: timestamp,
          lastError: {
            code: normalizeRequired(input.code) || "RECLOUD_REPAIR_PREPARATION_FAILED",
            message: normalizeRequired(input.message) || "瑞云服务单已创建，但首次进入时的维修准备未全部完成",
          },
        },
        updatedAt: timestamp,
      };
      await this.writeAll(records.map((record) => record.rmaNo === rmaNo ? updated : record));
      return updated;
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
      const hasSavedInspection = Boolean(existing.inspectionUpdatedAt && existing.faultCategory && existing.technicianWarranty);
      if (!["INSPECTION_COMPLETED_PENDING_REPAIR", "REPAIR_COMPLETION_DRAFT"].includes(existing.status) && !hasSavedInspection) {
        throw Object.assign(new Error("仅已完成检测的工单可以进入维修完工"), {
          code: "REPAIR_COMPLETION_NOT_ALLOWED", status: 409,
        });
      }
      const faultLevel1 = normalizeRequired(input.faultLevel1);
      const faultLevel2 = normalizeRequired(input.faultLevel2);
      const faultLevel3 = normalizeRequired(input.faultLevel3);
      const responsibilityType = normalizeRequired(input.responsibilityType);
      const detectionResult = normalizeRequired(input.detectionResult);
      const repairMeasure = normalizeRequired(input.repairMeasure);
      if (submit) {
        const missingFields = [];
        if (!existing.sn) missingFields.push("sn");
        const skipsFaultClassification = ["ABANDONED", "INSPECTION_ONLY", "DEBUGGING"].includes(existing.treatmentMode);
        if (!skipsFaultClassification && (!faultLevel1 || !faultLevel2 || !faultLevel3)) missingFields.push("faultClassification");
        if (!responsibilityType) missingFields.push("responsibilityType");
        if (!detectionResult) missingFields.push("detectionResult");
        if (!repairMeasure) missingFields.push("repairMeasure");
        if (!Array.isArray(input.attachments) || !input.attachments.length) missingFields.push("attachments");
        if (existing.treatmentMode === "INSPECTION_ONLY" && !(Array.isArray(input.attachments) && input.attachments.some((item) => item?.mimeType === "application/pdf"))) {
          missingFields.push("inspectionReportPdf");
        }
        if (existing.treatmentMode === "INSPECTION_ONLY" && !(Array.isArray(input.attachments) && input.attachments.some((item) => /^(image|video)\//.test(item?.mimeType || "")))) {
          missingFields.push("inspectionMedia");
        }
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
        resumeStep: "repairCompletion",
        repairCompletion: {
          faultLevel1, faultLevel2, faultLevel3,
          responsibilityType,
          detectionResult,
          speechTemplate: normalizeRequired(input.speechTemplate),
          repairMeasure,
          logisticsChargeMode: normalizeRequired(input.logisticsChargeMode) || "ROUND_TRIP",
          oneWayLogisticsFee: Number(input.oneWayLogisticsFee) || 0,
          logisticsFee: Number(input.logisticsFee) || 0,
          primaryRemark: normalizeRequired(input.primaryRemark),
          secondaryRemark: normalizeRequired(input.secondaryRemark),
          pricing: input.pricing || null,
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

  async saveSupervisionOrder(rmaNo, input = {}, operator = {}) {
    const operation = this.writeQueue.then(async () => {
      const records = await this.readAll();
      const existing = records.find((record) => record.rmaNo === rmaNo);
      if (!existing) throw Object.assign(new Error("未找到督办单对应工单"), { code: "RECEIPT_PREPARATION_NOT_FOUND", status: 404 });
      const sourceId = normalizeRequired(input.sourceId);
      const current = (existing.supervisionOrders || []).find((item) => sourceId && item.sourceId === sourceId);
      const timestamp = new Date().toISOString();
      const supervisionOrder = {
        id: current?.id || crypto.randomUUID(),
        sourceId,
        source: "RECLOUD_SUPERVISION",
        recloudStatus: normalizeRequired(input.recloudStatus) || current?.recloudStatus || "未处理",
        originalContent: normalizeRequired(input.originalContent),
        analysis: input.analysis || null,
        status: ["REPLIED", "REPLIED_BY_INFORMATION_CLERK"].includes(current?.status) ? "REPLIED_BY_INFORMATION_CLERK" : "NOTIFIED_TECHNICIAN",
        replyContent: current?.replyContent || "",
        repliedAt: current?.repliedAt || null,
        replyOwner: "INFORMATION_CLERK",
        readBy: Array.isArray(current?.readBy) ? current.readBy : [],
        archivedAt: input.recloudStatus && !/已完成/.test(input.recloudStatus)
          ? null
          : current?.archivedAt || null,
        assignedTechnicianId: existing.technicianId || existing.operatorId,
        assignedTechnicianName: existing.technicianName || existing.operatorName,
        capturedAt: current?.capturedAt || timestamp,
        updatedAt: timestamp,
      };
      const updated = {
        ...existing,
        supervisionOrders: current
          ? (existing.supervisionOrders || []).map((item) => item.id === current.id ? supervisionOrder : item)
          : [...(existing.supervisionOrders || []), supervisionOrder],
        updatedAt: timestamp,
        timeline: current ? existing.timeline || [] : [...(existing.timeline || []), timelineEvent("SUPERVISION_RECEIVED", "收到客服督办单", operator, timestamp)],
      };
      await this.writeAll(records.map((record) => record.rmaNo === rmaNo ? updated : record));
      return { order: updated, supervisionOrder };
    });
    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  async markSupervisionOrderRead(rmaNo, supervisionOrderId, operator = {}) {
    const operation = this.writeQueue.then(async () => {
      const records = await this.readAll();
      const existing = records.find((record) => record.rmaNo === rmaNo);
      if (!existing) throw Object.assign(new Error("未找到督办单对应工单"), { code: "RECEIPT_PREPARATION_NOT_FOUND", status: 404 });
      const userId = normalizeRequired(operator.userId);
      const item = (existing.supervisionOrders || []).find((order) => order.id === supervisionOrderId);
      if (!item) throw Object.assign(new Error("未找到督办通知"), { code: "SUPERVISION_ORDER_NOT_FOUND", status: 404 });
      const timestamp = new Date().toISOString();
      const alreadyRead = (item.readBy || []).some((entry) => entry.userId === userId);
      const updatedItem = alreadyRead ? item : {
        ...item,
        readBy: [...(item.readBy || []), { userId, readAt: timestamp }],
        updatedAt: timestamp,
      };
      const updated = {
        ...existing,
        supervisionOrders: (existing.supervisionOrders || []).map((order) => order.id === supervisionOrderId ? updatedItem : order),
        updatedAt: alreadyRead ? existing.updatedAt : timestamp,
      };
      if (!alreadyRead) await this.writeAll(records.map((record) => record.rmaNo === rmaNo ? updated : record));
      return updatedItem;
    });
    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  async archiveSupervisionOrder(rmaNo, sourceId, operator = {}) {
    const operation = this.writeQueue.then(async () => {
      const records = await this.readAll();
      const existing = records.find((record) => record.rmaNo === rmaNo);
      if (!existing) return null;
      const item = (existing.supervisionOrders || []).find((order) => order.sourceId === sourceId);
      if (!item || item.archivedAt) return item || null;
      const timestamp = new Date().toISOString();
      const archived = { ...item, recloudStatus: "已完成", archivedAt: timestamp, updatedAt: timestamp };
      const updated = {
        ...existing,
        supervisionOrders: (existing.supervisionOrders || []).map((order) => order.id === item.id ? archived : order),
        updatedAt: timestamp,
        timeline: [...(existing.timeline || []), timelineEvent("SUPERVISION_COMPLETED", "客服督办单已完成", operator, timestamp)],
      };
      await this.writeAll(records.map((record) => record.rmaNo === rmaNo ? updated : record));
      return archived;
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
      return [roles.ADMIN, roles.INFORMATION_CLERK].includes(user.role);
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

  async setResumeStep(rmaNo, resumeStep, operator = {}) {
    const operation = this.writeQueue.then(async () => {
      const allowedSteps = new Set(["repairWarranty", "repairDecision", "partsApplication", "repairProcess", "repairCompletion"]);
      if (!allowedSteps.has(resumeStep)) {
        throw Object.assign(new Error("无效的工单恢复步骤"), { code: "REPAIR_RESUME_STEP_INVALID", status: 400 });
      }
      const records = await this.readAll();
      const existing = records.find((record) => record.rmaNo === rmaNo);
      if (!existing) {
        throw Object.assign(new Error("未找到维修工单"), { code: "RECEIPT_PREPARATION_NOT_FOUND", status: 404 });
      }
      if (["REPAIR_COMPLETED_PENDING_SHIPMENT", "SHIPPED_PENDING_COMPLETION", "COMPLETED"].includes(existing.status)) {
        throw Object.assign(new Error("已提交完工的工单不能修改恢复步骤"), { code: "REPAIR_RESUME_STEP_LOCKED", status: 409 });
      }
      if ((existing.technicianId || existing.operatorId) !== operator.userId) {
        throw Object.assign(new Error("只能更新本人负责工单的恢复步骤"), { code: "REPAIR_RESUME_STEP_FORBIDDEN", status: 403 });
      }
      const updated = { ...existing, resumeStep, updatedAt: new Date().toISOString() };
      await this.writeAll(records.map((record) => record.rmaNo === rmaNo ? updated : record));
      return updated;
    });
    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  async reopenTreatmentDecision(rmaNo, operator = {}) {
    const operation = this.writeQueue.then(async () => {
      if (normalizeRequired(operator.role).toUpperCase() !== "ADMIN") {
        throw Object.assign(new Error("只有管理员可以恢复工单处理方式"), {
          code: "TREATMENT_REOPEN_ADMIN_REQUIRED", status: 403,
        });
      }
      const records = await this.readAll();
      const existing = records.find((record) => record.rmaNo === rmaNo);
      if (!existing) {
        throw Object.assign(new Error("未找到需要恢复的维修工单"), {
          code: "RECEIPT_PREPARATION_NOT_FOUND", status: 404,
        });
      }
      if (!existing.receiptCompletedAt) {
        throw Object.assign(new Error("工单尚未完成签收，不能恢复处理方式"), {
          code: "TREATMENT_REOPEN_RECEIPT_REQUIRED", status: 409,
        });
      }
      if (["SHIPPED_PENDING_COMPLETION", "COMPLETED"].includes(existing.status) || existing.returnShipment?.shippedAt) {
        throw Object.assign(new Error("机器已经返件发货或工单已经完结，不能恢复处理方式"), {
          code: "TREATMENT_REOPEN_SHIPPED", status: 409,
        });
      }
      if (!existing.treatmentMode && !existing.repairCompletion) {
        throw Object.assign(new Error("工单已经处于处理方式选择步骤"), {
          code: "TREATMENT_REOPEN_DUPLICATE", status: 409,
        });
      }
      const timestamp = new Date().toISOString();
      const recoveryRecord = {
        reopenedAt: timestamp,
        reopenedById: normalizeRequired(operator.userId),
        reopenedByName: normalizeRequired(operator.displayName) || "系统管理员",
        previousStatus: existing.status,
        previousTreatmentMode: existing.treatmentMode || "",
        previousTreatmentLabel: existing.treatmentLabel || "",
        previousRepairCompletion: existing.repairCompletion || null,
      };
      const updated = {
        ...existing,
        status: "RECEIVED_PENDING_INSPECTION",
        resumeStep: "repairDecision",
        treatmentMode: "",
        treatmentLabel: "",
        skipsParts: false,
        treatmentDecidedAt: null,
        transferredToHeadquartersAt: null,
        inspectionResult: "",
        inspectionRemark: "",
        faultCategory: "",
        technicianWarranty: "",
        warrantyDecision: null,
        detectionResult: "",
        inspectionUpdatedAt: null,
        customerReasonConsistent: "",
        inspectionAbnormal: "",
        productFunctionDecision: "",
        originalConsumables: "",
        consumableName: "",
        dismantled: "",
        repairCompletion: null,
        treatmentReopenHistory: [...(existing.treatmentReopenHistory || []), recoveryRecord],
        updatedAt: timestamp,
        timeline: [
          ...(existing.timeline || []),
          timelineEvent("TREATMENT_REOPENED", "管理员恢复到处理方式选择", operator, timestamp),
        ],
      };
      await this.writeAll(records.map((record) => record.rmaNo === rmaNo ? updated : record));
      return updated;
    });
    this.writeQueue = operation.catch(() => {});
    return operation;
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
  validateReceiptCompletion,
};
