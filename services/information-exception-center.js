const CLOSED_STATUSES = new Set(["COMPLETED", "TRANSFERRED_TO_HEADQUARTERS", "CANCELLED"]);
const COMPLETION_STATUSES = new Set(["REPAIR_COMPLETED_PENDING_SHIPMENT", "SHIPPED_PENDING_COMPLETION", "COMPLETED"]);
const ACTIONABLE_SYNC_STATUSES = new Set(["FAILED", "MANUAL_REVIEW", "READY_DRY_RUN", "AWAITING_FINAL_CONFIRM"]);

function normalizedParts(parts) {
  return (parts || []).map((part) => `${part.partCode || part.partName || ""}:${Number(part.quantity) || 0}`).sort();
}

function partsMismatch(order) {
  const applied = normalizedParts(order.partApplications);
  const completed = normalizedParts(order.repairCompletion?.usedParts);
  return applied.length > 0 && completed.length > 0 && JSON.stringify(applied) !== JSON.stringify(completed);
}

function baseException(order, type, severity, message) {
  return {
    id: `${type}:${order.rmaNo}`,
    type,
    severity,
    rmaNo: order.rmaNo,
    logisticsNo: order.logisticsNo,
    status: order.status,
    technicianName: order.technicianName || order.repairCompletion?.operatorName || order.operatorName || "未分配",
    message,
    updatedAt: order.updatedAt || order.createdAt || "",
  };
}

function detectOrderExceptions(order, options = {}) {
  const now = Number(options.now || Date.now());
  const stalledAfterMs = Number(options.stalledAfterMs || 24 * 60 * 60 * 1000);
  const missingAttachmentIds = new Set(options.missingAttachmentIds || []);
  const exceptions = [];
  if (order.partsShortage?.status === "PENDING_INFORMATION") {
    const missingParts = Array.isArray(order.partsShortage.parts) ? order.partsShortage.parts : [];
    const summary = missingParts.map((part) => `${part.partName || part.partCode}（${part.partCode}）×${Number(part.quantity || 0)}`).join("、");
    exceptions.push({
      ...baseException(order, "PARTS_SHORTAGE_PENDING", "HIGH", `瑞云库存缺件，已完工但未提交：${summary || "配件明细待确认"}`),
      missingParts,
      detectedAt: order.partsShortage.detectedAt || order.updatedAt || "",
    });
  }
  if (order.recloudReceiptSyncStatus === "RESULT_UNKNOWN") {
    exceptions.push(baseException(
      order,
      "RECLOUD_RECEIPT_RESULT_UNKNOWN",
      "HIGH",
      "瑞云签收确认已触发但结果未知，请人工核对后再继续"
    ));
  }
  const signed = Boolean(order.receiptCompletedAt) || !["RECEIPT_PREPARED", "TRANSFER_TO_HEADQUARTERS_PENDING"].includes(order.status);
  if (signed && !(order.technicianId || order.operatorId)) {
    exceptions.push(baseException(order, "UNASSIGNED_TECHNICIAN", "HIGH", "机器已签收但尚未分配负责师傅"));
  }
  const updatedAt = Date.parse(order.updatedAt || order.createdAt || "");
  if (!CLOSED_STATUSES.has(order.status) && Number.isFinite(updatedAt) && now - updatedAt > stalledAfterMs) {
    exceptions.push(baseException(order, "WORKFLOW_STALLED", "MEDIUM", "工单超过24小时没有流程更新"));
  }
  if (COMPLETION_STATUSES.has(order.status)) {
    const completion = order.repairCompletion || {};
    const missing = [
      !completion.faultLevel1 && "一级故障", !completion.faultLevel2 && "二级故障", !completion.faultLevel3 && "三级故障",
      !completion.repairMeasure && "维修措施", !completion.operatorName && "完工师傅",
    ].filter(Boolean);
    if (missing.length) exceptions.push(baseException(order, "REPORT_INCOMPLETE", "HIGH", `维修报告缺少：${missing.join("、")}`));
    if (!(completion.attachments || []).length) exceptions.push(baseException(order, "COMPLETION_MEDIA_MISSING", "HIGH", "维修完工报告没有照片或视频"));
    if (partsMismatch(order)) exceptions.push(baseException(order, "PARTS_MISMATCH", "HIGH", "配件申请记录与完工报告中的实际用件不一致"));
  }
  if (missingAttachmentIds.size) {
    exceptions.push(baseException(order, "ATTACHMENT_FILE_MISSING", "HIGH", `有${missingAttachmentIds.size}个附件文件无法读取`));
  }
  if (order.status === "SHIPPED_PENDING_COMPLETION") {
    exceptions.push(baseException(order, "SHIPPED_NOT_COMPLETED", "MEDIUM", "机器已经返件发货，但工单尚未由管理员完结"));
  }
  return exceptions;
}

function detectSyncExceptions(tasks) {
  return (tasks || []).filter((task) => ACTIONABLE_SYNC_STATUSES.has(task.status)).map((task) => ({
    id: `SYNC:${task.id}`,
    type: "SYNC_ATTENTION_REQUIRED",
    severity: ["FAILED", "MANUAL_REVIEW"].includes(task.status) ? "HIGH" : "MEDIUM",
    rmaNo: task.rmaNo,
    logisticsNo: "",
    status: task.status,
    technicianName: "",
    message: task.status === "FAILED" ? "瑞云同步执行失败，需要管理员处理"
      : task.status === "MANUAL_REVIEW" ? "瑞云同步需要管理员人工复核"
        : task.status === "AWAITING_FINAL_CONFIRM" ? "瑞云资料已核对，正在等待最终确认"
          : "瑞云同步演练已经就绪，等待后续处理",
    updatedAt: task.updatedAt || task.createdAt || "",
  }));
}

function sortExceptions(items) {
  const severityOrder = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  return [...items].sort((left, right) => (severityOrder[left.severity] ?? 9) - (severityOrder[right.severity] ?? 9)
    || String(right.updatedAt).localeCompare(String(left.updatedAt)));
}

module.exports = { ACTIONABLE_SYNC_STATUSES, detectOrderExceptions, detectSyncExceptions, partsMismatch, sortExceptions };
