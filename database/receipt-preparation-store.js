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
    customerName: normalizeRequired(input.customerName),
    regionAddress: normalizeRequired(input.regionAddress),
    reportedFault: normalizeRequired(input.reportedFault),
    manufacturerWarrantyConversion: existing?.manufacturerWarrantyConversion || {
      approved: false,
      approvalNo: "",
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
      if (!(existing.receiptAttachments || []).length) {
        const error = new Error("请先拍摄并上传至少一张签收照片");
        error.code = "RECEIPT_ATTACHMENT_REQUIRED";
        error.status = 409;
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
      if (treatmentMode === "ABANDONED" && technicianWarranty !== "保外") {
        throw Object.assign(new Error("弃修仅适用于保外机器；保内机器无需付费，不能选择弃修"), { code: "IN_WARRANTY_ABANDONMENT_NOT_ALLOWED", status: 409 });
      }
      const skipsParts = treatmentMode !== "REPAIR";
      const timestamp = new Date().toISOString();
      const updated = {
        ...existing,
        treatmentMode,
        treatmentLabel: labels[treatmentMode],
        skipsParts,
        status: skipsParts ? "INSPECTION_COMPLETED_PENDING_REPAIR" : "RECEIVED_PENDING_INSPECTION",
        inspectionResult: normalizeRequired(input.detectionResult),
        detectionResult: normalizeRequired(input.detectionResult),
        technicianWarranty,
        warrantyDecision: input.warrantyDecision || existing.warrantyDecision || null,
        treatmentDecidedAt: timestamp,
        inspectionUpdatedAt: skipsParts ? timestamp : existing.inspectionUpdatedAt,
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
      const updated = {
        ...existing,
        status: "INSPECTION_COMPLETED_PENDING_REPAIR",
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
      const existingApplication = (existing.partApplications || []).find((item) => item.partCode === part.code);
      const application = existingApplication ? {
        ...existingApplication,
        partName: normalizeRequired(part.name),
        quantity: existingApplication.quantity + requestedQuantity,
        retailPrice: Number.isFinite(normalizedRetailPrice) && normalizedRetailPrice >= 0 ? normalizedRetailPrice : null,
        repairLevel: normalizeRequired(part.repairLevel),
        returnRequired: Boolean(part.returnRequired),
        updatedAt: timestamp,
      } : {
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
        partApplications: existingApplication
          ? (existing.partApplications || []).map((item) => item.id === application.id ? application : item)
          : [...(Array.isArray(existing.partApplications) ? existing.partApplications : []), application],
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
      const inspectionComplete = ["INSPECTION_COMPLETED_PENDING_REPAIR", "REPAIR_COMPLETION_DRAFT"].includes(existing.status);
      const updated = {
        ...existing,
        status: inspectionComplete ? "REPAIR_COMPLETION_DRAFT" : existing.status,
        updatedAt: timestamp,
        timeline: [...(existing.timeline || []), timelineEvent("PARTS_CONFIRMED", "维修配件已确认，进入维修完工", operator, timestamp)],
      };
      await this.writeAll(records.map((record) => record.rmaNo === rmaNo ? updated : record));
      return { order: updated, nextStep: inspectionComplete ? "repairCompletion" : "repairProcess" };
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
