const COMPLETED_WORKFLOW_STATUSES = new Set([
  "REPAIR_COMPLETED_PENDING_SHIPMENT",
  "SHIPPED_PENDING_COMPLETION",
  "COMPLETED",
])

const MATERIAL_HOLD_REASONS = new Set(["网点缺件", "总部缺件"])

export function isCompletedWorkflow(order = {}) {
  return Boolean(order.repairCompletion?.submittedAt) || COMPLETED_WORKFLOW_STATUSES.has(order.status)
}

export function isMaterialHold(order = {}) {
  return order.status === "ON_HOLD" && MATERIAL_HOLD_REASONS.has(order.hold?.reason)
}

export function isOutOfWarrantyHold(order = {}) {
  return order.status === "ON_HOLD"
    && order.hold?.category === "保外"
    && !MATERIAL_HOLD_REASONS.has(order.hold?.reason)
}

export function categorizeTechnicianWorkflows(workflows = []) {
  const rows = Array.isArray(workflows) ? workflows : []
  const completed = rows.filter(isCompletedWorkflow)
  const unfinished = rows.filter((order) => order.receiptCompletedAt && !isCompletedWorkflow(order))
  const waitingMaterial = unfinished.filter(isMaterialHold)
  const outOfWarranty = unfinished.filter(isOutOfWarrantyHold)
  const otherHeld = unfinished.filter((order) => (
    order.status === "ON_HOLD"
    && !isMaterialHold(order)
    && !isOutOfWarrantyHold(order)
  ))
  return { unfinished, waitingMaterial, outOfWarranty, otherHeld, completed }
}

export function technicianWorkloadStatusLabel(order = {}) {
  if (isCompletedWorkflow(order)) return "维修已完成"
  if (isMaterialHold(order)) return "待料"
  if (isOutOfWarrantyHold(order)) return "保外暂存"
  if (order.status === "ON_HOLD") return "暂存"
  return "维修中"
}
