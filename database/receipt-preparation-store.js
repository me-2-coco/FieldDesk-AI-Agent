const path = require("path");
const crypto = require("crypto");
const { JsonDocumentBackend } = require("./storage-backend");
const { resolveFaultContent } = require("../services/inspection-form-rules");

const ACTIVE_RECEIPT_STATUSES = new Set([
  "RECEIPT_PREPARED",
  "TRANSFER_TO_HEADQUARTERS_PENDING",
  "RECEIVED_PENDING_INSPECTION",
  "INSPECTION_IN_PROGRESS",
  "INSPECTION_COMPLETED_PENDING_REPAIR",
  "REPAIR_COMPLETION_DRAFT",
  "ON_HOLD",
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
  // “瑞云已签收”只表示不需要再次点击签收按钮。项目号核对和
  // FieldDesk 签收附件仍是每张工单都必须完成的独立步骤。
  if (!(existing.receiptAttachments || []).length) {
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
    customerAddress: normalizeRequired(input.customerAddress || input.regionAddress),
    sourceCreatedAt: normalizeRequired(input.sourceCreatedAt),
    productModel: normalizeRequired(input.productModel),
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
    recloudProjectVerificationStatus:
      existing?.recloudProjectVerificationStatus || "NOT_STARTED",
    recloudProjectVerificationAttemptedAt:
      existing?.recloudProjectVerificationAttemptedAt || "",
    recloudProjectVerificationConfirmedAt:
      existing?.recloudProjectVerificationConfirmedAt || "",
    recloudVerifiedProjectCode:
      existing?.recloudVerifiedProjectCode || "",
    recloudProjectVerificationLastError:
      existing?.recloudProjectVerificationLastError || null,
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
    snCorrectionRequiredAt: "",
    snCorrectionHistory: existing?.snCorrectionHistory || [],
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

  async deleteLocalOrder(rmaNo, operator = {}) {
    const operation = this.writeQueue.then(async () => {
      if (normalizeRequired(operator.role).toUpperCase() !== "ADMIN") {
        throw Object.assign(new Error("只有管理员或负责人可以删除误操作工单"), {
          code: "LOCAL_ORDER_DELETE_ADMIN_REQUIRED", status: 403,
        });
      }
      const records = await this.readAll();
      const existing = records.find((record) => record.rmaNo === rmaNo);
      if (!existing) {
        throw Object.assign(new Error("未找到需要删除的工单"), {
          code: "RECEIPT_PREPARATION_NOT_FOUND", status: 404,
        });
      }
      if (["REPAIR_COMPLETED_PENDING_SHIPMENT", "SHIPPED_PENDING_COMPLETION", "COMPLETED"].includes(existing.status) || existing.returnShipment?.shippedAt) {
        throw Object.assign(new Error("已完工、已发货或已完结工单不能删除"), {
          code: "LOCAL_ORDER_DELETE_SHIPPED", status: 409,
        });
      }
      await this.writeAll(records.filter((record) => record.rmaNo !== rmaNo));
      return existing;
    });
    this.writeQueue = operation.catch(() => {});
    return operation;
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
      if (existing?.recloudReceiptConfirmedAt && !existing.snCorrectionRequiredAt) return existing;
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
      if (existing.recloudReceiptConfirmedAt) {
        if (!existing.recloudReceiptLastError) return existing;
        const normalized = { ...existing, recloudReceiptLastError: null };
        await this.writeAll(records.map((record) => record.rmaNo === rmaNo ? normalized : record));
        return normalized;
      }
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
        recloudReceiptLastError: null,
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
      if (
        !existing ||
        existing.recloudReceiptConfirmedAt ||
        existing.recloudReceiptSyncStatus === "RESULT_UNKNOWN"
      ) return existing;
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
      // The uploader first reads existing filenames from the verified RMA and
      // sends only missing files, so an interrupted/unknown attempt is safe to
      // reconcile and resume without creating duplicate attachments.
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

  async markRecloudProjectVerification(rmaNo, status, input = {}) {
    const operation = this.writeQueue.then(async () => {
      const records = await this.readAll();
      const existing = records.find((record) => record.rmaNo === rmaNo);
      if (!existing) throw Object.assign(new Error("未找到本地签收准备记录"), { code: "RECEIPT_PREPARATION_NOT_FOUND", status: 404 });
      const timestamp = new Date().toISOString();
      const normalizedStatus = ["SYNCING", "CONFIRMED", "FAILED"].includes(status) ? status : "FAILED";
      const updated = {
        ...existing,
        recloudProjectVerificationStatus: normalizedStatus,
        recloudProjectVerificationAttemptedAt: existing.recloudProjectVerificationAttemptedAt || timestamp,
        recloudProjectVerificationConfirmedAt: normalizedStatus === "CONFIRMED" ? timestamp : existing.recloudProjectVerificationConfirmedAt || "",
        recloudVerifiedProjectCode: normalizedStatus === "CONFIRMED" ? normalizeRequired(input.projectCode) : existing.recloudVerifiedProjectCode || "",
        recloudProjectVerificationLastError: normalizedStatus === "FAILED" ? {
          code: normalizeRequired(input.code) || "RECLOUD_PROJECT_VERIFICATION_FAILED",
          message: normalizeRequired(input.message) || "瑞云项目号核对失败，系统将自动重试",
          at: timestamp,
        } : null,
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
      if (
        !existing ||
        existing.recloudReceiptAttachmentConfirmedAt ||
        existing.recloudReceiptAttachmentSyncStatus === "RESULT_UNKNOWN"
      ) return existing;
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
        ON_HOLD: "暂存",
      };
      if (!labels[treatmentMode]) throw Object.assign(new Error("请选择有效的维修处理方式"), { code: "TREATMENT_MODE_INVALID", status: 400 });
      const inspectionFaultOutcome = normalizeRequired(input.inspectionFaultOutcome);
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
        inspectionFaultOutcome: treatmentMode === "INSPECTION_ONLY" ? inspectionFaultOutcome : "",
        faultContent: treatmentMode === "ON_HOLD"
          ? existing.faultContent || ""
          : resolveFaultContent({
            treatmentMode,
            inspectionFaultOutcome: treatmentMode === "INSPECTION_ONLY" ? inspectionFaultOutcome : "",
            faultCategory: existing.faultCategory,
          }),
        skipsParts,
        status: treatmentMode === "ON_HOLD"
          ? "ON_HOLD"
          : hasSavedInspection ? "INSPECTION_COMPLETED_PENDING_REPAIR" : "RECEIVED_PENDING_INSPECTION",
        resumeStep: treatmentMode === "ON_HOLD"
          ? ""
          : treatmentMode === "ABANDONED"
            || (treatmentMode === "INSPECTION_ONLY" && inspectionFaultOutcome === "FAULT_REPRODUCED")
            ? "partsApplication"
            : "repairProcess",
        diagnosticParts: treatmentMode === "INSPECTION_ONLY" && inspectionFaultOutcome === "FAULT_REPRODUCED"
          ? (Array.isArray(existing.diagnosticParts) ? existing.diagnosticParts : [])
          : [],
        diagnosticPartsConfirmedAt: treatmentMode === "INSPECTION_ONLY" && inspectionFaultOutcome === "FAULT_REPRODUCED"
          ? existing.diagnosticPartsConfirmedAt || null
          : null,
        inspectionResult: normalizeRequired(input.detectionResult),
        detectionResult: normalizeRequired(input.detectionResult),
        technicianWarranty,
        warrantyDecision: input.warrantyDecision || existing.warrantyDecision || null,
        treatmentDecidedAt: timestamp,
        ...(treatmentMode === "ON_HOLD" ? {
          hold: {
            category: normalizeRequired(input.holdCategory),
            reason: normalizeRequired(input.holdReason),
            remark: normalizeRequired(input.holdRemark),
            status: "PENDING",
            requestedAt: timestamp,
            requestedById: normalizeRequired(operator.userId),
            requestedByName: normalizeRequired(operator.displayName) || "本地测试用户",
            confirmedAt: "",
            lastError: null,
          },
        } : {}),
        inspectionUpdatedAt: existing.inspectionUpdatedAt,
        updatedAt: timestamp,
        timeline: [
          ...(existing.timeline || []),
          timelineEvent(
            treatmentMode === "ON_HOLD" ? "ORDER_HOLD_REQUESTED" : "TREATMENT_DECIDED",
            treatmentMode === "ON_HOLD"
              ? `已暂存：${normalizeRequired(input.holdCategory)} / ${normalizeRequired(input.holdReason)}；${normalizeRequired(input.holdRemark)}`
              : `维修处理方式：${labels[treatmentMode]}`,
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

  async saveFreightWaiverApplication(rmaNo, application = {}, operator = {}) {
    const operation = this.writeQueue.then(async () => {
      const records = await this.readAll();
      const existing = records.find((record) => record.rmaNo === rmaNo);
      if (!existing) throw Object.assign(new Error("未找到已签收工单"), { code: "RECEIPT_PREPARATION_NOT_FOUND", status: 404 });
      if (existing.treatmentMode !== "ABANDONED") {
        throw Object.assign(new Error("只有弃修工单可以生成免运费申请单"), { code: "FREIGHT_WAIVER_NOT_APPLICABLE", status: 409 });
      }
      const timestamp = new Date().toISOString();
      const previous = existing.freightWaiverApplication || {};
      const nextStatus = normalizeRequired(application.status) || previous.status || "DRAFT";
      const updated = {
        ...existing,
        freightWaiverApplication: {
          ...previous,
          ...application,
          status: nextStatus,
          createdAt: previous.createdAt || timestamp,
          updatedAt: timestamp,
        },
        updatedAt: timestamp,
        timeline: previous.status
          ? existing.timeline || []
          : [
              ...(existing.timeline || []),
              timelineEvent("FREIGHT_WAIVER_APPLICATION_CREATED", "免运费申请单已在后台建立", operator, timestamp),
            ],
      };
      await this.writeAll(records.map((record) => record.rmaNo === rmaNo ? updated : record));
      return updated;
    });
    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  async markInspectionOnlyAwaitingInformation(rmaNo, result = {}, operator = {}) {
    const operation = this.writeQueue.then(async () => {
      const records = await this.readAll();
      const existing = records.find((record) => record.rmaNo === rmaNo);
      if (!existing) throw Object.assign(new Error("未找到维修工单"), { code: "RECEIPT_PREPARATION_NOT_FOUND", status: 404 });
      const timestamp = new Date().toISOString();
      const informationClerkAction = normalizeRequired(result.informationClerkAction)
        || (existing.treatmentMode === "INSPECTION_ONLY"
          ? "开检测报告、上传报告、修改地址并提交"
          : "核对维修资料并提交");
      const handoffMessage = `瑞云已完工确认，待信息员${informationClerkAction}`;
      const updated = {
        ...existing,
        inspectionOnlyHandoff: {
          status: "PENDING_INFORMATION",
          message: handoffMessage,
          informationClerkAction,
          completedSteps: Array.isArray(result.completedSteps) ? result.completedSteps : [],
          requestedAt: existing.inspectionOnlyHandoff?.requestedAt || timestamp,
          updatedAt: timestamp,
        },
        updatedAt: timestamp,
        timeline: existing.inspectionOnlyHandoff?.status === "PENDING_INFORMATION"
          ? existing.timeline || []
          : [...(existing.timeline || []), timelineEvent("RECLOUD_COMPLETED_AWAITING_INFORMATION", `瑞云已完工确认，已通知信息员${informationClerkAction}`, operator, timestamp)],
      };
      await this.writeAll(records.map((record) => record.rmaNo === rmaNo ? updated : record));
      return updated;
    });
    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  async markRecloudHoldConfirmed(rmaNo, result = {}, operator = {}) {
    const operation = this.writeQueue.then(async () => {
      const records = await this.readAll();
      const existing = records.find((record) => record.rmaNo === rmaNo);
      if (!existing?.hold) throw Object.assign(new Error("未找到暂存记录"), { code: "HOLD_NOT_FOUND", status: 404 });
      const timestamp = new Date().toISOString();
      const updated = {
        ...existing,
        hold: { ...existing.hold, status: "CONFIRMED", confirmedAt: timestamp, lastError: null, result },
        updatedAt: timestamp,
        timeline: [...(existing.timeline || []), timelineEvent("RECLOUD_HOLD_CONFIRMED", "瑞云滞留已同步", operator, timestamp)],
      };
      await this.writeAll(records.map((record) => record.rmaNo === rmaNo ? updated : record));
      return updated;
    });
    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  async markRecloudHoldFailed(rmaNo, error = {}, operator = {}) {
    const operation = this.writeQueue.then(async () => {
      const records = await this.readAll();
      const existing = records.find((record) => record.rmaNo === rmaNo);
      if (!existing?.hold || existing.hold.status === "CONFIRMED") return existing;
      const timestamp = new Date().toISOString();
      const updated = {
        ...existing,
        hold: {
          ...existing.hold,
          status: "FAILED",
          lastError: { code: normalizeRequired(error.code) || "RECLOUD_HOLD_SYNC_FAILED", at: timestamp },
        },
        updatedAt: timestamp,
        timeline: [...(existing.timeline || []), timelineEvent("RECLOUD_HOLD_FAILED", "瑞云滞留同步失败，等待重试", operator, timestamp)],
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
        inspectionFaultOutcome: normalizeRequired(input.inspectionFaultOutcome)
          || existing.inspectionFaultOutcome
          || "",
        faultContent: normalizeRequired(input.faultContent)
          || resolveFaultContent({
            treatmentMode: existing.treatmentMode,
            inspectionFaultOutcome: normalizeRequired(input.inspectionFaultOutcome) || existing.inspectionFaultOutcome,
            faultCategory: input.faultCategory,
          }),
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
      if (
        !existing ||
        existing.recloudDetectionConfirmedAt ||
        existing.recloudDetectionSyncStatus === "RESULT_UNKNOWN"
      ) return existing;
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

  async resetRecloudDetectionAfterReconciliation(rmaNo, operator = {}) {
    const operation = this.writeQueue.then(async () => {
      const records = await this.readAll();
      const existing = records.find((record) => record.rmaNo === rmaNo);
      if (!existing) throw Object.assign(new Error("未找到待检测工单"), { code: "RECEIPT_PREPARATION_NOT_FOUND", status: 404 });
      if (existing.recloudDetectionConfirmedAt) return existing;
      const timestamp = new Date().toISOString();
      const updated = {
        ...existing,
        recloudDetectionSyncStatus: "FAILED",
        recloudDetectionLastError: {
          code: "RECLOUD_DETECTION_RETRY_APPROVED",
          message: "已核对瑞云尚未完成检测，允许安全重试",
          at: timestamp,
        },
        updatedAt: timestamp,
        timeline: [
          ...(existing.timeline || []),
          timelineEvent("RECLOUD_DETECTION_RETRY_APPROVED", "已核对瑞云未检测，重新进入自动同步", operator, timestamp),
        ],
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
      const quoteOnly = existing.treatmentMode === "ABANDONED";
      const diagnosticOnly = existing.treatmentMode === "INSPECTION_ONLY" && existing.inspectionFaultOutcome === "FAULT_REPRODUCED";
      const recordOnly = quoteOnly || diagnosticOnly;
      const partCollection = quoteOnly
        ? (existing.abandonedQuoteParts || [])
        : diagnosticOnly ? (existing.diagnosticParts || []) : (existing.partApplications || []);
      const existingApplication = partCollection.find((item) => item.partCode === part.code);
      if (existingApplication) {
        const error = new Error("该配件已添加，请直接修改已申请数量");
        error.code = "PART_ALREADY_APPLIED";
        error.status = 409;
        throw error;
      }
      if (!recordOnly && part.recloudConfirmed !== true && (part.stock < 1 || requestedQuantity > part.stock)) {
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
        isReplacementPart: part.isReplacementPart === true,
        sourcePartCode: part.isReplacementPart === true ? normalizeRequired(part.sourceCode) : "",
        replacesShortagePartCode: normalizeRequired(part.replacesShortagePartCode).toUpperCase(),
        projectCode: normalizeRequired(part.projectCode),
        sn: existing.sn,
        status: quoteOnly
          ? "ABANDONED_QUOTE_PART_RECORDED"
          : diagnosticOnly
            ? "DIAGNOSTIC_PART_RECORDED"
            : part.recloudConfirmed === true
              ? "RECLOUD_PART_CONFIRMED"
              : normalizeRequired(part.verificationStatus) || "RECLOUD_PART_VERIFY_PENDING",
        verificationQuery: normalizeRequired(part.verificationQuery) || normalizeRequired(part.code),
        recloudVerificationStatus: recordOnly
          ? "NOT_REQUIRED"
          : part.recloudConfirmed === true
            ? "AVAILABLE"
            : normalizeRequired(part.verificationStatus) || "PENDING",
        recloudVerificationOptions: Array.isArray(part.verificationOptions) ? part.verificationOptions : [],
        recloudVerificationError: null,
        recloudVerifiedAt: part.recloudConfirmed === true ? timestamp : "",
        recloudConfirmedAt: part.recloudConfirmed === true ? timestamp : "",
        recloudSource: part.recloudConfirmed === true ? "SERVICE_ORDER" : "",
        quoteOnly,
        diagnosticOnly,
        recordOnly,
        operatorId: normalizeRequired(operator.userId),
        operatorName:
          normalizeRequired(operator.displayName) || "本地测试用户",
        createdAt: timestamp,
      };
      const updated = {
        ...existing,
        ...(quoteOnly
          ? { abandonedQuoteParts: [...(Array.isArray(existing.abandonedQuoteParts) ? existing.abandonedQuoteParts : []), application] }
          : diagnosticOnly
            ? { diagnosticParts: [...(Array.isArray(existing.diagnosticParts) ? existing.diagnosticParts : []), application] }
          : { partApplications: [...(Array.isArray(existing.partApplications) ? existing.partApplications : []), application] }),
        noPartsDeclaredAt: null,
        noPartsReason: "",
        resumeStep: "partsApplication",
        updatedAt: timestamp,
        timeline: [
          ...(existing.timeline || []),
          timelineEvent(
            quoteOnly ? "ABANDONED_QUOTE_PART" : diagnosticOnly ? "DIAGNOSTIC_PART" : "PART_APPLICATION",
            quoteOnly ? "弃修报价配件已记录" : diagnosticOnly ? "只检测故障配件已记录（不写入瑞云）" : "配件申请已记录",
            operator,
            timestamp
          ),
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
      const quoteOnly = existing.treatmentMode === "ABANDONED";
      const diagnosticOnly = existing.treatmentMode === "INSPECTION_ONLY" && existing.inspectionFaultOutcome === "FAULT_REPRODUCED";
      const partCollection = quoteOnly
        ? (existing.abandonedQuoteParts || [])
        : diagnosticOnly ? (existing.diagnosticParts || []) : (existing.partApplications || []);
      const current = partCollection.find((item) => item.id === applicationId);
      if (!current) throw Object.assign(new Error("未找到该配件记录"), { code: "PART_APPLICATION_NOT_FOUND", status: 404 });
      if (current.recloudConfirmedAt || current.recloudVerificationStatus === "OUT_OF_STOCK") {
        throw Object.assign(new Error(current.recloudVerificationStatus === "OUT_OF_STOCK"
          ? "瑞云已确认缺件，该记录已锁定，不能删除绕过信息员处理"
          : "该配件已写入瑞云，不能在 FieldDesk 直接修改或删除"), {
          code: "RECLOUD_PART_APPLICATION_LOCKED",
          status: 409,
        });
      }
      const remove = input.remove === true;
      const amount = Number(input.quantity);
      if (!remove && (!Number.isInteger(amount) || amount < 1)) {
        throw Object.assign(new Error("配件数量必须是正整数"), { code: "PART_QUANTITY_INVALID", status: 400 });
      }
      const timestamp = new Date().toISOString();
      const application = remove ? null : { ...current, quantity: amount, updatedAt: timestamp };
      const updated = {
        ...existing,
        ...(quoteOnly ? {
          abandonedQuoteParts: remove
            ? partCollection.filter((item) => item.id !== applicationId)
            : partCollection.map((item) => item.id === applicationId ? application : item),
        } : diagnosticOnly ? {
          diagnosticParts: remove
            ? partCollection.filter((item) => item.id !== applicationId)
            : partCollection.map((item) => item.id === applicationId ? application : item),
        } : {
          partApplications: remove
            ? partCollection.filter((item) => item.id !== applicationId)
            : partCollection.map((item) => item.id === applicationId ? application : item),
        }),
        resumeStep: "partsApplication",
        updatedAt: timestamp,
        timeline: [...(existing.timeline || []), timelineEvent(quoteOnly ? "ABANDONED_QUOTE_PART_UPDATED" : diagnosticOnly ? "DIAGNOSTIC_PART_UPDATED" : "PART_APPLICATION_UPDATED", remove ? "已删除误选配件" : "已修改配件数量", operator, timestamp)],
      };
      await this.writeAll(records.map((record) => record.rmaNo === rmaNo ? updated : record));
      return { order: updated, application };
    });
    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  async confirmParts(rmaNo, operator = {}, input = {}) {
    const operation = this.writeQueue.then(async () => {
      const records = await this.readAll();
      const existing = records.find((record) => record.rmaNo === rmaNo);
      if (!existing) throw Object.assign(new Error("未找到待维修工单"), { code: "RECEIPT_PREPARATION_NOT_FOUND", status: 404 });
      if (!["RECEIVED_PENDING_INSPECTION", "INSPECTION_IN_PROGRESS", "INSPECTION_COMPLETED_PENDING_REPAIR", "REPAIR_COMPLETION_DRAFT"].includes(existing.status)) {
        throw Object.assign(new Error("当前工单不能确认维修配件"), { code: "PART_CONFIRMATION_NOT_ALLOWED", status: 409 });
      }
      const quoteOnly = existing.treatmentMode === "ABANDONED";
      const diagnosticOnly = existing.treatmentMode === "INSPECTION_ONLY" && existing.inspectionFaultOutcome === "FAULT_REPRODUCED";
      const selectedParts = quoteOnly
        ? (existing.abandonedQuoteParts || [])
        : diagnosticOnly ? (existing.diagnosticParts || []) : (existing.partApplications || []);
      const shortagePending = existing.partsShortage?.status === "PENDING_INFORMATION"
        && (existing.partsShortage?.parts || []).length > 0;
      const noParts = input.noParts === true;
      const noPartsReason = normalizeRequired(input.noPartsReason);
      const unresolvedParts = existing.treatmentMode === "REPAIR"
        ? selectedParts.filter((part) => !["AVAILABLE", "OUT_OF_STOCK"].includes(normalizeRequired(part.recloudVerificationStatus)))
        : [];
      if (unresolvedParts.length) {
        throw Object.assign(new Error("配件仍在瑞云核实中，请等待全部返回可用或缺件结果"), {
          code: "RECLOUD_PART_VERIFICATION_PENDING", status: 409,
        });
      }
      if (noParts && shortagePending) {
        throw Object.assign(new Error("瑞云已确认缺件，不能改为无需配件绕过处理"), { code: "PARTS_SHORTAGE_BYPASS_FORBIDDEN", status: 409 });
      }
      if (noParts && selectedParts.length > 0) {
        throw Object.assign(new Error("本单已有配件，不能再改为无需配件"), { code: "NO_PARTS_CONFLICT", status: 409 });
      }
      if (noParts && !noPartsReason) {
        throw Object.assign(new Error("选择无需配件时必须填写原因"), { code: "NO_PARTS_REASON_REQUIRED", status: 400 });
      }
      if (existing.treatmentMode === "REPAIR" && (!existing.recloudServiceOrderCreatedAt || !existing.recloudServiceOrderNo)) {
        throw Object.assign(new Error("瑞云服务单仍在创建，暂不能进入下一步"), {
          code: "RECLOUD_SERVICE_ORDER_PENDING", status: 409,
        });
      }
      if (!selectedParts.length && !shortagePending && !noParts) {
        throw Object.assign(new Error(quoteOnly ? "请先添加导致用户弃修的故障配件" : diagnosticOnly ? "请先添加检测确认的故障配件" : "请先添加维修配件"), { code: "PART_CONFIRMATION_EMPTY", status: 409 });
      }
      if (diagnosticOnly && existing.diagnosticPartsConfirmedAt) {
        return { order: existing, nextStep: "repairProcess", alreadyConfirmed: true };
      }
      const timestamp = new Date().toISOString();
      const repairPartsComplete = existing.treatmentMode === "REPAIR";
      const verifiedParts = selectedParts.filter((part) => part.recloudVerificationStatus === "AVAILABLE");
      const updated = {
        ...existing,
        status: repairPartsComplete ? "REPAIR_COMPLETION_DRAFT" : existing.status,
        resumeStep: repairPartsComplete ? "repairCompletion" : "repairProcess",
        noPartsDeclaredAt: noParts ? timestamp : existing.noPartsDeclaredAt || null,
        noPartsReason: noParts ? noPartsReason : existing.noPartsReason || "",
        ...(quoteOnly ? { abandonedQuoteConfirmedAt: timestamp } : diagnosticOnly ? { diagnosticPartsConfirmedAt: timestamp } : { partsConfirmedAt: timestamp }),
        ...(repairPartsComplete ? {
          recloudRepairPreparation: {
            ...(existing.recloudRepairPreparation || {}),
            usedParts: noParts ? [] : verifiedParts,
            status: "PENDING",
            requestedAt: timestamp,
            failedAt: "",
            lastError: null,
          },
        } : {}),
        updatedAt: timestamp,
        timeline: [...(existing.timeline || []), timelineEvent(
          quoteOnly ? "ABANDONED_QUOTE_CONFIRMED" : diagnosticOnly ? "DIAGNOSTIC_PARTS_CONFIRMED" : noParts ? "NO_PARTS_CONFIRMED" : "PARTS_CONFIRMED",
          quoteOnly ? "弃修报价配件已确认，进入检测" : diagnosticOnly ? "只检测故障配件已确认，进入检测" : noParts ? `已确认无需配件：${noPartsReason}` : shortagePending ? "瑞云缺件已保留，进入维修完工" : "瑞云配件已确认，进入维修完工",
          operator,
          timestamp
        )],
      };
      await this.writeAll(records.map((record) => record.rmaNo === rmaNo ? updated : record));
      return { order: updated, nextStep: repairPartsComplete ? "repairCompletion" : "repairProcess" };
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
      const partsPending = input.partsPending === true;
      const updated = {
        ...existing,
        status: partsPending ? "INSPECTION_COMPLETED_PENDING_REPAIR" : "REPAIR_COMPLETION_DRAFT",
        resumeStep: partsPending ? "partsApplication" : "repairCompletion",
        recloudServiceOrderSyncStatus: input.recloudSynced === true
          ? "CONFIRMED"
          : normalizeRequired(input.recloudSyncStatus) || existing.recloudServiceOrderSyncStatus || "NOT_STARTED",
        recloudServiceOrderLastError: null,
        recloudServiceOrderCreatedAt: input.recloudSynced === true ? timestamp : existing.recloudServiceOrderCreatedAt || "",
        recloudRepairPreparation: input.repairPreparation
          ? { ...input.repairPreparation, status: input.recloudSynced === true ? "CONFIRMED" : "WAITING_PART_VERIFICATION" }
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

  async markRecloudServiceOrderConfirmed(rmaNo, operator = {}, input = {}) {
    const operation = this.writeQueue.then(async () => {
      const records = await this.readAll();
      const existing = records.find((record) => record.rmaNo === rmaNo);
      if (!existing) throw Object.assign(new Error("未找到待维修工单"), { code: "RECEIPT_PREPARATION_NOT_FOUND", status: 404 });
      if (existing.recloudServiceOrderCreatedAt) return existing;
      const timestamp = new Date().toISOString();
      const updated = {
        ...existing,
        recloudServiceOrderNo:
          normalizeRequired(input.serviceOrderNo)
          || normalizeRequired(existing.recloudServiceOrderNo),
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
      if (
        !existing ||
        existing.recloudServiceOrderCreatedAt ||
        existing.recloudServiceOrderSyncStatus === "RESULT_UNKNOWN"
      ) return existing;
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

  async reconcileRecloudServiceOrderNotCreated(rmaNo, operator = {}) {
    const operation = this.writeQueue.then(async () => {
      const records = await this.readAll();
      const existing = records.find((record) => record.rmaNo === rmaNo);
      if (!existing) throw Object.assign(new Error("未找到待维修工单"), { code: "RECEIPT_PREPARATION_NOT_FOUND", status: 404 });
      if (existing.recloudServiceOrderCreatedAt) {
        throw Object.assign(new Error("瑞云维修服务单已经创建，不能按未创建恢复"), {
          code: "RECLOUD_SERVICE_ORDER_ALREADY_CREATED",
          status: 409,
        });
      }
      const timestamp = new Date().toISOString();
      const updated = {
        ...existing,
        recloudServiceOrderSyncStatus: "FAILED",
        recloudServiceOrderLastError: {
          code: "RECLOUD_SERVICE_ORDER_RECONCILED_NOT_CREATED",
          message: "管理员已核对瑞云维修单号为空，可安全重新创建",
          at: timestamp,
        },
        updatedAt: timestamp,
        timeline: [
          ...(existing.timeline || []),
          timelineEvent("RECLOUD_SERVICE_ORDER_NOT_CREATED_CONFIRMED", "管理员已核对瑞云维修服务单未创建", operator, timestamp),
        ],
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
      const missingParts = (Array.isArray(input.missingParts) ? input.missingParts : [])
        .map((part) => ({
          partCode: normalizeRequired(part?.partCode),
          partName: normalizeRequired(part?.partName),
          quantity: Number(part?.quantity || 0),
          reason: normalizeRequired(part?.reason) || "瑞云库存不足",
        }))
        .filter((part) => part.partCode && part.quantity > 0);
      const existingMissingParts = existing.partsShortage?.status === "PENDING_INFORMATION"
        ? (existing.partsShortage.parts || [])
        : [];
      const mergedMissingParts = [...existingMissingParts, ...missingParts].reduce((items, part) => {
        const code = normalizeRequired(part?.partCode).toUpperCase();
        if (!code) return items;
        return [...items.filter((item) => normalizeRequired(item.partCode).toUpperCase() !== code), part];
      }, []);
      const hasShortage = mergedMissingParts.length > 0;
      const missingCodes = new Set(mergedMissingParts.map((part) => normalizeRequired(part.partCode).toUpperCase()));
      const updated = {
        ...existing,
        partApplications: (existing.partApplications || []).map((part) => {
          const code = normalizeRequired(part.partCode).toUpperCase();
          if (part.recloudVerificationStatus !== "AVAILABLE" || missingCodes.has(code)) return part;
          return {
            ...part,
            status: "RECLOUD_PART_CONFIRMED",
            recloudConfirmedAt: part.recloudConfirmedAt || timestamp,
            recloudSource: "SERVICE_ORDER",
            updatedAt: timestamp,
          };
        }),
        recloudRepairPreparation: {
          ...(existing.recloudRepairPreparation || {}),
          assignee:
            normalizeRequired(input.assignee)
            || normalizeRequired(existing.recloudRepairPreparation?.assignee),
          assignmentSource:
            normalizeRequired(input.assignmentSource)
            || normalizeRequired(existing.recloudRepairPreparation?.assignmentSource),
          warrantyConfirmationVersion: Number(input.warrantyConfirmationVersion || 0),
          status: hasShortage ? "PARTS_SHORTAGE" : "CONFIRMED",
          completedAt: timestamp,
          completedSteps: Array.isArray(input.completedSteps) ? input.completedSteps : [],
          missingParts: mergedMissingParts,
          failedAt: "",
          lastError: null,
        },
        partsShortage: hasShortage ? {
          status: "PENDING_INFORMATION",
          parts: mergedMissingParts,
          detectedAt: existing.partsShortage?.detectedAt || timestamp,
          updatedAt: timestamp,
          resolvedAt: "",
          resolvedBy: null,
        } : existing.partsShortage || null,
        updatedAt: timestamp,
        timeline: [
          ...(existing.timeline || []),
          timelineEvent(
            hasShortage ? "RECLOUD_PARTS_SHORTAGE" : "RECLOUD_REPAIR_PREPARATION_CONFIRMED",
            hasShortage
              ? `瑞云库存缺件：${mergedMissingParts.map((part) => `${part.partName || part.partCode}×${part.quantity}`).join("、")}`
              : "瑞云已完成改派、保外转保内确认和配件添加",
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

  async markPartsShortagePending(rmaNo, missingParts = [], operator = {}) {
    return this.markRecloudRepairPreparationConfirmed(rmaNo, {
      missingParts,
      completedSteps: ["PARTS_SHORTAGE_RECORDED", "COMPLETE_CLICKED", "SUBMIT_SKIPPED_FOR_PARTS_SHORTAGE"],
    }, operator);
  }

  async recordRecloudPartShortage(rmaNo, missingPart = {}, operator = {}) {
    const records = await this.readAll();
    const existing = records.find((record) => record.rmaNo === rmaNo);
    if (!existing) throw Object.assign(new Error("未找到待维修工单"), { code: "RECEIPT_PREPARATION_NOT_FOUND", status: 404 });
    const current = existing.partsShortage?.status === "PENDING_INFORMATION"
      ? existing.partsShortage.parts || []
      : [];
    const code = normalizeRequired(missingPart.partCode).toUpperCase();
    const merged = [
      ...current.filter((part) => normalizeRequired(part.partCode).toUpperCase() !== code),
      missingPart,
    ];
    return this.markRecloudRepairPreparationConfirmed(rmaNo, {
      assignee: existing.recloudRepairPreparation?.assignee,
      assignmentSource: existing.recloudRepairPreparation?.assignmentSource,
      warrantyConfirmationVersion: existing.recloudRepairPreparation?.warrantyConfirmationVersion || 2,
      missingParts: merged,
      completedSteps: [
        ...(existing.recloudRepairPreparation?.completedSteps || []).filter((step) => step !== "PARTS_VERIFIED"),
        "PARTS_SHORTAGE_RECORDED",
      ],
    }, operator);
  }

  async resolveRecloudPartShortageWithReplacement(rmaNo, sourcePartCode, replacementPart, operator = {}) {
    const operation = this.writeQueue.then(async () => {
      const records = await this.readAll();
      const existing = records.find((record) => record.rmaNo === rmaNo);
      if (!existing) throw Object.assign(new Error("未找到缺件工单"), { code: "RECEIPT_PREPARATION_NOT_FOUND", status: 404 });
      if (existing.partsShortage?.status !== "PENDING_INFORMATION") return existing;
      const sourceCode = normalizeRequired(sourcePartCode).toUpperCase();
      if (!sourceCode) return existing;
      const remaining = (existing.partsShortage.parts || []).filter(
        (part) => normalizeRequired(part.partCode).toUpperCase() !== sourceCode
      );
      if (remaining.length === (existing.partsShortage.parts || []).length) return existing;
      const timestamp = new Date().toISOString();
      const resolved = remaining.length === 0;
      const updated = {
        ...existing,
        partsShortage: {
          ...existing.partsShortage,
          status: resolved ? "RESOLVED" : "PENDING_INFORMATION",
          parts: remaining,
          updatedAt: timestamp,
          resolvedAt: resolved ? timestamp : "",
          resolvedBy: resolved ? {
            userId: normalizeRequired(operator.userId),
            displayName: normalizeRequired(operator.displayName),
          } : null,
        },
        recloudRepairPreparation: {
          ...(existing.recloudRepairPreparation || {}),
          status: resolved
            ? existing.partsConfirmedAt ? "CONFIRMED" : "WAITING_PART_VERIFICATION"
            : "PARTS_SHORTAGE",
          missingParts: remaining,
          completedSteps: resolved
            ? [...new Set([...(existing.recloudRepairPreparation?.completedSteps || []), "PARTS_VERIFIED_BY_REPLACEMENT"])]
            : existing.recloudRepairPreparation?.completedSteps || [],
        },
        updatedAt: timestamp,
        timeline: [...(existing.timeline || []), timelineEvent(
          "RECLOUD_PART_SHORTAGE_REPLACED",
          `缺件 ${sourceCode} 已由瑞云可用配件 ${normalizeRequired(replacementPart?.partCode)} 替代`,
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

  async markRecloudPartVerification(rmaNo, applicationId, input = {}, operator = {}) {
    const operation = this.writeQueue.then(async () => {
      const records = await this.readAll();
      const existing = records.find((record) => record.rmaNo === rmaNo);
      if (!existing) throw Object.assign(new Error("未找到待维修工单"), { code: "RECEIPT_PREPARATION_NOT_FOUND", status: 404 });
      const current = (existing.partApplications || []).find((part) => part.id === applicationId);
      if (!current) throw Object.assign(new Error("未找到待核实配件"), { code: "PART_APPLICATION_NOT_FOUND", status: 404 });
      const timestamp = new Date().toISOString();
      const status = normalizeRequired(input.status) || "FAILED";
      const verifiedCode = normalizeRequired(input.partCode).toUpperCase();
      const verifiedName = normalizeRequired(input.partName);
      const verifiedRetailPrice = input.retailPrice === null || input.retailPrice === undefined || input.retailPrice === ""
        ? null
        : Number(input.retailPrice);
      const options = (Array.isArray(input.options) ? input.options : []).map((item) => ({
        code: normalizeRequired(item?.code).toUpperCase(),
        name: normalizeRequired(item?.name),
      })).filter((item) => item.code);
      const partApplications = (existing.partApplications || []).map((part) => part.id !== applicationId ? part : {
        ...part,
        partCode: verifiedCode || part.partCode,
        partName: verifiedName || part.partName,
        retailPrice: Number.isFinite(verifiedRetailPrice) && verifiedRetailPrice >= 0
          ? verifiedRetailPrice
          : part.retailPrice,
        metadataSource: normalizeRequired(input.metadataSource) || part.metadataSource,
        verificationQuery: normalizeRequired(input.verificationQuery) || part.verificationQuery,
        status: status === "AVAILABLE"
          ? "RECLOUD_PART_AVAILABLE"
          : status === "OUT_OF_STOCK"
            ? "RECLOUD_PART_OUT_OF_STOCK"
            : status === "NEEDS_SELECTION"
              ? "RECLOUD_PART_NEEDS_SELECTION"
              : status === "VERIFYING"
                ? "RECLOUD_PART_VERIFYING"
                : status === "PENDING" ? "RECLOUD_PART_VERIFY_PENDING" : "RECLOUD_PART_VERIFY_FAILED",
        recloudVerificationStatus: status,
        recloudVerificationOptions: options,
        recloudVerificationError: input.error ? {
          code: normalizeRequired(input.error.code) || "RECLOUD_PART_VERIFY_FAILED",
          message: normalizeRequired(input.error.message) || "瑞云配件核实失败，后台将自动重试",
          at: timestamp,
        } : null,
        recloudVerifiedAt: ["AVAILABLE", "OUT_OF_STOCK", "NEEDS_SELECTION"].includes(status) ? timestamp : part.recloudVerifiedAt || "",
        updatedAt: timestamp,
      });
      let partsShortage = existing.partsShortage || null;
      if (status === "OUT_OF_STOCK") {
        const missing = {
          partCode: verifiedCode || current.partCode,
          partName: verifiedName || current.partName,
          quantity: Number(current.quantity || 1),
          reason: normalizeRequired(input.reason) || "瑞云配件窗口明确显示无可用结果",
          applicationId,
        };
        const prior = partsShortage?.status === "PENDING_INFORMATION" ? partsShortage.parts || [] : [];
        partsShortage = {
          status: "PENDING_INFORMATION",
          parts: [...prior.filter((part) => part.applicationId !== applicationId), missing],
          detectedAt: partsShortage?.detectedAt || timestamp,
          updatedAt: timestamp,
          resolvedAt: "",
          resolvedBy: null,
        };
      }
      const updated = {
        ...existing,
        partApplications,
        partsShortage,
        updatedAt: timestamp,
        timeline: [...(existing.timeline || []), timelineEvent(
          status === "AVAILABLE" ? "RECLOUD_PART_AVAILABLE" : status === "OUT_OF_STOCK" ? "RECLOUD_PART_OUT_OF_STOCK" : "RECLOUD_PART_VERIFICATION_UPDATED",
          status === "AVAILABLE" ? `瑞云已核实配件可用：${verifiedName || verifiedCode}` : status === "OUT_OF_STOCK" ? `瑞云已核实配件缺件：${verifiedName || verifiedCode}` : "瑞云配件核实状态已更新",
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

  async enrichRecloudPartApplication(rmaNo, applicationId, metadata = {}) {
    const operation = this.writeQueue.then(async () => {
      const records = await this.readAll();
      const existing = records.find((record) => record.rmaNo === rmaNo);
      if (!existing) return null;
      const timestamp = new Date().toISOString();
      const partApplications = (existing.partApplications || []).map((part) => {
        if (part.id !== applicationId) return part;
        const hasAuthoritativeRecloudPrice = part.metadataSource === "RECLOUD_SERVICE_ORDER"
          && part.retailPrice !== null && part.retailPrice !== undefined && part.retailPrice !== ""
          && Number.isFinite(Number(part.retailPrice));
        const price = hasAuthoritativeRecloudPrice
          ? Number(part.retailPrice)
          : metadata.retailPrice === null || metadata.retailPrice === undefined || metadata.retailPrice === ""
            ? part.retailPrice
            : Number(metadata.retailPrice);
        return {
          ...part,
          retailPrice: Number.isFinite(price) && price >= 0 ? price : part.retailPrice,
          repairLevel: normalizeRequired(metadata.repairLevel) || part.repairLevel,
          returnRequired: metadata.returnRequired === undefined ? part.returnRequired : Boolean(metadata.returnRequired),
          projectCode: normalizeRequired(metadata.projectCode) || part.projectCode,
          metadataSource: hasAuthoritativeRecloudPrice ? "RECLOUD_SERVICE_ORDER" : "FEISHU_OPTIONAL",
          updatedAt: timestamp,
        };
      });
      const updated = { ...existing, partApplications, updatedAt: timestamp };
      await this.writeAll(records.map((record) => record.rmaNo === rmaNo ? updated : record));
      return updated;
    });
    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  async resolvePartsShortage(rmaNo, operator = {}) {
    const operation = this.writeQueue.then(async () => {
      const records = await this.readAll();
      const existing = records.find((record) => record.rmaNo === rmaNo);
      if (!existing) throw Object.assign(new Error("未找到缺件工单"), { code: "RECEIPT_PREPARATION_NOT_FOUND", status: 404 });
      if (!existing.partsShortage || existing.partsShortage.status === "RESOLVED") return existing;
      const timestamp = new Date().toISOString();
      const updated = {
        ...existing,
        partsShortage: {
          ...existing.partsShortage,
          status: "RESOLVED",
          resolvedAt: timestamp,
          updatedAt: timestamp,
          resolvedBy: {
            userId: normalizeRequired(operator.userId),
            displayName: normalizeRequired(operator.displayName),
          },
        },
        updatedAt: timestamp,
        timeline: [...(existing.timeline || []), timelineEvent("RECLOUD_PARTS_SHORTAGE_RESOLVED", "信息员已在瑞云补件并提交", operator, timestamp)],
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
        if (existing.treatmentMode === "INSPECTION_ONLY" && !(Array.isArray(input.attachments) && input.attachments.some((item) =>
          /^(image|video)\//.test(item?.mimeType || "") && item?.source !== "INSPECTION_REPORT"
        ))) {
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
          discountEnabled: input.discountEnabled === true,
          discountScope: normalizeRequired(input.discountScope) || "ORDER_TOTAL",
          discountRate: Number(input.discountRate) || 10,
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

  async updateRepairCompletionPricing(rmaNo, pricing = {}, operator = {}) {
    const operation = this.writeQueue.then(async () => {
      const records = await this.readAll();
      const existing = records.find((record) => record.rmaNo === rmaNo);
      if (!existing?.repairCompletion?.submittedAt) {
        throw Object.assign(new Error("只有已提交的维修完工单可以更正费用备注"), {
          code: "REPAIR_PRICING_CORRECTION_NOT_ALLOWED", status: 409,
        });
      }
      if (existing.repairCompletion.responsibilityType !== "保外维修") {
        throw Object.assign(new Error("只有保外维修单需要同步费用备注"), {
          code: "REPAIR_PRICING_CORRECTION_NOT_REQUIRED", status: 409,
        });
      }
      const timestamp = new Date().toISOString();
      const updated = {
        ...existing,
        repairCompletion: {
          ...existing.repairCompletion,
          logisticsChargeMode: pricing.logisticsChargeMode,
          oneWayLogisticsFee: pricing.oneWayLogisticsFee,
          logisticsFee: pricing.logisticsFee,
          discountEnabled: pricing.discountEnabled,
          discountScope: pricing.discountScope,
          discountRate: pricing.discountRate,
          primaryRemark: normalizeRequired(pricing.primaryRemark),
          secondaryRemark: normalizeRequired(pricing.secondaryRemark),
          pricing: { ...(existing.repairCompletion.pricing || {}), ...pricing },
          savedAt: timestamp,
        },
        updatedAt: timestamp,
        timeline: [...(existing.timeline || []), timelineEvent("REPAIR_PRICING_CORRECTED", "保外费用备注已按规则更正", operator, timestamp)],
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
      if (record.partsShortage?.status === "PENDING_INFORMATION") return false;
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

  async reopenReceiptForSnCorrection(rmaNo, operator = {}) {
    const operation = this.writeQueue.then(async () => {
      const records = await this.readAll();
      const existing = records.find((record) => record.rmaNo === rmaNo);
      if (!existing) {
        throw Object.assign(new Error("未找到需要更正 SN 的签收工单"), {
          code: "RECEIPT_PREPARATION_NOT_FOUND", status: 404,
        });
      }
      const role = normalizeRequired(operator.role).toUpperCase();
      const assignedUserId = existing.technicianId || existing.operatorId;
      if (role !== "ADMIN" && assignedUserId !== normalizeRequired(operator.userId)) {
        throw Object.assign(new Error("只能恢复本人负责的签收工单"), {
          code: "RECEIPT_SN_CORRECTION_FORBIDDEN", status: 403,
        });
      }
      if (["REPAIR_COMPLETED_PENDING_SHIPMENT", "SHIPPED_PENDING_COMPLETION", "COMPLETED"].includes(existing.status)
        || existing.returnShipment?.shippedAt) {
        throw Object.assign(new Error("工单已完工或返件，不能恢复签收 SN"), {
          code: "RECEIPT_SN_CORRECTION_LOCKED", status: 409,
        });
      }
      const timestamp = new Date().toISOString();
      const correctionRecord = {
        reopenedAt: timestamp,
        reopenedById: normalizeRequired(operator.userId),
        reopenedByName: normalizeRequired(operator.displayName) || "系统管理员",
        previousSn: existing.sn || "",
        previousStatus: existing.status || "",
      };
      const updated = {
        ...existing,
        sn: "",
        status: "RECEIPT_PREPARED",
        resumeStep: "",
        receiptCompletedAt: null,
        modelAuthorization: null,
        technicianWarranty: "",
        warrantyDecision: null,
        warrantyOverridden: false,
        warrantyConfirmedAt: null,
        manufacturerWarrantyConversion: {
          requested: false, approved: false, approvalNo: "", status: "NOT_REQUIRED", proofAttachments: [],
        },
        treatmentMode: "",
        treatmentLabel: "",
        treatmentDecidedAt: null,
        skipsParts: false,
        partApplications: [],
        abandonedQuoteParts: [],
        diagnosticParts: [],
        diagnosticPartsConfirmedAt: null,
        partsConfirmedAt: null,
        inspectionResult: "",
        inspectionRemark: "",
        faultCategory: "",
        faultContent: "",
        detectionResult: "",
        inspectionUpdatedAt: null,
        customerReasonConsistent: "",
        inspectionAbnormal: "",
        productFunctionDecision: "",
        originalConsumables: "",
        consumableName: "",
        dismantled: "",
        repairCompletion: null,
        hold: null,
        recloudProjectVerificationStatus: "NOT_STARTED",
        recloudProjectVerificationAttemptedAt: "",
        recloudProjectVerificationConfirmedAt: "",
        recloudVerifiedProjectCode: "",
        recloudProjectVerificationLastError: null,
        recloudReceiptAttachmentSyncStatus: existing.receiptAttachments?.length ? "PENDING" : "NOT_STARTED",
        recloudReceiptAttachmentAttemptedAt: "",
        recloudReceiptAttachmentConfirmedAt: "",
        recloudReceiptAttachmentResult: null,
        recloudReceiptAttachmentLastError: null,
        recloudDetectionSyncStatus: "NOT_STARTED",
        recloudDetectionAttemptedAt: "",
        recloudDetectionConfirmedAt: "",
        recloudDetectionLastError: null,
        recloudServiceOrderSyncStatus: "NOT_STARTED",
        recloudServiceOrderAttemptedAt: "",
        recloudServiceOrderCreatedAt: "",
        recloudServiceOrderNo: "",
        recloudServiceOrderLastError: null,
        recloudRepairPreparation: null,
        repairStartedAt: null,
        snCorrectionRequiredAt: timestamp,
        snCorrectionHistory: [...(existing.snCorrectionHistory || []), correctionRecord],
        updatedAt: timestamp,
        timeline: [
          ...(existing.timeline || []),
          timelineEvent("RECEIPT_SN_CORRECTION_REOPENED", "SN 录入有误，已恢复到签收步骤", operator, timestamp),
        ],
      };
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
        hold: null,
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
      if (existing.partsShortage?.status === "PENDING_INFORMATION") {
        throw Object.assign(new Error("瑞云缺件尚未由信息员补录并提交，不能进入返件发货"), { code: "PARTS_SHORTAGE_PENDING", status: 409 });
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
